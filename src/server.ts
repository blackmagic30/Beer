import type { Server } from "node:http";

let server: Server | undefined;
let heartbeatInterval: NodeJS.Timeout | undefined;
let selfCheckInterval: NodeJS.Timeout | undefined;

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

async function boot(): Promise<void> {
  try {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        message: "melb-beer-bot booting",
        meta: getDeployMeta(),
      }),
    );
    const [{ createApp }, { env }, { logger }] = await Promise.all([
      import("./app.js"),
      import("./config/env.js"),
      import("./lib/logger.js"),
    ]);
    const app = createApp();
    const useRailwayBinding = process.env.RAILWAY_ENVIRONMENT_NAME !== undefined;
    const listenHost = useRailwayBinding ? "::" : env.HOST;

    const onListening = () => {
      const address = server?.address();
      logger.info("melb-beer-bot listening", {
        configuredHost: env.HOST ?? "default",
        effectiveHost: listenHost ?? "default",
        railwayBinding: useRailwayBinding,
        port: env.PORT,
        baseUrl: env.PUBLIC_BASE_URL,
        boundAddress:
          typeof address === "object" && address !== null
            ? `${address.address}:${address.port}`
            : String(address ?? "unknown"),
        ...getDeployMeta(),
      });
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

    heartbeatInterval = setInterval(() => {
      const address = server?.address();
      logger.info("melb-beer-bot heartbeat", {
        listening: server?.listening ?? false,
        boundAddress:
          typeof address === "object" && address !== null
            ? `${address.address}:${address.port}`
            : String(address ?? "unknown"),
        ...getDeployMeta(),
      });
    }, 30_000);

    selfCheckInterval = setInterval(async () => {
      const targets = [
        { name: "ipv4", url: `http://127.0.0.1:${env.PORT}/health` },
        { name: "ipv6", url: `http://[::1]:${env.PORT}/health` },
      ];

      for (const target of targets) {
        try {
          const response = await fetch(target.url);
          logger.info("melb-beer-bot self-check", {
            target: target.name,
            status: response.status,
            ok: response.ok,
            ...getDeployMeta(),
          });
        } catch (error) {
          logger.error("melb-beer-bot self-check failed", {
            target: target.name,
            error: error instanceof Error ? error.message : String(error),
            ...getDeployMeta(),
          });
        }
      }
    }, 30_000);

    server.on("error", (error) => {
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
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

void boot();

function shutdown(signal: string): void {
  console.info("Shutting down server", { signal });

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = undefined;
  }

  if (selfCheckInterval) {
    clearInterval(selfCheckInterval);
    selfCheckInterval = undefined;
  }

  if (!server) {
    process.exit(0);
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", error);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection", reason);
});
process.on("exit", (code) => {
  console.info("Process exiting", { code, ...getDeployMeta() });
});
