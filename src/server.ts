import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";

let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;

function boot(): void {
  try {
    const app = createApp();
    server = app.listen(env.PORT, () => {
      logger.info("melb-beer-bot listening", {
        port: env.PORT,
        baseUrl: env.PUBLIC_BASE_URL,
      });
    });

    server.on("error", (error) => {
      logger.error("Server failed to start", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
  } catch (error) {
    logger.error("Application boot failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

boot();

function shutdown(signal: string): void {
  logger.info("Shutting down server", { signal });

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
  logger.error("Uncaught exception", {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
  process.exit(1);
});
