import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import {
  type CostProfile,
  type Finding,
  type ManifestAuth,
  type ResourceDefinition,
  createManifest,
  serializeManifest,
  validateResourceRegistry,
} from "@jawstack/core";

export const packageName = "@jawstack/cli";

export const defaultConfigFiles = [
  "jawstack.config.ts",
  "jawstack.config.mts",
  "jawstack.config.js",
  "jawstack.config.mjs",
] as const;

export type JawStackConfig = Readonly<{
  appName: string;
  stage?: string;
  resources: readonly ResourceDefinition[];
  auth: Partial<ManifestAuth>;
  costProfile: CostProfile;
  aws?: Readonly<{
    region?: string;
    profile?: string;
  }>;
}>;

export type CliResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type RunCliOptions = Readonly<{
  cwd?: string;
}>;

type ParsedArgs = Readonly<{
  command: string | undefined;
  help: boolean;
  configPath?: string;
  stage?: string;
  stable: boolean;
  json: boolean;
  strict: boolean;
  deploy: boolean;
}>;

type LoadedConfig = Readonly<{
  path: string;
  config: JawStackConfig;
}>;

type DoctorContext = Readonly<{
  config: JawStackConfig;
  configPath: string;
  stage: string;
  deploy: boolean;
}>;

class CliError extends Error {
  readonly exitCode: number;
  readonly finding: Finding;

  constructor(exitCode: number, finding: Finding) {
    super(finding.message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.finding = finding;
  }
}

export function defineJawStackApp<const TConfig extends JawStackConfig>(config: TConfig): TConfig {
  return config;
}

export function describePackage(): string {
  return `${packageName} command line interface`;
}

export function getHelpText(): string {
  return `jawstack

Usage:
  jawstack <command> [options]

Commands:
  doctor      Validate the local JawStack configuration
  manifest    Print the safe application manifest as JSON
  deploy      Placeholder for AWS deployment
  smoke       Placeholder for smoke tests
  destroy     Placeholder for AWS teardown

Options:
  --config <path>  Load a specific config file
  --stage <stage>  Override the config stage
  --json           Print machine-readable output where supported
  --stable         Omit generated timestamps where supported
  --strict         Treat warnings as blocking findings
  --help           Show help`;
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  options: RunCliOptions = {},
): Promise<CliResult> {
  const cwd = options.cwd ?? process.cwd();
  let parsed: ParsedArgs | undefined;

  try {
    parsed = parseArgs(argv);

    if (parsed.help || parsed.command === undefined) {
      return ok(`${getHelpText()}\n`);
    }

    switch (parsed.command) {
      case "doctor":
        return await runDoctor(parsed, cwd);
      case "manifest":
        return await runManifest(parsed, cwd);
      case "deploy":
      case "smoke":
      case "destroy":
        return ok(`${parsed.command} is not implemented in this MVP phase yet.\n`);
      default:
        throw new CliError(
          2,
          cliFinding({
            id: "cli.command.unknown",
            title: "Unknown command",
            message: `Unknown command "${parsed.command}".`,
            fix: "Run jawstack --help to see available commands.",
          }),
        );
    }
  } catch (error) {
    if (error instanceof CliError) {
      const wantsJson = parsed?.json ?? argv.includes("--json");

      return {
        exitCode: error.exitCode,
        stdout: "",
        stderr: wantsJson
          ? `${renderFindingsJson([error.finding])}\n`
          : `${renderFindingsHuman([error.finding])}\n`,
      };
    }

    return {
      exitCode: 2,
      stdout: "",
      stderr: `${renderFindingsHuman([
        cliFinding({
          id: "config.invalid",
          title: "Invalid config",
          message: error instanceof Error ? error.message : "Config loading failed.",
        }),
      ])}\n`,
    };
  }
}

export async function loadJawStackConfig(input: {
  readonly cwd?: string;
  readonly configPath?: string;
}): Promise<LoadedConfig> {
  const cwd = input.cwd ?? process.cwd();
  const configPath = await resolveConfigPath(cwd, input.configPath);
  const moduleNamespace = await importConfigModule(configPath);
  const config = normalizeConfig(moduleNamespace, configPath);

  return {
    path: configPath,
    config,
  };
}

export function renderFindingsHuman(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return "No findings.";
  }

  return findings
    .map((finding) => {
      const location = renderFindingLocation(finding);
      const lines = [
        `${finding.severity.toUpperCase()} ${finding.id}: ${finding.title}`,
        finding.message,
        ...(location === undefined ? [] : [`Location: ${location}`]),
        ...(finding.impact === undefined ? [] : [`Impact: ${finding.impact}`]),
        ...(finding.fix === undefined ? [] : [`Fix: ${finding.fix}`]),
      ];

      return lines.join("\n");
    })
    .join("\n\n");
}

export function renderFindingsJson(findings: readonly Finding[]): string {
  return JSON.stringify({ findings }, null, 2);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: string | undefined;
  let help = false;
  let configPath: string | undefined;
  let stage: string | undefined;
  let stable = false;
  let json = false;
  let strict = false;
  let deploy = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--stable") {
      stable = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--strict") {
      strict = true;
      continue;
    }

    if (arg === "--deploy") {
      deploy = true;
      continue;
    }

    if (arg === "--config" || arg === "--stage") {
      const value = argv[index + 1];

      if (value === undefined || value.startsWith("-")) {
        throw new CliError(
          2,
          cliFinding({
            id: "cli.option.missing-value",
            title: "Missing option value",
            message: `Option "${arg}" requires a value.`,
          }),
        );
      }

      if (arg === "--config") {
        configPath = value;
      } else {
        stage = value;
      }

      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new CliError(
        2,
        cliFinding({
          id: "cli.option.unknown",
          title: "Unknown option",
          message: `Unknown option "${arg}".`,
          fix: "Run jawstack --help to see available options.",
        }),
      );
    }

    if (command === undefined) {
      command = arg;
      continue;
    }

    throw new CliError(
      2,
      cliFinding({
        id: "cli.argument.unexpected",
        title: "Unexpected argument",
        message: `Unexpected argument "${arg}".`,
      }),
    );
  }

  return {
    command,
    help,
    ...(configPath === undefined ? {} : { configPath }),
    ...(stage === undefined ? {} : { stage }),
    stable,
    json,
    strict,
    deploy,
  };
}

async function runDoctor(parsed: ParsedArgs, cwd: string): Promise<CliResult> {
  const loaded = await loadJawStackConfig({
    cwd,
    ...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }),
  });
  const stage = parsed.stage ?? loaded.config.stage ?? "dev";
  const findings = validateDoctor({
    config: loaded.config,
    configPath: loaded.path,
    stage,
    deploy: parsed.deploy,
  });
  const blocking = hasBlockingFindings(findings, parsed.strict);
  const output = parsed.json ? renderFindingsJson(findings) : renderFindingsHuman(findings);

  return {
    exitCode: blocking ? 1 : 0,
    stdout: `${output}\n`,
    stderr: "",
  };
}

async function runManifest(parsed: ParsedArgs, cwd: string): Promise<CliResult> {
  const loaded = await loadJawStackConfig({
    cwd,
    ...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }),
  });
  const stage = parsed.stage ?? loaded.config.stage ?? "dev";
  const validation = validateResourceRegistry(loaded.config.resources);
  const doctorFindings = validateDoctor({
    config: loaded.config,
    configPath: loaded.path,
    stage,
    deploy: false,
  });
  const configFindings = doctorFindings.filter(
    (finding) =>
      finding.id === "auth.provider.missing" ||
      finding.id.startsWith("cost.") ||
      finding.id === "manifest.serialize.failed",
  );
  const findings = [...validation.findings, ...configFindings];

  if (hasBlockingFindings(findings, false)) {
    const output = parsed.json ? renderFindingsJson(findings) : renderFindingsHuman(findings);

    return {
      exitCode: 1,
      stdout: "",
      stderr: `${output}\n`,
    };
  }

  const manifest = createManifest({
    appName: loaded.config.appName,
    stage,
    stable: parsed.stable,
    resources: loaded.config.resources,
    auth: loaded.config.auth as ManifestAuth,
    costProfile: loaded.config.costProfile,
  });

  return ok(serializeManifest(manifest));
}

export function validateDoctor(context: DoctorContext): readonly Finding[] {
  const findings: Finding[] = [];
  const registryFindings = validateResourceRegistry(context.config.resources).findings;
  const authFindings = validateAuthConfig(context);

  findings.push(...registryFindings);
  findings.push(...authFindings);
  findings.push(...validateCostProfile(context.config.costProfile, context.configPath));

  if (!hasBlockingFindings([...registryFindings, ...authFindings], false)) {
    try {
      serializeManifest(
        createManifest({
          appName: context.config.appName,
          stage: context.stage,
          stable: true,
          resources: context.config.resources,
          auth: context.config.auth as ManifestAuth,
          costProfile: context.config.costProfile,
        }),
      );
    } catch (error) {
      findings.push(
        doctorFinding({
          id: "manifest.serialize.failed",
          severity: "error",
          title: "Manifest serialization failed",
          message:
            error instanceof Error
              ? error.message
              : "The configured JawStack app could not be serialized to a manifest.",
          location: { file: context.configPath },
          impact:
            "The CLI cannot provide manifest, doctor, or future generated documentation output.",
          fix: "Make sure appName, stage, auth, costProfile, and resources are serializable metadata.",
        }),
      );
    }
  }

  return findings;
}

function validateAuthConfig(context: DoctorContext): Finding[] {
  const findings: Finding[] = [];

  if (!isNonEmptyString(context.config.auth.provider)) {
    findings.push(
      doctorFinding({
        id: "auth.provider.missing",
        severity: "error",
        title: "Missing auth provider",
        message: "Config auth.provider must identify the runtime auth provider.",
        location: { file: context.configPath, path: "auth.provider" },
        impact: "The runtime and generated UI cannot resolve or describe authentication behavior.",
        fix: "Set auth.provider to a provider name such as test, dev, or header.",
      }),
    );
  }

  const authMode = context.config.auth.mode;
  const authProvider = context.config.auth.provider;
  const usesDevAuth =
    authMode === "dev" || authProvider === "dev" || authProvider === "DevAuthProvider";

  if (context.deploy && usesDevAuth && !isLocalStage(context.stage)) {
    findings.push(
      doctorFinding({
        id: "auth.dev.deploy-blocked",
        severity: "error",
        title: "Dev auth cannot deploy to this stage",
        message: `Dev auth is configured for deploy stage "${context.stage}".`,
        location: { file: context.configPath, path: "auth" },
        impact: "A deployed non-local stage would accept demo authentication assumptions.",
        fix: "Use a non-dev auth provider or run doctor without --deploy for local checks.",
      }),
    );
  }

  return findings;
}

function validateCostProfile(costProfile: CostProfile, configPath: string): Finding[] {
  const findings: Finding[] = [];
  const lambda = getRecord(costProfile, "lambda");
  const queues = getRecord(costProfile, "queues");
  const dynamodb = getRecord(costProfile, "dynamodb");
  const eventBridge = getRecord(costProfile, "eventBridge");
  const scheduler = getRecord(costProfile, "scheduler");

  if (
    !isPositiveNumber(lambda?.defaultTimeoutSeconds) ||
    !isPositiveNumber(lambda?.maxTimeoutSeconds)
  ) {
    findings.push(
      costFinding({
        id: "cost.lambda.timeout.missing",
        title: "Missing Lambda timeout guardrails",
        message: "costProfile.lambda must set defaultTimeoutSeconds and maxTimeoutSeconds.",
        path: "costProfile.lambda",
        configPath,
        impact: "Generated Lambda functions may deploy without bounded execution time.",
        fix: "Set costProfile.lambda.defaultTimeoutSeconds and maxTimeoutSeconds.",
      }),
    );
  }

  if (
    isPositiveNumber(lambda?.maxTimeoutSeconds) &&
    (lambda.maxTimeoutSeconds > 60 ||
      (isPositiveNumber(lambda.defaultTimeoutSeconds) &&
        lambda.defaultTimeoutSeconds > lambda.maxTimeoutSeconds))
  ) {
    findings.push(
      costFinding({
        id: "cost.lambda.timeout.too-high",
        title: "Lambda timeout guardrail is too high",
        message:
          "costProfile.lambda maxTimeoutSeconds must be 60 seconds or less and cover the default timeout.",
        path: "costProfile.lambda.maxTimeoutSeconds",
        configPath,
        impact:
          "Long-running Lambda functions can amplify accidental cost or concurrency problems.",
        fix: "Use a maxTimeoutSeconds value at or below 60 and keep defaultTimeoutSeconds below it.",
      }),
    );
  }

  if (!isPositiveNumber(lambda?.defaultMemoryMb)) {
    findings.push(
      costFinding({
        id: "cost.lambda.memory.missing",
        title: "Missing Lambda memory guardrail",
        message: "costProfile.lambda.defaultMemoryMb must be set.",
        path: "costProfile.lambda.defaultMemoryMb",
        configPath,
        impact: "Generated Lambda memory, performance, and cost behavior is not explicit.",
        fix: "Set costProfile.lambda.defaultMemoryMb, for example 256.",
      }),
    );
  }

  if (!isPositiveNumber(lambda?.reservedConcurrency)) {
    findings.push(
      costFinding({
        id: "cost.lambda.concurrency.missing",
        title: "Missing Lambda concurrency guardrail",
        message: "costProfile.lambda.reservedConcurrency must be set.",
        path: "costProfile.lambda.reservedConcurrency",
        configPath,
        impact: "Generated Lambdas may scale without an explicit concurrency boundary.",
        fix: "Set costProfile.lambda.reservedConcurrency to a bounded value.",
      }),
    );
  }

  if (queues?.requireDlq !== true) {
    findings.push(
      costFinding({
        id: "cost.queue.dlq.missing",
        title: "Missing queue DLQ guardrail",
        message: "costProfile.queues.requireDlq must be true.",
        path: "costProfile.queues.requireDlq",
        configPath,
        impact:
          "Failed worker messages may retry indefinitely or disappear without operator visibility.",
        fix: "Set costProfile.queues.requireDlq to true.",
      }),
    );
  }

  if (!isPositiveNumber(queues?.defaultMaxConcurrency)) {
    findings.push(
      costFinding({
        id: "cost.queue.max-concurrency.missing",
        title: "Missing queue concurrency guardrail",
        message: "costProfile.queues.defaultMaxConcurrency must be set.",
        path: "costProfile.queues.defaultMaxConcurrency",
        configPath,
        impact: "Worker event source mappings may process unbounded concurrent batches.",
        fix: "Set costProfile.queues.defaultMaxConcurrency to a small bounded value.",
      }),
    );
  }

  if (!isPositiveNumber(queues?.maxReceiveCount)) {
    findings.push(
      costFinding({
        id: "cost.queue.max-receive-count.missing",
        title: "Missing queue max receive count",
        message: "costProfile.queues.maxReceiveCount must be set.",
        path: "costProfile.queues.maxReceiveCount",
        configPath,
        impact: "Poison messages may retry without a clear DLQ handoff point.",
        fix: "Set costProfile.queues.maxReceiveCount, for example 3.",
      }),
    );
  }

  if (dynamodb?.billingMode !== "onDemand") {
    findings.push(
      costFinding({
        id: "cost.dynamodb.billing-mode.invalid",
        title: "Invalid DynamoDB billing mode",
        message: "costProfile.dynamodb.billingMode must be onDemand for the MVP.",
        path: "costProfile.dynamodb.billingMode",
        configPath,
        impact: "The generated infrastructure would not use the documented MVP billing posture.",
        fix: 'Set costProfile.dynamodb.billingMode to "onDemand".',
      }),
    );
  }

  if (
    !isPositiveNumber(dynamodb?.maxReadRequestUnits) ||
    !isPositiveNumber(dynamodb?.maxWriteRequestUnits)
  ) {
    findings.push(
      costFinding({
        id: "cost.dynamodb.throughput-guardrail.missing",
        title: "Missing DynamoDB throughput guardrails",
        message: "costProfile.dynamodb must set maxReadRequestUnits and maxWriteRequestUnits.",
        path: "costProfile.dynamodb",
        configPath,
        impact: "On-demand DynamoDB usage would not have explicit documented guardrails.",
        fix: "Set maxReadRequestUnits and maxWriteRequestUnits to bounded values.",
      }),
    );
  }

  if (
    !isPositiveNumber(scheduler?.maxRetryAttempts) ||
    !isPositiveNumber(scheduler?.maxEventAgeSeconds)
  ) {
    findings.push(
      costFinding({
        id: "cost.scheduler.retry.missing",
        title: "Missing Scheduler retry guardrail",
        message: "costProfile.scheduler must set maxRetryAttempts and maxEventAgeSeconds.",
        path: "costProfile.scheduler",
        configPath,
        impact: "Scheduled targets may retry without an explicit retry boundary.",
        fix: "Set scheduler maxRetryAttempts and maxEventAgeSeconds.",
      }),
    );
  }

  if (scheduler?.requireDlq !== true) {
    findings.push(
      costFinding({
        id: "cost.scheduler.dlq.missing",
        title: "Missing Scheduler DLQ guardrail",
        message: "costProfile.scheduler.requireDlq must be true.",
        path: "costProfile.scheduler.requireDlq",
        configPath,
        impact: "Failed scheduled invocations may not be captured for operator review.",
        fix: "Set costProfile.scheduler.requireDlq to true.",
      }),
    );
  }

  if (eventBridge?.preventSelfTriggeringLoops !== true) {
    findings.push(
      doctorFinding({
        id: "event.loop.suspicious",
        severity: "warning",
        title: "Event loop guardrail is disabled",
        message: "costProfile.eventBridge.preventSelfTriggeringLoops should be true.",
        location: { file: configPath, path: "costProfile.eventBridge.preventSelfTriggeringLoops" },
        impact: "EventBridge rules may accidentally route events back into their own producers.",
        fix: "Set preventSelfTriggeringLoops to true unless you have reviewed the event graph.",
      }),
    );
  }

  if (eventBridge?.requireEventSchemaVersion !== true) {
    findings.push(
      costFinding({
        id: "event.schema-version.missing",
        title: "Event schema version guardrail is disabled",
        message: "costProfile.eventBridge.requireEventSchemaVersion must be true.",
        path: "costProfile.eventBridge.requireEventSchemaVersion",
        configPath,
        impact: "Event contracts may evolve without explicit versioning checks.",
        fix: "Set requireEventSchemaVersion to true.",
      }),
    );
  }

  return findings;
}

async function resolveConfigPath(cwd: string, configPath: string | undefined): Promise<string> {
  if (configPath !== undefined) {
    const explicitPath = path.resolve(cwd, configPath);

    if (await fileExists(explicitPath)) {
      return explicitPath;
    }

    throw new CliError(
      2,
      cliFinding({
        id: "config.missing",
        title: "Config file not found",
        message: `Config file "${configPath}" was not found.`,
        location: { file: explicitPath },
        fix: "Create a JawStack config file or pass a valid --config path.",
      }),
    );
  }

  for (const fileName of defaultConfigFiles) {
    const candidate = path.join(cwd, fileName);

    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new CliError(
    2,
    cliFinding({
      id: "config.missing",
      title: "Config file not found",
      message: `No JawStack config file was found in ${cwd}.`,
      fix: `Create one of: ${defaultConfigFiles.join(", ")}.`,
    }),
  );
}

async function importConfigModule(configPath: string): Promise<unknown> {
  const extension = path.extname(configPath);

  if (extension === ".js" || extension === ".mjs") {
    return import(`${pathToFileURL(configPath).href}?t=${Date.now()}`);
  }

  if (extension !== ".ts" && extension !== ".mts") {
    throw new CliError(
      2,
      cliFinding({
        id: "config.invalid",
        title: "Unsupported config file",
        message: "JawStack config files must use .ts, .mts, .js, or .mjs.",
        location: { file: configPath },
      }),
    );
  }

  const result = await build({
    entryPoints: [configPath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles[0]?.text;

  if (output === undefined) {
    throw new CliError(
      2,
      cliFinding({
        id: "config.invalid",
        title: "Config transpilation failed",
        message: "The config loader did not produce executable JavaScript.",
        location: { file: configPath },
      }),
    );
  }

  const encoded = Buffer.from(output).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

function normalizeConfig(moduleNamespace: unknown, configPath: string): JawStackConfig {
  if (!isRecord(moduleNamespace)) {
    throw invalidConfig(configPath, "Config module did not export an object.");
  }

  const exported =
    moduleNamespace.default ?? moduleNamespace.config ?? moduleNamespace.jawstackConfig;

  if (!isRecord(exported)) {
    throw invalidConfig(
      configPath,
      "Config module must export a JawStack config as default, config, or jawstackConfig.",
    );
  }

  if (!isNonEmptyString(exported.appName)) {
    throw invalidConfig(configPath, "Config appName must be a non-empty string.");
  }

  if (!Array.isArray(exported.resources)) {
    throw invalidConfig(configPath, "Config resources must be an array.");
  }

  if (!isRecord(exported.auth)) {
    throw invalidConfig(configPath, "Config auth must be an object.");
  }

  if (!isRecord(exported.costProfile)) {
    throw invalidConfig(configPath, "Config costProfile must be an object.");
  }

  return exported as JawStackConfig;
}

function invalidConfig(configPath: string, message: string): CliError {
  return new CliError(
    2,
    cliFinding({
      id: "config.invalid",
      title: "Invalid config",
      message,
      location: { file: configPath },
      fix: "Export defineJawStackApp({ appName, resources, auth, costProfile }) from the config file.",
    }),
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

function hasBlockingFindings(findings: readonly Finding[], strict: boolean): boolean {
  return findings.some(
    (finding) => finding.severity === "error" || (strict && finding.severity === "warning"),
  );
}

function doctorFinding(input: Finding): Finding {
  return input;
}

function costFinding(input: {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly path: string;
  readonly configPath: string;
  readonly impact: string;
  readonly fix: string;
}): Finding {
  return doctorFinding({
    id: input.id,
    severity: "error",
    title: input.title,
    message: input.message,
    location: { file: input.configPath, path: input.path },
    impact: input.impact,
    fix: input.fix,
  });
}

function isLocalStage(stage: string): boolean {
  return stage === "local" || stage === "dev" || stage === "test";
}

function getRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function renderFindingLocation(finding: Finding): string | undefined {
  if (finding.location === undefined) {
    return undefined;
  }

  const parts = [
    finding.location.file,
    finding.location.path,
    finding.location.resource === undefined ? undefined : `resource=${finding.location.resource}`,
    finding.location.command === undefined ? undefined : `command=${finding.location.command}`,
  ].filter((part): part is string => part !== undefined);

  return parts.length === 0 ? undefined : parts.join(" ");
}

function cliFinding(
  input: Omit<Finding, "severity"> & Partial<Pick<Finding, "severity">>,
): Finding {
  return {
    severity: "error",
    ...input,
  };
}

function ok(stdout: string): CliResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
