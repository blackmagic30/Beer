import { describe, expect, it } from "vitest";

import {
  assertPostgresConnectionBudget,
  inspectPostgresApplicationPoolMetrics,
  POSTGRES_CONNECTION_BUDGET,
  POSTGRES_LEGACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT,
} from "../src/db/postgres-connection-budget.js";
import type { SqlDatabase, SqlPoolMetrics } from "../src/db/sql-database.js";

function databaseWithPoolMetrics(metrics: SqlPoolMetrics): SqlDatabase {
  return {
    dialect: metrics.dialect,
    prepare: () => ({
      run: async () => ({ changes: 0 }),
      get: async () => undefined,
      all: async () => [],
    }),
    exec: async () => undefined,
    transaction: (work) => async () => work(),
    close: async () => undefined,
    metrics: () => metrics,
  };
}

const safePoolMetrics: SqlPoolMetrics = {
  dialect: "postgres",
  totalConnections: 1,
  idleConnections: 1,
  waitingRequests: 0,
  capacityWaitEvents: 0,
  capacityWaitHighWater: 0,
  capacityWaitDurationMs: 0,
  completedQueries: 23,
  failedQueries: 2,
  transactionFailures: 1,
  lastQueryDurationMs: 12.5,
};

describe("Postgres rolling-deployment connection budget", () => {
  const reviewedInput = {
    steadyReplicaCount: 2,
    rollingDeploymentGenerationCount: 2,
    runtimePoolMaxConnectionsPerProcess: 2,
    maintenanceWorkPoolMaxConnectionsPerProcess: 1,
    maintenanceReadinessPoolMaxConnectionsPerProcess: 1,
    runtimeLoginConnectionLimit: 8,
    maintenanceLoginConnectionLimit: 8,
  } as const;

  it("fits two replicas and two deployment generations inside exact LOGIN limits", () => {
    expect(POSTGRES_CONNECTION_BUDGET).toEqual({
      steadyReplicaCount: 2,
      rollingDeploymentGenerationCount: 2,
      runtimePoolMaxConnectionsPerProcess: 2,
      maintenanceWorkPoolMaxConnectionsPerProcess: 1,
      maintenanceReadinessPoolMaxConnectionsPerProcess: 1,
      runtimeLoginConnectionLimit: 8,
      maintenanceLoginConnectionLimit: 8,
      maxConcurrentAppProcesses: 4,
      maintenancePoolMaxConnectionsPerProcess: 2,
      rollingRuntimeConnectionBudget: 8,
      rollingMaintenanceConnectionBudget: 8,
      rollingAppConnectionBudget: 16,
    });
    expect(POSTGRES_LEGACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT).toBe(2);
  });

  it("rejects pool or role drift instead of overcommitting a shared LOGIN", () => {
    expect(() => assertPostgresConnectionBudget({
      ...reviewedInput,
      runtimePoolMaxConnectionsPerProcess: 3,
    })).toThrow("postgres_connection_budget_runtime_login_mismatch");
    expect(() => assertPostgresConnectionBudget({
      ...reviewedInput,
      maintenanceLoginConnectionLimit: 3,
    })).toThrow("postgres_connection_budget_maintenance_login_mismatch");
    expect(() => assertPostgresConnectionBudget({
      ...reviewedInput,
      steadyReplicaCount: 0,
    })).toThrow("postgres_connection_budget_steadyReplicaCount_invalid");
  });

  it("exposes only fixed labeled pool capacity counters", () => {
    expect(inspectPostgresApplicationPoolMetrics(
      databaseWithPoolMetrics(safePoolMetrics),
      "runtime",
      2,
    )).toEqual({
      label: "runtime",
      maxConnections: 2,
      totalConnections: 1,
      idleConnections: 1,
      waitingRequests: 0,
      capacityWaitEvents: 0,
      capacityWaitHighWater: 0,
      capacityWaitDurationMs: 0,
      connectionCreationHeadroom: 1,
      availableConnections: 2,
    });
    expect(inspectPostgresApplicationPoolMetrics(
      databaseWithPoolMetrics({ ...safePoolMetrics, waitingRequests: 3 }),
      "maintenance_work",
      1,
    )).toEqual({
      label: "maintenance_work",
      maxConnections: 1,
      totalConnections: 1,
      idleConnections: 1,
      waitingRequests: 3,
      capacityWaitEvents: 0,
      capacityWaitHighWater: 0,
      capacityWaitDurationMs: 0,
      connectionCreationHeadroom: 0,
      availableConnections: 1,
    });
  });

  it.each([
    ["non-Postgres metrics", { ...safePoolMetrics, dialect: "sqlite" as const }, 2],
    ["fractional totals", { ...safePoolMetrics, totalConnections: 0.5 }, 2],
    ["negative idle counts", { ...safePoolMetrics, idleConnections: -1 }, 2],
    ["fractional waiter counts", { ...safePoolMetrics, waitingRequests: 0.5 }, 2],
    ["missing monotonic wait evidence", {
      ...safePoolMetrics,
      capacityWaitEvents: undefined,
    }, 2],
    ["impossible wait high-water", {
      ...safePoolMetrics,
      capacityWaitEvents: 1,
      capacityWaitHighWater: 2,
    }, 2],
    ["zero events with nonzero duration", {
      ...safePoolMetrics,
      capacityWaitDurationMs: 1,
    }, 2],
    ["idle counts above total", { ...safePoolMetrics, idleConnections: 2 }, 2],
    ["totals above the configured maximum", { ...safePoolMetrics, totalConnections: 3 }, 2],
    ["an invalid configured maximum", safePoolMetrics, 0],
  ])("rejects %s instead of manufacturing safe evidence", (_label, metrics, maximum) => {
    expect(() => inspectPostgresApplicationPoolMetrics(
      databaseWithPoolMetrics(metrics),
      "runtime",
      maximum,
    )).toThrow("postgres_application_pool_metrics_invalid");
  });
});
