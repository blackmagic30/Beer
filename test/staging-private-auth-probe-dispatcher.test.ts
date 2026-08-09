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
const deploymentId = "235d6994-7bd4-4a13-b1dc-f255775d5dc0";

function dispatcherEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    RAILWAY_DEPLOYMENT_ID: deploymentId,
    STAGING_AUTH_PROBE_RAILWAY_CONFIG_PATH,
    STAGING_AUTH_PROBE_MODE: "build-only",
    STAGING_AUTH_PROBE_TARGET: "all",
    ...overrides,
  };
}

function watcherProgress(
  target: "all" | "postgres-admin" | "postgres-runtime" | "redis",
  progressDeploymentId = deploymentId,
): string {
  return `${JSON.stringify({
    schemaVersion: "staging-private-auth-probe-progress/v1",
    deploymentId: progressDeploymentId,
    mode: "watch-old-rejection",
    target,
    event: "watcher-armed",
    outcome: "accepted",
  })}\n`;
}

function delegatedReceipt(input: {
  mode:
    | "watch-old-rejection"
    | "provision-runtime-candidate"
    | "verify-current"
    | "retire-old-runtime";
  target: "all" | "postgres-admin" | "postgres-runtime" | "redis";
  outcome: "passed" | "failed" | "inconclusive";
  receiptDeploymentId?: string;
}): string {
  return `${JSON.stringify({
    schemaVersion: "staging-private-auth-probe/v1",
    timestamp: "2026-08-09T10:11:12.000Z",
    deploymentId: input.receiptDeploymentId ?? deploymentId,
    mode: input.mode,
    target: input.target,
    outcome: input.outcome,
    identity: {
      project: true,
      environment: true,
      service: true,
      deployment: true,
      debugLoggingDisabled: true,
      postgresResource: true,
      redisResource: true,
      postgresAdminTarget: true,
      postgresRuntimeTarget: true,
      redisTarget: true,
      postgresAdminLogin: true,
      postgresRuntimeLogin: true,
      redisLogin: true,
      postgresCredentialsDistinct: true,
      providerCredentialsDistinct: true,
      postgresClient17: true,
      runtimeCandidateDistinct: true,
      runtimeCandidateSecretDistinct: true,
      runtimeCandidateOwnerSecretValid: true,
      retiredRuntimeDistinct: true,
    },
    checks: {
      postgresAdminAuth: "not-run",
      postgresRuntimeAuth: "not-run",
      redisAuth: "not-run",
      postgresAdminTransition: "not-run",
      postgresRuntimeTransition: "not-run",
      redisTransition: "not-run",
      runtimeHandoff: "not-run",
      runtimeReadiness: "not-run",
      runtimeMutation: "not-run",
    },
  })}\n`;
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
    expect(dedicated).toContain("restartPolicyMaxRetries = 1");
    expect(dedicated).not.toContain("restartPolicyMaxRetries = 0");
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
    const terminal = delegatedReceipt({
      mode: "verify-current",
      target: "redis",
      outcome: "passed",
    });
    const runProbe = vi.fn(async (_mode, _target, writeOutput) => {
      writeOutput(terminal);
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
    expect(output).toEqual([terminal]);
  });

  it("validates and streams watcher arming before probe completion", async () => {
    const output: string[] = [];
    const progress = watcherProgress("postgres-runtime");
    const terminal = delegatedReceipt({
      mode: "watch-old-rejection",
      target: "postgres-runtime",
      outcome: "passed",
    });
    let forwardedBeforeCompletion = false;

    const exitCode = await runStagingPrivateAuthProbeDispatcher({
      argv: [],
      env: dispatcherEnvironment({
        STAGING_AUTH_PROBE_MODE: "watch-old-rejection",
        STAGING_AUTH_PROBE_TARGET: "postgres-runtime",
      }),
      runProbe: async (_mode, _target, writeOutput) => {
        writeOutput(progress);
        forwardedBeforeCompletion =
          output.length === 1 && output[0] === progress;
        await Promise.resolve();
        writeOutput(terminal);
        return 0;
      },
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(0);
    expect(forwardedBeforeCompletion).toBe(true);
    expect(output).toEqual([progress, terminal]);
  });

  it.each([
    { context: "without progress", mode: "verify-current" as const },
    { context: "after progress", mode: "watch-old-rejection" as const },
  ])(
    "rejects and does not leak an extra terminal field $context",
    async ({ mode }) => {
      const output: string[] = [];
      const sensitiveValue = "terminal-secret-must-not-be-forwarded";
      const canonical = delegatedReceipt({
        mode,
        target: "redis",
        outcome: "passed",
      });
      const terminalWithExtraField = `${JSON.stringify({
        ...(JSON.parse(canonical) as Record<string, unknown>),
        unexpected: sensitiveValue,
      })}\n`;

      const exitCode = await runStagingPrivateAuthProbeDispatcher({
        argv: [],
        env: dispatcherEnvironment({
          STAGING_AUTH_PROBE_MODE: mode,
          STAGING_AUTH_PROBE_TARGET: "redis",
        }),
        runProbe: async (_mode, _target, writeOutput) => {
          if (mode === "watch-old-rejection")
            writeOutput(watcherProgress("redis"));
          writeOutput(terminalWithExtraField);
          return 0;
        },
        writeOutput: (value) => output.push(value),
      });

      expect(exitCode).toBe(1);
      expect(JSON.parse(output.at(-1)!)).toMatchObject({
        schemaVersion: "staging-private-auth-probe-dispatcher/v1",
        mode: "invalid",
        outcome: "failed",
      });
      expect(output.join("")).not.toContain(sensitiveValue);
    },
  );

  it.each([
    { context: "without progress", mode: "verify-current" as const },
    { context: "after progress", mode: "watch-old-rejection" as const },
  ])("rejects a noncanonical terminal $context", async ({ mode }) => {
    const output: string[] = [];
    const noncanonicalTerminal = ` ${delegatedReceipt({
      mode,
      target: "redis",
      outcome: "passed",
    })}`;

    const exitCode = await runStagingPrivateAuthProbeDispatcher({
      argv: [],
      env: dispatcherEnvironment({
        STAGING_AUTH_PROBE_MODE: mode,
        STAGING_AUTH_PROBE_TARGET: "redis",
      }),
      runProbe: async (_mode, _target, writeOutput) => {
        if (mode === "watch-old-rejection")
          writeOutput(watcherProgress("redis"));
        writeOutput(noncanonicalTerminal);
        return 0;
      },
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      schemaVersion: "staging-private-auth-probe-dispatcher/v1",
      mode: "invalid",
      outcome: "failed",
    });
    expect(output).not.toContain(noncanonicalTerminal);
  });

  it("fails closed on duplicate watcher progress after streaming it once", async () => {
    const output: string[] = [];
    const progress = watcherProgress("redis");
    const exitCode = await runStagingPrivateAuthProbeDispatcher({
      argv: [],
      env: dispatcherEnvironment({
        STAGING_AUTH_PROBE_MODE: "watch-old-rejection",
        STAGING_AUTH_PROBE_TARGET: "redis",
      }),
      runProbe: async (_mode, _target, writeOutput) => {
        writeOutput(progress);
        writeOutput(progress);
        writeOutput(
          delegatedReceipt({
            mode: "watch-old-rejection",
            target: "redis",
            outcome: "passed",
          }),
        );
        return 0;
      },
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(output).toHaveLength(2);
    expect(output[0]).toBe(progress);
    expect(JSON.parse(output[1]!)).toMatchObject({
      schemaVersion: "staging-private-auth-probe-dispatcher/v1",
      mode: "invalid",
      outcome: "failed",
    });
  });

  it("fails closed when watcher progress arrives after the terminal receipt", async () => {
    const output: string[] = [];
    const exitCode = await runStagingPrivateAuthProbeDispatcher({
      argv: [],
      env: dispatcherEnvironment({
        STAGING_AUTH_PROBE_MODE: "watch-old-rejection",
        STAGING_AUTH_PROBE_TARGET: "redis",
      }),
      runProbe: async (_mode, _target, writeOutput) => {
        writeOutput(
          delegatedReceipt({
            mode: "watch-old-rejection",
            target: "redis",
            outcome: "passed",
          }),
        );
        writeOutput(watcherProgress("redis"));
        return 0;
      },
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(parseOnlyOutput(output)).toMatchObject({
      schemaVersion: "staging-private-auth-probe-dispatcher/v1",
      mode: "invalid",
      outcome: "failed",
    });
  });

  it("does not forward malformed watcher progress or its extra data", async () => {
    const output: string[] = [];
    const sensitiveValue = "must-not-be-forwarded";
    const exitCode = await runStagingPrivateAuthProbeDispatcher({
      argv: [],
      env: dispatcherEnvironment({
        STAGING_AUTH_PROBE_MODE: "watch-old-rejection",
        STAGING_AUTH_PROBE_TARGET: "redis",
      }),
      runProbe: async (_mode, _target, writeOutput) => {
        writeOutput(
          `${JSON.stringify({
            schemaVersion: "staging-private-auth-probe-progress/v1",
            deploymentId,
            mode: "watch-old-rejection",
            target: "redis",
            event: "watcher-armed",
            outcome: "accepted",
            unexpected: sensitiveValue,
          })}\n`,
        );
        writeOutput(
          delegatedReceipt({
            mode: "watch-old-rejection",
            target: "redis",
            outcome: "passed",
          }),
        );
        return 0;
      },
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(parseOnlyOutput(output)).toMatchObject({
      schemaVersion: "staging-private-auth-probe-dispatcher/v1",
      mode: "invalid",
      outcome: "failed",
    });
    expect(output.join("")).not.toContain(sensitiveValue);
  });

  it.each([
    {
      name: "the wrong deployment",
      progress: watcherProgress(
        "redis",
        "435d6994-7bd4-4a13-b1dc-f255775d5dc0",
      ),
      terminal: delegatedReceipt({
        mode: "watch-old-rejection",
        target: "redis",
        outcome: "passed",
      }),
      exitCode: 0 as const,
    },
    {
      name: "a failed terminal outcome after arming",
      progress: watcherProgress("redis"),
      terminal: delegatedReceipt({
        mode: "watch-old-rejection",
        target: "redis",
        outcome: "failed",
      }),
      exitCode: 1 as const,
    },
  ])("fails closed on progress contradicting $name", async (fixture) => {
    const output: string[] = [];
    const exitCode = await runStagingPrivateAuthProbeDispatcher({
      argv: [],
      env: dispatcherEnvironment({
        STAGING_AUTH_PROBE_MODE: "watch-old-rejection",
        STAGING_AUTH_PROBE_TARGET: "redis",
      }),
      runProbe: async (_mode, _target, writeOutput) => {
        writeOutput(fixture.progress);
        writeOutput(fixture.terminal);
        return fixture.exitCode;
      },
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      schemaVersion: "staging-private-auth-probe-dispatcher/v1",
      mode: "invalid",
      outcome: "failed",
    });
  });

  it.each([
    "provision-runtime-candidate",
    "verify-current",
    "retire-old-runtime",
  ] as const)("rejects progress from non-watcher mode %s", async (mode) => {
    const output: string[] = [];
    const exitCode = await runStagingPrivateAuthProbeDispatcher({
      argv: [],
      env: dispatcherEnvironment({
        STAGING_AUTH_PROBE_MODE: mode,
        STAGING_AUTH_PROBE_TARGET: "redis",
      }),
      runProbe: async (_mode, _target, writeOutput) => {
        writeOutput(watcherProgress("redis"));
        writeOutput(
          delegatedReceipt({
            mode,
            target: "redis",
            outcome: "passed",
          }),
        );
        return 0;
      },
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(parseOnlyOutput(output)).toMatchObject({
      schemaVersion: "staging-private-auth-probe-dispatcher/v1",
      mode: "invalid",
      outcome: "failed",
    });
  });

  it("rejects a passed watcher receipt when no arming progress preceded it", async () => {
    const output: string[] = [];
    const exitCode = await runStagingPrivateAuthProbeDispatcher({
      argv: [],
      env: dispatcherEnvironment({
        STAGING_AUTH_PROBE_MODE: "watch-old-rejection",
        STAGING_AUTH_PROBE_TARGET: "redis",
      }),
      runProbe: async (_mode, _target, writeOutput) => {
        writeOutput(
          delegatedReceipt({
            mode: "watch-old-rejection",
            target: "redis",
            outcome: "passed",
          }),
        );
        return 0;
      },
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(parseOnlyOutput(output)).toMatchObject({
      schemaVersion: "staging-private-auth-probe-dispatcher/v1",
      mode: "invalid",
      outcome: "failed",
    });
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
            delegatedReceipt({
              mode: "verify-current",
              target: "redis",
              outcome,
            }),
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
