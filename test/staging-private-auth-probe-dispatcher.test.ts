import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  STAGING_AUTH_PROBE_NODE_VERSION,
  STAGING_AUTH_PROBE_PSQL_VERSION,
  STAGING_AUTH_PROBE_RAILWAY_CONFIG_PATH,
  runStagingPrivateAuthProbeDispatcher,
} from "../scripts/staging-private-auth-probe-dispatcher.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

function dispatcherEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    STAGING_AUTH_PROBE_RAILWAY_CONFIG_PATH,
    STAGING_AUTH_PROBE_MODE: "build-only",
    STAGING_AUTH_PROBE_TARGET: "all",
    ...overrides,
  };
}

function parseOnlyOutput(output: string[]): Record<string, unknown> {
  expect(output).toHaveLength(1);
  expect(output[0]!.endsWith("\n")).toBe(true);
  expect(output[0]!.slice(0, -1)).not.toContain("\n");
  return JSON.parse(output[0]!) as Record<string, unknown>;
}

describe("staging private auth probe Railway dispatcher", () => {
  it("uses a dedicated config that cannot inherit the production app lifecycle", () => {
    const dedicated = fs.readFileSync(
      path.join(projectRoot, STAGING_AUTH_PROBE_RAILWAY_CONFIG_PATH.slice(1)),
      "utf8",
    );
    const root = fs.readFileSync(
      path.join(projectRoot, "railway.toml"),
      "utf8",
    );

    expect(dedicated).toContain('[build]\nbuilder = "RAILPACK"');
    expect(dedicated).toContain('buildCommand = "npm run build"');
    expect(dedicated).toContain(
      'startCommand = "node dist/scripts/staging-private-auth-probe-dispatcher.js"',
    );
    expect(dedicated).toContain('restartPolicyType = "NEVER"');
    expect(dedicated).toContain("restartPolicyMaxRetries = 0");
    expect(dedicated).not.toMatch(/preDeployCommand|healthcheck|ON_FAILURE/);
    expect(dedicated).not.toContain("dist/src/server.js");

    expect(root).toContain("preDeployCommand");
    expect(root).toContain("healthcheckPath");
    expect(root).toContain('restartPolicyType = "ON_FAILURE"');
    expect(root).not.toContain("staging-private-auth-probe-dispatcher");
  });

  it("passes build-only with the exact pinned Node and psql versions", async () => {
    const output: string[] = [];
    const runProbe = vi.fn();
    const exitCode = await runStagingPrivateAuthProbeDispatcher({
      argv: [],
      env: dispatcherEnvironment(),
      nodeVersion: STAGING_AUTH_PROBE_NODE_VERSION,
      readPsqlVersion: async () =>
        `psql (PostgreSQL) ${STAGING_AUTH_PROBE_PSQL_VERSION}`,
      runProbe,
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(0);
    expect(runProbe).not.toHaveBeenCalled();
    expect(parseOnlyOutput(output)).toEqual({
      schemaVersion: "staging-private-auth-probe-dispatcher/v1",
      mode: "build-only",
      target: "all",
      outcome: "passed",
      checks: {
        dedicatedRailwayConfig: true,
        node22_23_2: true,
        postgresClient17_10: true,
      },
    });
  });

  it("fails closed with a fixed receipt on any toolchain drift", async () => {
    const output: string[] = [];
    const exitCode = await runStagingPrivateAuthProbeDispatcher({
      argv: [],
      env: dispatcherEnvironment(),
      nodeVersion: "v22.23.1",
      readPsqlVersion: async () => "psql (PostgreSQL) 17.9",
      writeOutput: (value) => output.push(value),
    });
    const receipt = parseOnlyOutput(output);

    expect(exitCode).toBe(1);
    expect(receipt.outcome).toBe("failed");
    expect(receipt.checks).toEqual({
      dedicatedRailwayConfig: true,
      node22_23_2: false,
      postgresClient17_10: false,
    });
    expect(output[0]).not.toContain("v22.23.1");
    expect(output[0]).not.toContain("17.9");
  });

  it("delegates an existing fixed mode without adding output", async () => {
    const output: string[] = [];
    const delegatedReceipt = `${JSON.stringify({
      schemaVersion: "staging-private-auth-probe/v1",
      mode: "verify-current",
      target: "redis",
      outcome: "passed",
    })}\n`;
    const runProbe = vi.fn(async (_mode, _target, writeOutput) => {
      writeOutput(delegatedReceipt);
      return 0 as const;
    });

    const exitCode = await runStagingPrivateAuthProbeDispatcher({
      argv: [],
      env: dispatcherEnvironment({
        STAGING_AUTH_PROBE_MODE: "verify-current",
        STAGING_AUTH_PROBE_TARGET: "redis",
      }),
      runProbe,
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(0);
    expect(runProbe).toHaveBeenCalledWith(
      "verify-current",
      "redis",
      expect.any(Function),
    );
    expect(output).toEqual([delegatedReceipt]);
  });

  it("rejects arguments, invalid controls, and the root-config fallback", async () => {
    for (const overrides of [
      { argv: ["verify-current"], env: dispatcherEnvironment() },
      {
        argv: [],
        env: dispatcherEnvironment({ STAGING_AUTH_PROBE_MODE: "unknown" }),
      },
      {
        argv: [],
        env: dispatcherEnvironment({
          STAGING_AUTH_PROBE_RAILWAY_CONFIG_PATH: "/railway.toml",
        }),
      },
    ]) {
      const output: string[] = [];
      const exitCode = await runStagingPrivateAuthProbeDispatcher({
        ...overrides,
        writeOutput: (value) => output.push(value),
      });
      const receipt = parseOnlyOutput(output);
      expect(exitCode).toBe(1);
      expect(receipt.mode).toBe("invalid");
      expect(receipt.outcome).toBe("failed");
      expect(output[0]).not.toContain("unknown");
      expect(output[0]).not.toContain("railway.toml");
    }
  });

  it("replaces malformed delegated output with one fixed failure receipt", async () => {
    const output: string[] = [];
    const exitCode = await runStagingPrivateAuthProbeDispatcher({
      argv: [],
      env: dispatcherEnvironment({
        STAGING_AUTH_PROBE_MODE: "verify-current",
        STAGING_AUTH_PROBE_TARGET: "all",
      }),
      runProbe: async (_mode, _target, writeOutput) => {
        writeOutput("unexpected output\n");
        writeOutput("second line\n");
        return 0;
      },
      writeOutput: (value) => output.push(value),
    });
    const receipt = parseOnlyOutput(output);

    expect(exitCode).toBe(1);
    expect(receipt).toMatchObject({
      schemaVersion: "staging-private-auth-probe-dispatcher/v1",
      mode: "invalid",
      outcome: "failed",
    });
    expect(output[0]).not.toContain("unexpected output");
  });

  it.each([
    ["passed", 1],
    ["failed", 0],
    ["inconclusive", 0],
  ] as const)(
    "fails closed when a delegated %s receipt contradicts exit code %i",
    async (outcome, delegatedExitCode) => {
      const output: string[] = [];
      const exitCode = await runStagingPrivateAuthProbeDispatcher({
        argv: [],
        env: dispatcherEnvironment({
          STAGING_AUTH_PROBE_MODE: "verify-current",
          STAGING_AUTH_PROBE_TARGET: "redis",
        }),
        runProbe: async (_mode, _target, writeOutput) => {
          writeOutput(
            `${JSON.stringify({
              schemaVersion: "staging-private-auth-probe/v1",
              mode: "verify-current",
              target: "redis",
              outcome,
            })}\n`,
          );
          return delegatedExitCode;
        },
        writeOutput: (value) => output.push(value),
      });

      expect(exitCode).toBe(1);
      expect(parseOnlyOutput(output)).toMatchObject({
        schemaVersion: "staging-private-auth-probe-dispatcher/v1",
        mode: "invalid",
        outcome: "failed",
      });
    },
  );
});
