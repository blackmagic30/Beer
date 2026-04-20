import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";

const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info("melb-beer-bot listening", {
    port: env.PORT,
    baseUrl: env.PUBLIC_BASE_URL,
  });
});

function shutdown(signal: string): void {
  logger.info("Shutting down server", { signal });

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
