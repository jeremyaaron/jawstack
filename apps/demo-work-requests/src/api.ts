import { type Server } from "node:http";
import { fileURLToPath } from "node:url";

import {
  HeaderAuthProvider,
  createInMemoryPersistence,
  createLocalHttpServer,
  type AuthProvider,
  type IdGenerator,
  type InMemoryStore,
  type LocalHttpAdapterOptions,
} from "@jawstack/core";

import { demoAppName, demoCostProfile, demoResources, demoStage } from "./example";

export type DemoApiOptions = Readonly<{
  authProvider?: AuthProvider;
  ids?: Partial<IdGenerator>;
  store?: InMemoryStore;
}>;

export type DemoApiServerOptions = DemoApiOptions &
  Readonly<{
    host?: string;
    port?: number;
    silent?: boolean;
  }>;

export type DemoApiServer = Readonly<{
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}>;

export function createDemoApiOptions(options: DemoApiOptions = {}): LocalHttpAdapterOptions {
  const persistence = createInMemoryPersistence(options.store);

  return {
    appName: demoAppName,
    stage: demoStage,
    registry: demoResources,
    repository: persistence.repository,
    unitOfWork: persistence.unitOfWork,
    authProvider: options.authProvider ?? new HeaderAuthProvider(),
    auth: {
      mode: "external",
      provider: "header",
    },
    costProfile: demoCostProfile,
    source: "jawstack.demo",
    ...(options.ids === undefined ? {} : { ids: options.ids }),
  };
}

export async function startDemoApiServer(
  options: DemoApiServerOptions = {},
): Promise<DemoApiServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.JAWSTACK_DEMO_API_PORT ?? 4317);
  const server = createLocalHttpServer(createDemoApiOptions(options));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const baseUrl = `http://${host}:${actualPort}`;

  if (options.silent !== true) {
    process.stdout.write(`JawStack demo API listening at ${baseUrl}\n`);
  }

  return {
    server,
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  startDemoApiServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown demo API startup error.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
