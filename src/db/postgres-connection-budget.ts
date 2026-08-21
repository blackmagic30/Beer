import type { SqlDatabase } from "./sql-database.js";

export interface PostgresConnectionBudgetInput {
  readonly steadyReplicaCount: number;
  readonly rollingDeploymentGenerationCount: number;
  readonly runtimePoolMaxConnectionsPerProcess: number;
  readonly maintenanceWorkPoolMaxConnectionsPerProcess: number;
  readonly maintenanceReadinessPoolMaxConnectionsPerProcess: number;
  readonly runtimeLoginConnectionLimit: number;
  readonly maintenanceLoginConnectionLimit: number;
}

export interface PostgresConnectionBudget extends PostgresConnectionBudgetInput {
  readonly maxConcurrentAppProcesses: number;
  readonly maintenancePoolMaxConnectionsPerProcess: number;
  readonly rollingRuntimeConnectionBudget: number;
  readonly rollingMaintenanceConnectionBudget: number;
  readonly rollingAppConnectionBudget: number;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`postgres_connection_budget_${name}_invalid`);
  }
}

/**
 * Proves that the per-process pools fit inside the shared LOGIN limits even
 * while one old and one new deployment generation overlap. This is only the
 * application share of the server budget; provider capacity, reserved slots,
 * migrations, backups, and operator sessions remain separate release gates.
 */
export function assertPostgresConnectionBudget(
  input: PostgresConnectionBudgetInput,
): Readonly<PostgresConnectionBudget> {
  for (const [name, value] of Object.entries(input)) {
    requirePositiveInteger(name, value);
  }

  const maxConcurrentAppProcesses = input.steadyReplicaCount
    * input.rollingDeploymentGenerationCount;
  const maintenancePoolMaxConnectionsPerProcess =
    input.maintenanceWorkPoolMaxConnectionsPerProcess
    + input.maintenanceReadinessPoolMaxConnectionsPerProcess;
  const rollingRuntimeConnectionBudget = maxConcurrentAppProcesses
    * input.runtimePoolMaxConnectionsPerProcess;
  const rollingMaintenanceConnectionBudget = maxConcurrentAppProcesses
    * maintenancePoolMaxConnectionsPerProcess;
  if (rollingRuntimeConnectionBudget !== input.runtimeLoginConnectionLimit) {
    throw new Error("postgres_connection_budget_runtime_login_mismatch");
  }
  if (rollingMaintenanceConnectionBudget !== input.maintenanceLoginConnectionLimit) {
    throw new Error("postgres_connection_budget_maintenance_login_mismatch");
  }

  return Object.freeze({
    ...input,
    maxConcurrentAppProcesses,
    maintenancePoolMaxConnectionsPerProcess,
    rollingRuntimeConnectionBudget,
    rollingMaintenanceConnectionBudget,
    rollingAppConnectionBudget:
      rollingRuntimeConnectionBudget + rollingMaintenanceConnectionBudget,
  });
}

export const POSTGRES_CONNECTION_BUDGET = assertPostgresConnectionBudget({
  steadyReplicaCount: 2,
  rollingDeploymentGenerationCount: 2,
  runtimePoolMaxConnectionsPerProcess: 2,
  maintenanceWorkPoolMaxConnectionsPerProcess: 1,
  maintenanceReadinessPoolMaxConnectionsPerProcess: 1,
  runtimeLoginConnectionLimit: 8,
  maintenanceLoginConnectionLimit: 8,
});

export const POSTGRES_LEGACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT = 2;

export type PostgresApplicationPoolLabel =
  | "runtime"
  | "maintenance_work"
  | "maintenance_readiness";

export interface SafePostgresApplicationPoolMetrics {
  readonly label: PostgresApplicationPoolLabel;
  readonly maxConnections: number;
  readonly totalConnections: number;
  readonly idleConnections: number;
  readonly waitingRequests: number;
  readonly capacityWaitEvents: number;
  readonly capacityWaitHighWater: number;
  readonly capacityWaitDurationMs: number;
  readonly connectionCreationHeadroom: number;
  readonly availableConnections: number;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Projects the driver's pool counters into a fixed, credential-free readiness
 * shape. Impossible or over-budget counters fail closed rather than being
 * coerced to zero and accidentally serving as false capacity evidence.
 */
export function inspectPostgresApplicationPoolMetrics(
  database: SqlDatabase,
  label: PostgresApplicationPoolLabel,
  maxConnections: number,
): Readonly<SafePostgresApplicationPoolMetrics> {
  const metrics = database.metrics();
  if (
    database.dialect !== "postgres"
    || metrics.dialect !== "postgres"
    || !Number.isSafeInteger(maxConnections)
    || maxConnections <= 0
    || !isNonNegativeSafeInteger(metrics.totalConnections)
    || !isNonNegativeSafeInteger(metrics.idleConnections)
    || !isNonNegativeSafeInteger(metrics.waitingRequests)
    || !isNonNegativeSafeInteger(metrics.capacityWaitEvents ?? Number.NaN)
    || !isNonNegativeSafeInteger(metrics.capacityWaitHighWater ?? Number.NaN)
    || !isNonNegativeSafeInteger(metrics.capacityWaitDurationMs ?? Number.NaN)
    || metrics.totalConnections > maxConnections
    || metrics.idleConnections > metrics.totalConnections
    || metrics.capacityWaitHighWater! > metrics.capacityWaitEvents!
    || (metrics.capacityWaitEvents === 0 && (
      metrics.capacityWaitHighWater !== 0 || metrics.capacityWaitDurationMs !== 0
    ))
  ) {
    throw new Error("postgres_application_pool_metrics_invalid");
  }

  const connectionCreationHeadroom = maxConnections - metrics.totalConnections;
  return Object.freeze({
    label,
    maxConnections,
    totalConnections: metrics.totalConnections,
    idleConnections: metrics.idleConnections,
    waitingRequests: metrics.waitingRequests,
    capacityWaitEvents: metrics.capacityWaitEvents!,
    capacityWaitHighWater: metrics.capacityWaitHighWater!,
    capacityWaitDurationMs: metrics.capacityWaitDurationMs!,
    connectionCreationHeadroom,
    availableConnections: metrics.idleConnections + connectionCreationHeadroom,
  });
}
