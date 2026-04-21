let server:
  | {
      close(callback?: (error?: Error) => void): void;
      on(event: "error", listener: (error: Error) => void): void;
    }
  | undefined;
let heartbeatInterval: NodeJS.Timeout | undefined;

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
    server = app.listen(env.PORT, env.HOST, () => {
      logger.info("melb-beer-bot listening", {
        host: env.HOST,
        port: env.PORT,
        baseUrl: env.PUBLIC_BASE_URL,
        ...getDeployMeta(),
      });
    });

    heartbeatInterval = setInterval(() => {
      logger.info("melb-beer-bot heartbeat", getDeployMeta());
    }, 30_000);

    server.on("error", (error) => {
      logger.error("Server failed to start", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
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
