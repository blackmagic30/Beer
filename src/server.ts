import type { Server } from "node:http";

import { redactSecrets } from "./lib/redact.js";

let server: Server | undefined;
let shutdownServices: () => Promise<void> = async () => {};
let shuttingDown = false;

function getDeployMeta(): Record<string, string> {
  return {
    railwayEnvironment: process.env.RAILWAY_ENVIRONMENT_NAME ?? "unknown",
    railwayService: process.env.RAILWAY_SERVICE_NAME ?? "unknown",
    commitSha:
      process.env.RAILWAY_GIT_COMMIT_SHA ??
      process.env.GITHUB_SHA ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      "unknown",
  };
}

function getBoundAddress(): string {
  const address = server?.address();
  return typeof address === "object" && address !== null
    ? `${address.address}:${address.port}`
    : String(address ?? "unknown");
}

async function boot(): Promise<void> {
  try {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        message: "pint-path booting",
        meta: getDeployMeta(),
      }),
    );
    const [{ createApp, initializeAppServices, shutdownAppServices }, { env }, { logger }] = await Promise.all([
      import("./app.js"),
      import("./config/env.js"),
      import("./lib/logger.js"),
    ]);
    const app = createApp();
    await initializeAppServices();
    shutdownServices = shutdownAppServices;
    const useRailwayBinding = process.env.RAILWAY_ENVIRONMENT_NAME !== undefined;
    const listenHost = useRailwayBinding ? "::" : env.HOST;

    const onListening = () => {
      logger.info(
        `pint-path listening host=${env.HOST ?? "default"} effectiveHost=${listenHost ?? "default"} railwayBinding=${useRailwayBinding} port=${env.PORT} bound=${getBoundAddress()} publicBaseUrl=${env.PUBLIC_BASE_URL}`,
        getDeployMeta(),
      );
    };

    server = useRailwayBinding
      ? app.listen(
          {
            port: env.PORT,
            host: listenHost,
            ipv6Only: false,
          },
          onListening,
        )
      : listenHost
        ? app.listen(env.PORT, listenHost, onListening)
        : app.listen(env.PORT, onListening);

    server.on("error", (error) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EADDRINUSE"
      ) {
        logger.error(
          `Port ${env.PORT} is already in use. Another Pint Path dev server is probably still running. Stop it with Ctrl+C in the old terminal, or run lsof -nP -iTCP:${env.PORT} -sTCP:LISTEN to find the process.`,
          getDeployMeta(),
        );
        process.exit(1);
      }

      logger.error("Server failed to start", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
    server.on("close", () => {
      logger.warn("Server closed", getDeployMeta());
    });
  } catch (error) {
    console.error("Application boot failed", {
      error: error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error)),
      stack: error instanceof Error ? redactSecrets(error.stack) : undefined,
    });
    process.exit(1);
  }
}

void boot();

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info("Shutting down server", { signal });

  if (!server) {
    await shutdownServices().catch(() => undefined);
    process.exit(0);
  }

  server.close(async () => {
    try {
      await shutdownServices();
      process.exit(0);
    } catch (error) {
      console.error("Application service shutdown failed", {
        error: error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error)),
      });
      process.exit(1);
    }
  });

  setTimeout(() => {
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", redactSecrets({
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }));
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection", redactSecrets({
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  }));
  process.exit(1);
});
process.on("exit", (code) => {
  console.info("Process exiting", { code, ...getDeployMeta() });
});
