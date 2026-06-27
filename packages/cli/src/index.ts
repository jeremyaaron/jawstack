import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  smoke?: Readonly<{
    apiUrl?: string;
    timeoutMs?: number;
    intervalMs?: number;
    auth?: Readonly<{
      subject?: string;
      displayName?: string;
      roles?: readonly string[];
      tenantId?: string;
    }>;
  }>;
}>;

export type CliResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type CommandRunResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    env: Readonly<Record<string, string | undefined>>;
  }>,
) => Promise<CommandRunResult>;

export type HttpRequest = Readonly<{
  body?: string;
  headers?: Readonly<Record<string, string>>;
  method?: string;
}>;

export type HttpResponse = Readonly<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export type HttpClient = (url: string, init?: HttpRequest) => Promise<HttpResponse>;

export type Sleep = (milliseconds: number) => Promise<void>;

export type RunCliOptions = Readonly<{
  commandRunner?: CommandRunner;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  httpClient?: HttpClient;
  sleep?: Sleep;
}>;

type ParsedArgs = Readonly<{
  apiUrl?: string;
  command: string | undefined;
  allowDevAuth: boolean;
  help: boolean;
  intervalMs?: number;
  configPath?: string;
  profile?: string;
  region?: string;
  stage?: string;
  stable: boolean;
  json: boolean;
  strict: boolean;
  timeoutMs?: number;
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
  allowDevAuth: boolean;
  env: Readonly<Record<string, string | undefined>>;
  profile?: string;
  region?: string;
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

class SmokeStepError extends Error {
  readonly step: string;

  constructor(step: string, message: string) {
    super(message);
    this.name = "SmokeStepError";
    this.step = step;
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
  deploy      Deploy a stage through CDK
  smoke       Verify a deployed Work Request API
  destroy     Destroy a stage through CDK

Options:
  --config <path>       Load a specific config file
  --stage <stage>       Override the config stage
  --region <region>     Override config.aws.region for deploy/destroy
  --profile <profile>   Override config.aws.profile for deploy/destroy
  --api-url <url>       Override deployed API URL for smoke
  --timeout-ms <ms>     Smoke polling timeout in milliseconds
  --interval-ms <ms>    Smoke polling interval in milliseconds
  --allow-dev-auth      Allow dev auth during deploy checks
  --json                Print machine-readable output where supported
  --stable              Omit generated timestamps where supported
  --strict              Treat warnings as blocking findings
  --help                Show help`;
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  options: RunCliOptions = {},
): Promise<CliResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const commandRunner = options.commandRunner ?? runCommand;
  const httpClient = options.httpClient ?? fetchHttp;
  const sleep = options.sleep ?? sleepFor;
  let parsed: ParsedArgs | undefined;

  try {
    parsed = parseArgs(argv);

    if (parsed.help || parsed.command === undefined) {
      return ok(`${getHelpText()}\n`);
    }

    switch (parsed.command) {
      case "doctor":
        return await runDoctor(parsed, cwd, env);
      case "manifest":
        return await runManifest(parsed, cwd, env);
      case "deploy":
        return await runLifecycleCommand("deploy", parsed, cwd, env, commandRunner);
      case "destroy":
        return await runLifecycleCommand("destroy", parsed, cwd, env, commandRunner);
      case "smoke":
        return await runSmokeCommand(parsed, cwd, httpClient, sleep);
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
  let apiUrl: string | undefined;
  let command: string | undefined;
  let allowDevAuth = false;
  let help = false;
  let intervalMs: number | undefined;
  let configPath: string | undefined;
  let profile: string | undefined;
  let region: string | undefined;
  let stage: string | undefined;
  let stable = false;
  let json = false;
  let strict = false;
  let timeoutMs: number | undefined;
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

    if (arg === "--allow-dev-auth") {
      allowDevAuth = true;
      continue;
    }

    if (
      arg === "--config" ||
      arg === "--stage" ||
      arg === "--region" ||
      arg === "--profile" ||
      arg === "--api-url" ||
      arg === "--timeout-ms" ||
      arg === "--interval-ms"
    ) {
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
      } else if (arg === "--stage") {
        stage = value;
      } else if (arg === "--region") {
        region = value;
      } else if (arg === "--profile") {
        profile = value;
      } else if (arg === "--api-url") {
        apiUrl = value;
      } else if (arg === "--timeout-ms") {
        timeoutMs = parsePositiveIntegerOption(arg, value);
      } else {
        intervalMs = parsePositiveIntegerOption(arg, value);
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

    if (isLifecycleCommand(command) && stage === undefined) {
      stage = arg;
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
    ...(apiUrl === undefined ? {} : { apiUrl }),
    command,
    allowDevAuth,
    help,
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(profile === undefined ? {} : { profile }),
    ...(region === undefined ? {} : { region }),
    ...(stage === undefined ? {} : { stage }),
    stable,
    json,
    strict,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    deploy,
  };
}

function parsePositiveIntegerOption(optionName: string, value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(
      2,
      cliFinding({
        id: "cli.option.invalid-value",
        title: "Invalid option value",
        message: `Option "${optionName}" must be a positive integer.`,
      }),
    );
  }

  return parsed;
}

function isLifecycleCommand(command: string): command is "deploy" | "destroy" | "smoke" {
  return command === "deploy" || command === "destroy" || command === "smoke";
}

async function runDoctor(
  parsed: ParsedArgs,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<CliResult> {
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
    allowDevAuth: parsed.allowDevAuth,
    env,
    ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
    ...(parsed.region === undefined ? {} : { region: parsed.region }),
  });
  const blocking = hasBlockingFindings(findings, parsed.strict);
  const output = parsed.json ? renderFindingsJson(findings) : renderFindingsHuman(findings);

  return {
    exitCode: blocking ? 1 : 0,
    stdout: `${output}\n`,
    stderr: "",
  };
}

async function runManifest(
  parsed: ParsedArgs,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<CliResult> {
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
    allowDevAuth: false,
    env,
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

async function runLifecycleCommand(
  command: "deploy" | "destroy",
  parsed: ParsedArgs,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  commandRunner: CommandRunner,
): Promise<CliResult> {
  const loaded = await loadJawStackConfig({
    cwd,
    ...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }),
  });
  const stage = parsed.stage ?? loaded.config.stage ?? "dev";
  const profile = parsed.profile ?? loaded.config.aws?.profile ?? env.AWS_PROFILE;
  const region =
    parsed.region ?? loaded.config.aws?.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  const findings = validateDoctor({
    config: loaded.config,
    configPath: loaded.path,
    stage,
    deploy: true,
    allowDevAuth: parsed.allowDevAuth,
    env,
    ...(profile === undefined ? {} : { profile }),
    ...(region === undefined ? {} : { region }),
  });

  if (hasBlockingFindings(findings, parsed.strict)) {
    const output = parsed.json ? renderFindingsJson(findings) : renderFindingsHuman(findings);

    return {
      exitCode: 1,
      stdout: "",
      stderr: `${output}\n`,
    };
  }

  const outputFile = path.join(cwd, ".jawstack", "outputs", `${stage}.json`);

  if (command === "deploy") {
    await mkdir(path.dirname(outputFile), { recursive: true });
  }

  const cdkArgs = cdkCommandArgs(command, {
    configPath: loaded.path,
    outputFile,
    profile,
    stage,
  });
  const childEnv = {
    ...env,
    ...(region === undefined
      ? {}
      : {
          AWS_DEFAULT_REGION: region,
          AWS_REGION: region,
        }),
    ...(profile === undefined ? {} : { AWS_PROFILE: profile }),
  };
  const result = await commandRunner("pnpm", cdkArgs, {
    cwd,
    env: childEnv,
  });

  if (result.exitCode !== 0) {
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr:
        result.stderr.length === 0
          ? `CDK ${command} failed with exit code ${result.exitCode}.\n`
          : result.stderr,
    };
  }

  const summary =
    command === "deploy"
      ? await renderDeploySummary({
          appName: loaded.config.appName,
          outputFile,
          stage,
        })
      : `Destroyed ${loaded.config.appName} ${stage}.\n`;

  return {
    exitCode: 0,
    stdout: `${result.stdout}${result.stdout.length > 0 && !result.stdout.endsWith("\n") ? "\n" : ""}${summary}`,
    stderr: result.stderr,
  };
}

async function runSmokeCommand(
  parsed: ParsedArgs,
  cwd: string,
  httpClient: HttpClient,
  sleep: Sleep,
): Promise<CliResult> {
  const loaded = await loadJawStackConfig({
    cwd,
    ...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }),
  });
  const stage = parsed.stage ?? loaded.config.stage ?? "dev";
  const apiUrl = await resolveSmokeApiUrl({
    config: loaded.config,
    cwd,
    parsed,
    stage,
  });
  const timeoutMs = parsed.timeoutMs ?? loaded.config.smoke?.timeoutMs ?? 30_000;
  const intervalMs = parsed.intervalMs ?? loaded.config.smoke?.intervalMs ?? 1_000;
  const headers = smokeAuthHeaders(loaded.config);
  const title = `JawStack smoke ${stage} ${new Date().toISOString()}`;

  try {
    const apiBaseUrl = normalizeSmokeApiBaseUrl(apiUrl);
    const created = await smokePostJson<{ resourceId: string; status: string }>({
      body: {
        input: {
          title,
          description: "Created by jawstack smoke.",
        },
      },
      headers,
      httpClient,
      step: "create work request",
      url: `${apiBaseUrl}/resources/workRequest/commands/create`,
    });

    if (!isNonEmptyString(created.resourceId)) {
      throw new SmokeStepError(
        "create work request",
        "Create response did not include resourceId.",
      );
    }

    const detail = await smokeGetJson<{
      resourceId: string;
      state?: { status?: string; title?: string };
    }>({
      headers,
      httpClient,
      step: "read work request",
      url: `${apiBaseUrl}/resources/workRequest/${encodeURIComponent(created.resourceId)}`,
    });

    if (detail.resourceId !== created.resourceId) {
      throw new SmokeStepError(
        "read work request",
        `Detail response returned resourceId "${detail.resourceId}".`,
      );
    }

    const activity = await pollSmokeActivity({
      apiBaseUrl,
      headers,
      httpClient,
      intervalMs,
      resourceId: created.resourceId,
      sleep,
      timeoutMs,
    });
    const status = detail.state?.status ?? created.status;

    return ok(
      [
        `Smoke passed for ${loaded.config.appName} ${stage}.`,
        `API: ${apiBaseUrl}`,
        "Resource:",
        `  resourceId: ${created.resourceId}`,
        `  status: ${status}`,
        "Checks:",
        "  create command: ok",
        "  detail read: ok",
        `  activity poll: ok (${activity.items.length} item${activity.items.length === 1 ? "" : "s"})`,
        "",
      ].join("\n"),
    );
  } catch (error) {
    const step = error instanceof SmokeStepError ? error.step : "smoke";
    const message = error instanceof Error ? error.message : "Unknown smoke failure.";

    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        `Smoke failed for ${loaded.config.appName} ${stage}.`,
        `API: ${apiUrl}`,
        `Step: ${step}`,
        message,
        "",
      ].join("\n"),
    };
  }
}

export function validateDoctor(context: DoctorContext): readonly Finding[] {
  const findings: Finding[] = [];
  const registryFindings = validateResourceRegistry(context.config.resources).findings;
  const authFindings = validateAuthConfig(context);

  findings.push(...registryFindings);
  findings.push(...authFindings);
  findings.push(...validateCostProfile(context.config.costProfile, context.configPath));
  findings.push(...validateAwsConfig(context));

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

  if (context.deploy && usesDevAuth && !context.allowDevAuth && !isLocalStage(context.stage)) {
    findings.push(
      doctorFinding({
        id: "auth.dev.deploy-blocked",
        severity: "error",
        title: "Dev auth cannot deploy to this stage",
        message: `Dev auth is configured for deploy stage "${context.stage}".`,
        location: { file: context.configPath, path: "auth" },
        impact: "A deployed non-local stage would accept demo authentication assumptions.",
        fix: "Use a non-dev auth provider, deploy a local/dev stage, or pass --allow-dev-auth only for a reviewed temporary environment.",
      }),
    );
  }

  return findings;
}

function validateAwsConfig(context: DoctorContext): Finding[] {
  if (!context.deploy) {
    return [];
  }

  const findings: Finding[] = [];
  const region =
    context.region ??
    context.config.aws?.region ??
    context.env.AWS_REGION ??
    context.env.AWS_DEFAULT_REGION;
  const profile = context.profile ?? context.config.aws?.profile ?? context.env.AWS_PROFILE;
  const hasCredentialEnvironment =
    isNonEmptyString(context.env.AWS_ACCESS_KEY_ID) ||
    isNonEmptyString(context.env.AWS_WEB_IDENTITY_TOKEN_FILE) ||
    isNonEmptyString(context.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) ||
    isNonEmptyString(context.env.AWS_CONTAINER_CREDENTIALS_FULL_URI);

  if (!isNonEmptyString(region)) {
    findings.push(
      doctorFinding({
        id: "aws.region.missing",
        severity: "error",
        title: "Missing AWS region",
        message: "Deploy checks require an AWS region.",
        location: { file: context.configPath, path: "aws.region" },
        impact: "CDK cannot deploy or destroy a deterministic stage without a target region.",
        fix: "Set aws.region in jawstack.config.ts, pass --region, or set AWS_REGION.",
      }),
    );
  }

  if (!isNonEmptyString(profile) && !hasCredentialEnvironment) {
    findings.push(
      doctorFinding({
        id: "aws.credentials.unavailable",
        severity: "error",
        title: "AWS credentials are unavailable",
        message: "Deploy checks could not find an AWS profile or credential environment.",
        location: { file: context.configPath, path: "aws.profile" },
        impact: "CDK deploy and destroy commands would fail before reaching AWS.",
        fix: "Set aws.profile, pass --profile, set AWS_PROFILE, or provide AWS credential environment variables.",
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

function cdkCommandArgs(
  command: "deploy" | "destroy",
  input: Readonly<{
    configPath: string;
    outputFile: string;
    profile: string | undefined;
    stage: string;
  }>,
): readonly string[] {
  const commonArgs = [
    "exec",
    "cdk",
    command,
    "--context",
    `jawstackStage=${input.stage}`,
    "--context",
    `jawstackConfig=${input.configPath}`,
    ...(input.profile === undefined ? [] : ["--profile", input.profile]),
  ];

  if (command === "deploy") {
    return [...commonArgs, "--require-approval", "never", "--outputs-file", input.outputFile];
  }

  return [...commonArgs, "--force"];
}

async function renderDeploySummary(input: {
  readonly appName: string;
  readonly outputFile: string;
  readonly stage: string;
}): Promise<string> {
  const outputs = await readCdkOutputs(input.outputFile);
  const outputLines = Object.entries(outputs).flatMap(([stackName, stackOutputs]) =>
    Object.entries(stackOutputs).map(([key, value]) => `  ${stackName}.${key}: ${value}`),
  );

  return [
    `Deployed ${input.appName} ${input.stage}.`,
    ...(outputLines.length === 0 ? [] : ["Stack outputs:", ...outputLines]),
    "",
  ].join("\n");
}

async function readCdkOutputs(outputFile: string): Promise<Record<string, Record<string, string>>> {
  try {
    const parsed = JSON.parse(await readFile(outputFile, "utf8")) as unknown;

    if (!isRecord(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([stackName, stackOutputs]) => {
        if (!isRecord(stackOutputs)) {
          return [];
        }

        return [
          [
            stackName,
            Object.fromEntries(
              Object.entries(stackOutputs)
                .filter((entry): entry is [string, string] => typeof entry[1] === "string")
                .sort(([left], [right]) => left.localeCompare(right)),
            ),
          ],
        ];
      }),
    );
  } catch {
    return {};
  }
}

async function resolveSmokeApiUrl(input: {
  readonly config: JawStackConfig;
  readonly cwd: string;
  readonly parsed: ParsedArgs;
  readonly stage: string;
}): Promise<string> {
  if (input.parsed.apiUrl !== undefined) {
    return input.parsed.apiUrl;
  }

  if (input.config.smoke?.apiUrl !== undefined) {
    return input.config.smoke.apiUrl;
  }

  const outputs = await readCdkOutputs(
    path.join(input.cwd, ".jawstack", "outputs", `${input.stage}.json`),
  );
  const outputUrl = findApiUrlInOutputs(outputs);

  if (outputUrl !== undefined) {
    return outputUrl;
  }

  throw new CliError(
    2,
    cliFinding({
      id: "smoke.api-url.missing",
      title: "Smoke API URL not found",
      message: `No API URL was found for stage "${input.stage}".`,
      fix: "Run jawstack deploy first, pass --api-url, or set smoke.apiUrl in jawstack.config.ts.",
    }),
  );
}

function findApiUrlInOutputs(outputs: Record<string, Record<string, string>>): string | undefined {
  const entries = Object.values(outputs).flatMap((stackOutputs) => Object.entries(stackOutputs));
  const preferred = entries.find(([key, value]) => /api.*url/i.test(key) && isHttpUrl(value));

  if (preferred !== undefined) {
    return preferred[1];
  }

  return entries.find(([, value]) => isHttpUrl(value))?.[1];
}

function normalizeSmokeApiBaseUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, "");

  if (!isHttpUrl(trimmed)) {
    throw new SmokeStepError("resolve API URL", `Invalid API URL "${apiUrl}".`);
  }

  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function smokeAuthHeaders(config: JawStackConfig): Record<string, string> {
  const auth = config.smoke?.auth;
  const roles = auth?.roles ?? ["user", "manager"];

  return {
    "content-type": "application/json",
    "x-jawstack-subject": auth?.subject ?? "smoke_user",
    "x-jawstack-display-name": auth?.displayName ?? "JawStack Smoke",
    "x-jawstack-roles": roles.join(","),
    ...(auth?.tenantId === undefined ? {} : { "x-jawstack-tenant-id": auth.tenantId }),
  };
}

async function smokePostJson<T>(input: {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly httpClient: HttpClient;
  readonly step: string;
  readonly url: string;
}): Promise<T> {
  return smokeRequestJson<T>({
    headers: input.headers,
    httpClient: input.httpClient,
    init: {
      body: JSON.stringify(input.body),
      headers: input.headers,
      method: "POST",
    },
    step: input.step,
    url: input.url,
  });
}

async function smokeGetJson<T>(input: {
  readonly headers: Readonly<Record<string, string>>;
  readonly httpClient: HttpClient;
  readonly step: string;
  readonly url: string;
}): Promise<T> {
  return smokeRequestJson<T>({
    headers: input.headers,
    httpClient: input.httpClient,
    init: {
      headers: input.headers,
      method: "GET",
    },
    step: input.step,
    url: input.url,
  });
}

async function smokeRequestJson<T>(input: {
  readonly headers: Readonly<Record<string, string>>;
  readonly httpClient: HttpClient;
  readonly init: HttpRequest;
  readonly step: string;
  readonly url: string;
}): Promise<T> {
  const response = await input.httpClient(input.url, input.init);

  if (!response.ok) {
    throw new SmokeStepError(
      input.step,
      `HTTP ${response.status} from ${input.url}: ${await response.text()}`,
    );
  }

  const body = await response.json();

  if (!isRecord(body) || body.ok !== true || !("data" in body)) {
    throw new SmokeStepError(input.step, `Unexpected response body from ${input.url}.`);
  }

  return body.data as T;
}

async function pollSmokeActivity(input: {
  readonly apiBaseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly httpClient: HttpClient;
  readonly intervalMs: number;
  readonly resourceId: string;
  readonly sleep: Sleep;
  readonly timeoutMs: number;
}): Promise<{ items: readonly { activityType?: string }[] }> {
  let elapsedMs = 0;

  while (true) {
    const activity = await smokeGetJson<{ items: readonly { activityType?: string }[] }>({
      headers: input.headers,
      httpClient: input.httpClient,
      step: "read activity",
      url: `${input.apiBaseUrl}/resources/workRequest/${encodeURIComponent(input.resourceId)}/activity`,
    });

    if (activity.items.some((item) => item.activityType === "created")) {
      return activity;
    }

    if (elapsedMs >= input.timeoutMs) {
      throw new SmokeStepError(
        "poll activity",
        `Timed out after ${input.timeoutMs}ms waiting for created activity.`,
      );
    }

    await input.sleep(input.intervalMs);
    elapsedMs += input.intervalMs;
  }
}

async function fetchHttp(url: string, init?: HttpRequest): Promise<HttpResponse> {
  return fetch(url, {
    ...(init?.body === undefined ? {} : { body: init.body }),
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
    ...(init?.method === undefined ? {} : { method: init.method }),
  });
}

async function sleepFor(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    env: Readonly<Record<string, string | undefined>>;
  }>,
): Promise<CommandRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
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
    external: [packageName],
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

  const cacheDirectory = path.join(path.dirname(configPath), ".jawstack", "cache");
  const outputPath = path.join(cacheDirectory, `config-${Date.now()}-${randomUUID()}.mjs`);

  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(outputPath, output);

  try {
    return await import(`${pathToFileURL(outputPath).href}?t=${Date.now()}`);
  } finally {
    await rm(outputPath, { force: true });
  }
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
