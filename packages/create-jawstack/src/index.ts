import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

export const packageName = "create-jawstack";
export const defaultTemplateName = "angular-resource-workflow";
export const defaultJawStackVersion = "0.0.0";

export type GenerateJawStackAppOptions = Readonly<{
  appName?: string;
  force?: boolean;
  jawstackVersion?: string;
  localPackageRoot?: string;
  targetDirectory: string;
  templateName?: string;
}>;

export type GenerateJawStackAppResult = Readonly<{
  appPackageName: string;
  appTitle: string;
  targetDirectory: string;
  templateName: string;
  nextSteps: readonly string[];
}>;

export type CreateJawStackCliOptions = Readonly<{
  cwd?: string;
  stderr?: Writable;
  stdout?: Writable;
}>;

export class CreateJawStackError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CreateJawStackError";
    this.exitCode = exitCode;
  }
}

export function getHelpText(): string {
  return `create-jawstack

Usage:
  create-jawstack <app-name> [options]

Options:
  -f, --force                 Overwrite files in a non-empty target directory.
  --template <name>           Template to use. Default: angular-resource-workflow.
  --local-package-root <dir>  Use local @jawstack packages from a repository checkout.
  -h, --help                  Show this help text.`;
}

export function describePackage(): string {
  return `${packageName} project generator`;
}

export async function runCreateJawStackCli(
  argv: readonly string[],
  options: CreateJawStackCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const parsed = parseCliArguments(argv, options.cwd ?? process.cwd());

    if (parsed.help) {
      stdout.write(`${getHelpText()}\n`);
      return 0;
    }

    const result = await generateJawStackApp(parsed.generateOptions);
    stdout.write(formatSuccessMessage(result, options.cwd ?? process.cwd()));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown create-jawstack error.";
    stderr.write(`${message}\n`);
    return error instanceof CreateJawStackError ? error.exitCode : 1;
  }
}

export async function generateJawStackApp(
  options: GenerateJawStackAppOptions,
): Promise<GenerateJawStackAppResult> {
  const templateName = options.templateName ?? defaultTemplateName;

  if (templateName !== defaultTemplateName) {
    throw new CreateJawStackError(`Unknown template "${templateName}".`);
  }

  const targetDirectory = resolve(options.targetDirectory);
  const appPackageName = toPackageName(options.appName ?? basename(targetDirectory));
  const appTitle = toTitle(appPackageName);
  const localPackageRoot =
    options.localPackageRoot === undefined ? undefined : resolve(options.localPackageRoot);
  const templateDirectory = await resolveTemplateDirectory(templateName);
  const jawstackVersion = options.jawstackVersion ?? defaultJawStackVersion;

  await prepareTargetDirectory(targetDirectory, options.force === true);
  await cp(templateDirectory, targetDirectory, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });

  await replaceTemplateTokens(targetDirectory, {
    __APP_PACKAGE_NAME__: appPackageName,
    __APP_TITLE__: appTitle,
    __JAWSTACK_ANGULAR_DEPENDENCY__:
      localPackageRoot === undefined
        ? jawstackVersion
        : localPackageDependency(localPackageRoot, "angular"),
    __JAWSTACK_AWS_CDK_DEPENDENCY__:
      localPackageRoot === undefined
        ? jawstackVersion
        : localPackageDependency(localPackageRoot, "aws-cdk"),
    __JAWSTACK_AWS_RUNTIME_DEPENDENCY__:
      localPackageRoot === undefined
        ? jawstackVersion
        : localPackageDependency(localPackageRoot, "aws-runtime"),
    __JAWSTACK_CLI_DEPENDENCY__:
      localPackageRoot === undefined
        ? jawstackVersion
        : localPackageDependency(localPackageRoot, "cli"),
    __JAWSTACK_CORE_DEPENDENCY__:
      localPackageRoot === undefined
        ? jawstackVersion
        : localPackageDependency(localPackageRoot, "core"),
  });

  if (localPackageRoot !== undefined) {
    await applyLocalPackageOverrides(targetDirectory, localPackageRoot);
  }

  return {
    appPackageName,
    appTitle,
    targetDirectory,
    templateName,
    nextSteps: [
      `cd ${relative(process.cwd(), targetDirectory) || "."}`,
      "pnpm install",
      "pnpm dev:api",
      "pnpm dev:web",
    ],
  };
}

function parseCliArguments(
  argv: readonly string[],
  cwd: string,
):
  | Readonly<{ help: true }>
  | Readonly<{ help: false; generateOptions: GenerateJawStackAppOptions }> {
  let force = false;
  let help = false;
  let localPackageRoot: string | undefined;
  let templateName: string | undefined;
  let targetArgument: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === undefined) {
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }

    if (argument === "--force" || argument === "-f") {
      force = true;
      continue;
    }

    if (argument === "--template") {
      templateName = readOptionValue(argv, index, "--template");
      index += 1;
      continue;
    }

    if (argument === "--local-package-root") {
      localPackageRoot = resolve(cwd, readOptionValue(argv, index, "--local-package-root"));
      index += 1;
      continue;
    }

    if (argument.startsWith("-")) {
      throw new CreateJawStackError(`Unknown option "${argument}".`);
    }

    if (targetArgument !== undefined) {
      throw new CreateJawStackError("Expected one target directory.");
    }

    targetArgument = argument;
  }

  if (help) {
    return { help: true };
  }

  if (targetArgument === undefined) {
    throw new CreateJawStackError("Missing app name. Run create-jawstack --help for usage.");
  }

  return {
    help: false,
    generateOptions: {
      appName: basename(targetArgument),
      force,
      ...(localPackageRoot === undefined ? {} : { localPackageRoot }),
      targetDirectory: resolve(cwd, targetArgument),
      ...(templateName === undefined ? {} : { templateName }),
    },
  };
}

function readOptionValue(argv: readonly string[], index: number, optionName: string): string {
  const value = argv[index + 1];

  if (value === undefined || value.startsWith("-")) {
    throw new CreateJawStackError(`Missing value for ${optionName}.`);
  }

  return value;
}

async function resolveTemplateDirectory(templateName: string): Promise<string> {
  const candidates = [
    fileURLToPath(new URL(`./templates/${templateName}/`, import.meta.url)),
    fileURLToPath(new URL(`../templates/${templateName}/`, import.meta.url)),
    fileURLToPath(new URL(`../../../templates/${templateName}/`, import.meta.url)),
  ];

  for (const candidate of candidates) {
    try {
      const templateStat = await stat(candidate);

      if (templateStat.isDirectory()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  throw new CreateJawStackError(`Template not found: ${candidates.join(" or ")}`);
}

async function prepareTargetDirectory(targetDirectory: string, force: boolean): Promise<void> {
  await mkdir(targetDirectory, { recursive: true });
  const entries = await readdir(targetDirectory);

  if (entries.length > 0 && !force) {
    throw new CreateJawStackError(
      `Target directory is not empty: ${targetDirectory}. Use --force to overwrite template files.`,
    );
  }
}

async function replaceTemplateTokens(
  directory: string,
  replacements: Readonly<Record<string, string>>,
): Promise<void> {
  const files = await listFiles(directory);

  await Promise.all(
    files.map(async (file) => {
      const original = await readFile(file, "utf8");
      let updated = original;

      for (const [token, value] of Object.entries(replacements)) {
        updated = updated.replaceAll(token, value);
      }

      if (updated !== original) {
        await writeFile(file, updated);
      }
    }),
  );
}

async function listFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return listFiles(entryPath);
      }

      return [entryPath];
    }),
  );

  return files.flat();
}

async function applyLocalPackageOverrides(
  targetDirectory: string,
  localPackageRoot: string,
): Promise<void> {
  const packageJsonPath = resolve(targetDirectory, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    pnpm?: {
      onlyBuiltDependencies?: readonly string[];
      overrides?: Record<string, string>;
    };
  };

  packageJson.pnpm ??= {};
  packageJson.pnpm.overrides = {
    ...packageJson.pnpm.overrides,
    "@jawstack/core": localPackageDependency(localPackageRoot, "core"),
  };

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function localPackageDependency(localPackageRoot: string, packageDirectoryName: string): string {
  return pathToFileURL(resolve(localPackageRoot, `packages/${packageDirectoryName}`)).href;
}

function toPackageName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "")
    .replace(/-{2,}/g, "-");

  if (normalized.length === 0) {
    throw new CreateJawStackError(`Could not derive a package name from "${value}".`);
  }

  return normalized;
}

function toTitle(packageNameValue: string): string {
  return packageNameValue
    .split(/[-._]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatSuccessMessage(result: GenerateJawStackAppResult, cwd: string): string {
  const target = relative(cwd, result.targetDirectory) || ".";
  const nextSteps = [`cd ${target}`, ...result.nextSteps.slice(1)]
    .map((step) => `  ${step}`)
    .join("\n");

  return `Created ${result.appTitle} at ${target}

Next steps:
${nextSteps}
`;
}
