import type { Server } from "node:http";
import { networkInterfaces } from "node:os";

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

function getBoundAddress(): string {
  const address = server?.address();
  return typeof address === "object" && address !== null
    ? `${address.address}:${address.port}`
    : String(address ?? "unknown");
}

function getNetworkTargets(port: number): Array<{ name: string; url: string }> {
  const targets: Array<{ name: string; url: string }> = [
    { name: "loopback-ipv4", url: `http://127.0.0.1:${port}/health` },
    { name: "loopback-ipv6", url: `http://[::1]:${port}/health` },
  ];

  const interfaces = networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) {
        continue;
      }

      if (entry.family === "IPv4") {
        targets.push({
          name: `${name}-ipv4-${entry.address}`,
          url: `http://${entry.address}:${port}/health`,
        });
      } else if (entry.family === "IPv6") {
        targets.push({
          name: `${name}-ipv6-${entry.address}`,
          url: `http://[${entry.address}]:${port}/health`,
        });
      }
    }
  }

  return targets;
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
      logger.info(
        `melb-beer-bot listening host=${env.HOST ?? "default"} effectiveHost=${listenHost ?? "default"} railwayBinding=${useRailwayBinding} port=${env.PORT} bound=${getBoundAddress()}`,
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

    heartbeatInterval = setInterval(() => {
      logger.info(
        `melb-beer-bot heartbeat listening=${server?.listening ?? false} bound=${getBoundAddress()}`,
        getDeployMeta(),
      );
    }, 30_000);

    selfCheckInterval = setInterval(async () => {
      for (const target of getNetworkTargets(env.PORT)) {
        try {
          const response = await fetch(target.url);
          logger.info(
            `melb-beer-bot self-check target=${target.name} status=${response.status} ok=${response.ok}`,
            getDeployMeta(),
          );
        } catch (error) {
          logger.error(
            `melb-beer-bot self-check target=${target.name} failed=${error instanceof Error ? error.message : String(error)}`,
            getDeployMeta(),
          );
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
