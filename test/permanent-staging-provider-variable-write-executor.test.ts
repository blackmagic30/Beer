import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_NAMES,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_BLOCKED_RECEIPT,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_SCHEMA,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATION,
  parsePermanentStagingProviderVariableWritePolicy,
  runPermanentStagingProviderVariableWriteExecutor,
} from "../scripts/lib/permanent-staging-provider-variable-write-executor.js";

function policyObject(): Record<string, unknown> {
  return JSON.parse(
    PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE,
  ) as Record<string, unknown>;
}

function policySource(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("permanent staging provider-variable write executor", () => {
  it("pins one hard-disabled target, CLI identity, and four-name allowlist", () => {
    const lock = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK;
    expect(PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE).toBe(
      "HARD_DISABLED_REVIEW_REQUIRED",
    );
    expect(lock).toMatchObject({
      projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
      productionEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
      stagingEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
      serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
      railwayCli: {
        version: "5.32.0",
        absolutePath: "/opt/homebrew/Cellar/railway/5.32.0/bin/railway",
        sha256:
          "26e3e0fd2b59fd9f7b1e891cbc8f3ca9b0266556545f00ba4db3ce754fbc10d1",
      },
      writeContract: {
        stdinOnly: true,
        skipDeploys: true,
        maximumValueBytes: 4096,
        expectedIsSealed: false,
        expectedReferences: [],
      },
    });
    expect(PERMANENT_STAGING_PROVIDER_VARIABLE_NAMES).toEqual([
      "GOOGLE_MAPS_API_KEY",
      "GOOGLE_MAPS_MAP_ID",
      "GOOGLE_PLACES_API_KEY",
      "OPENAI_API_KEY",
    ]);
    expect(Object.isFrozen(lock)).toBe(true);
    expect(Object.isFrozen(lock.railwayCli)).toBe(true);
    expect(Object.isFrozen(lock.writeContract)).toBe(true);
    expect(Object.isFrozen(PERMANENT_STAGING_PROVIDER_VARIABLE_NAMES)).toBe(true);
  });

  it("accepts only the exact canonical checked-in policy bytes", () => {
    const checkedIn = fs.readFileSync(
      path.resolve(
        "ops/railway/permanent-staging-provider-variable-write-policy.json",
      ),
      "utf8",
    );
    expect(checkedIn).toBe(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE,
    );
    const parsed = parsePermanentStagingProviderVariableWritePolicy(checkedIn);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!)).toEqual([
      "schemaVersion",
      "policyId",
      "activationState",
      "projectId",
      "productionEnvironmentId",
      "stagingEnvironmentId",
      "serviceId",
      "allowedVariableNames",
      "railwayCli",
      "writeContract",
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed!.railwayCli)).toBe(true);
    expect(Object.isFrozen(parsed!.writeContract)).toBe(true);
    expect(Object.isFrozen(parsed!.allowedVariableNames)).toBe(true);
  });

  it.each([
    ["missing final newline", () =>
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE
        .trimEnd()],
    ["an extra final newline", () =>
      `${PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE}\n`],
    ["minified JSON", () => JSON.stringify(policyObject())],
    ["reordered top-level keys", () => {
      const value = policyObject();
      return policySource({
        policyId: value.policyId,
        schemaVersion: value.schemaVersion,
        activationState: value.activationState,
        projectId: value.projectId,
        productionEnvironmentId: value.productionEnvironmentId,
        stagingEnvironmentId: value.stagingEnvironmentId,
        serviceId: value.serviceId,
        allowedVariableNames: value.allowedVariableNames,
        railwayCli: value.railwayCli,
        writeContract: value.writeContract,
      });
    }],
    ["an unknown top-level key", () => policySource({
      ...policyObject(),
      unknown: true,
    })],
    ["an unknown nested key", () => {
      const value = policyObject();
      return policySource({
        ...value,
        railwayCli: {
          ...(value.railwayCli as Record<string, unknown>),
          unknown: true,
        },
      });
    }],
    ["a reordered allowlist", () => policySource({
      ...policyObject(),
      allowedVariableNames: [
        "GOOGLE_MAPS_MAP_ID",
        "GOOGLE_MAPS_API_KEY",
        "GOOGLE_PLACES_API_KEY",
        "OPENAI_API_KEY",
      ],
    })],
    ["a duplicate allowlist entry", () => policySource({
      ...policyObject(),
      allowedVariableNames: [
        "GOOGLE_MAPS_API_KEY",
        "GOOGLE_MAPS_API_KEY",
        "GOOGLE_PLACES_API_KEY",
        "OPENAI_API_KEY",
      ],
    })],
    ["malformed JSON", () => "{"],
    ["an array document", () => "[]\n"],
  ])("rejects %s", (_label, source) => {
    expect(parsePermanentStagingProviderVariableWritePolicy(source())).toBeNull();
  });

  it("rejects duplicate JSON keys before they can collapse", () => {
    const source =
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE.replace(
        '  "policyId":',
        '  "schemaVersion": "pintpath-permanent-staging-provider-variable-write-policy/v1",\n  "policyId":',
      );
    expect(source.match(/"schemaVersion"/g)).toHaveLength(2);
    expect(parsePermanentStagingProviderVariableWritePolicy(source)).toBeNull();
  });

  it("does not coerce objects or invoke accessors while parsing policy", () => {
    const toString = vi.fn(() =>
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE);
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "toString", {
      enumerable: true,
      get: () => {
        throw new Error("accessor must not run");
      },
    });
    expect(parsePermanentStagingProviderVariableWritePolicy(value)).toBeNull();
    expect(parsePermanentStagingProviderVariableWritePolicy({ toString }))
      .toBeNull();
    expect(toString).not.toHaveBeenCalled();
  });

  it("emits one exact canonical blocked receipt and returns one", async () => {
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await expect(runPermanentStagingProviderVariableWriteExecutor()).resolves
        .toBe(1);
    } finally {
      write.mockRestore();
    }
    expect(runPermanentStagingProviderVariableWriteExecutor).toHaveLength(0);
    expect(output).toEqual([
      `${JSON.stringify(PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_BLOCKED_RECEIPT)}\n`,
    ]);
    expect(JSON.parse(output[0]!)).toEqual({
      schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_SCHEMA,
      operation: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATION,
      executorState: "HARD_DISABLED_REVIEW_REQUIRED",
      mode: "framework-disabled",
      outcome: "blocked",
      variableName: null,
      intentSha256: null,
      terminalEvidenceSha256: null,
      checks: {
        frameworkEnabled: false,
        policyExact: false,
        inputHeldAndBound: false,
        localAuthorityExact: false,
        boundaryPreflightExact: false,
        targetPreflightExact: false,
        durableIntentExact: false,
        boundaryReasserted: false,
        writeAttempted: false,
        acknowledgementExact: false,
        postflightAttempted: false,
        boundaryPostflightExact: false,
        targetPostflightExact: false,
        deploymentUnchanged: false,
        terminalEvidenceExact: false,
      },
    });
    expect(Object.isFrozen(PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_BLOCKED_RECEIPT))
      .toBe(true);
    expect(Object.isFrozen(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_BLOCKED_RECEIPT.checks,
    )).toBe(true);
  });

  it("cannot inspect ambient input or injected arguments", async () => {
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const descriptors = Object.fromEntries(
      ["argv", "stdin", "env"].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(process, key)!,
      ]),
    );
    const ambientAccess = vi.fn();
    for (const key of ["argv", "stdin", "env"] as const) {
      Object.defineProperty(process, key, {
        configurable: true,
        enumerable: true,
        get: () => {
          ambientAccess(key);
          throw new Error("ambient access forbidden");
        },
      });
    }
    const dependencyAccess = vi.fn();
    const poison = new Proxy({}, {
      get: () => {
        dependencyAccess();
        throw new Error("dependency access forbidden");
      },
      ownKeys: () => {
        dependencyAccess();
        throw new Error("dependency access forbidden");
      },
    });
    try {
      const invoke = runPermanentStagingProviderVariableWriteExecutor as unknown as
        (...inputs: readonly unknown[]) => Promise<1>;
      await expect(invoke(poison, poison, poison)).resolves.toBe(1);
    } finally {
      for (const key of ["argv", "stdin", "env"] as const) {
        Object.defineProperty(process, key, descriptors[key]!);
      }
      write.mockRestore();
    }
    expect(ambientAccess).not.toHaveBeenCalled();
    expect(dependencyAccess).not.toHaveBeenCalled();
    expect(output).toHaveLength(1);
  });

  it("imports the wrapper without output or exit-code mutation", async () => {
    const before = process.exitCode;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await import(
        "../scripts/execute-permanent-staging-provider-variable-write.js"
      );
    } finally {
      write.mockRestore();
    }
    expect(write).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(before);
  });

  it("executes the wrapper directly with only one blocked stdout line", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import=tsx",
        path.resolve(
          "scripts/execute-permanent-staging-provider-variable-write.ts",
        ),
        "--ignored-argument",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {},
        input: "ignored-input",
        timeout: 20_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `${JSON.stringify(PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_BLOCKED_RECEIPT)}\n`,
    );
  });

  it("contains no provider-capable runtime or secret-bearing surface", () => {
    const core = fs.readFileSync(
      path.resolve(
        "scripts/lib/permanent-staging-provider-variable-write-executor.ts",
      ),
      "utf8",
    );
    const wrapper = fs.readFileSync(
      path.resolve("scripts/execute-permanent-staging-provider-variable-write.ts"),
      "utf8",
    );
    const publicRunner = runPermanentStagingProviderVariableWriteExecutor
      .toString();
    for (const forbidden of [
      "process.argv",
      "process.stdin",
      "process.env",
      "node:fs",
      "node:child_process",
      "fetch(",
      "spawn(",
      "execFile(",
      "variableCollectionUpsert",
      "RAILWAY_TOKEN",
      "RAILWAY_API_TOKEN",
      "evaluatePermanentStagingProviderVariableWriteObservation",
      "Dependencies",
      "dependencies",
    ]) {
      expect(core).not.toContain(forbidden);
      expect(publicRunner).not.toContain(forbidden);
    }
    expect(core).not.toMatch(/^import\s/m);
    expect(core.match(/process\./g)).toHaveLength(1);
    expect(wrapper).not.toContain("process.stdin");
    expect(wrapper).not.toContain("process.env");
    expect(wrapper).not.toContain("node:fs");
    expect(wrapper).not.toContain("node:child_process");
    expect(wrapper).not.toContain("fetch(");
    expect(wrapper).not.toContain("spawn(");
    expect(wrapper.match(/^import\s/mg)).toHaveLength(2);
  });
});
