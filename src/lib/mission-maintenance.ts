import { logger } from "./logger.js";
import { redactSecrets } from "./redact.js";

export type MissionMaintenanceTrigger = "startup" | "interval" | "manual";

export type MissionMaintenanceStatus<TResult> =
  | {
      state: "running";
      trigger: MissionMaintenanceTrigger;
      startedAt: string;
      completedAt: null;
    }
  | {
      state: "succeeded";
      trigger: MissionMaintenanceTrigger;
      startedAt: string;
      completedAt: string;
      result: TResult;
    }
  | {
      state: "failed";
      trigger: MissionMaintenanceTrigger;
      startedAt: string;
      completedAt: string;
      error: string;
    };

export interface MissionMaintenanceSchedulerConfig<TResult> {
  run: () => TResult | Promise<TResult>;
  intervalMinutes: number;
  onStatus?: ((status: MissionMaintenanceStatus<TResult>) => void) | undefined;
  now?: (() => Date) | undefined;
}

export interface MissionMaintenanceScheduler {
  stop: () => Promise<void>;
  runNow: () => Promise<void>;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown mission maintenance failure";
  return redactSecrets(message).slice(0, 500);
}

export function scheduleMissionMaintenance<TResult>(
  config: MissionMaintenanceSchedulerConfig<TResult>,
): MissionMaintenanceScheduler {
  if (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes <= 0) {
    throw new Error("Mission maintenance interval must be greater than zero minutes.");
  }

  let stopped = false;
  let activeRun: Promise<void> | null = null;
  const now = () => config.now?.() ?? new Date();
  const report = (status: MissionMaintenanceStatus<TResult>) => {
    try {
      config.onStatus?.(status);
    } catch (error) {
      logger.warn("Mission maintenance status callback failed", {
        error: safeErrorMessage(error),
        maintenanceState: status.state,
      });
    }
  };

  const execute = (trigger: MissionMaintenanceTrigger): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (activeRun) return activeRun;

    const pending = (async () => {
      const startedAt = now().toISOString();
      report({ state: "running", trigger, startedAt, completedAt: null });

      try {
        const result = await config.run();
        const completedAt = now().toISOString();
        report({ state: "succeeded", trigger, startedAt, completedAt, result });
        logger.info("Mission maintenance completed", { trigger, startedAt, completedAt });
      } catch (error) {
        const failure = {
          state: "failed" as const,
          trigger,
          startedAt,
          completedAt: now().toISOString(),
          error: safeErrorMessage(error),
        };
        report(failure);
        logger.error("Mission maintenance failed", failure);
      }
    })();

    activeRun = pending.finally(() => {
      activeRun = null;
    });
    return activeRun;
  };

  const interval = setInterval(
    () => void execute("interval"),
    config.intervalMinutes * 60 * 1000,
  );
  interval.unref();
  void execute("startup");

  return {
    async stop() {
      if (stopped) {
        await activeRun;
        return;
      }
      stopped = true;
      clearInterval(interval);
      await activeRun;
    },
    runNow: () => execute("manual"),
  };
}
