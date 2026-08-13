import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK,
  RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SHA256,
} from "../src/lib/railway-application-deployment-attestation.js";
import {
  PERMANENT_STAGING_APP_DEPLOYMENT_BLOCKED_RECEIPT,
  PERMANENT_STAGING_APP_DEPLOYMENT_CANONICAL_POLICY_SOURCE,
  PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA,
  PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE,
  PERMANENT_STAGING_APP_DEPLOYMENT_LOCK,
  PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION,
  PERMANENT_STAGING_APP_DEPLOYMENT_POLICY_SCHEMA,
  parsePermanentStagingAppDeploymentPolicy,
  runPermanentStagingAppDeploymentExecutor,
} from "../scripts/lib/permanent-staging-app-deployment-executor.js";

function sha256File(filename: string): string {
  return crypto.createHash("sha256")
    .update(fs.readFileSync(path.resolve(filename)))
    .digest("hex");
}

function policyObject(): Record<string, unknown> {
  return JSON.parse(
    PERMANENT_STAGING_APP_DEPLOYMENT_CANONICAL_POLICY_SOURCE,
  ) as Record<string, unknown>;
}

function policySource(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("permanent staging app deployment executor", () => {
  it("pins the exact hard-disabled non-production target and reviewed hashes", () => {
    const lock = PERMANENT_STAGING_APP_DEPLOYMENT_LOCK;
    expect(PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE).toBe(
      "HARD_DISABLED_REVIEW_REQUIRED",
    );
    expect(PERMANENT_STAGING_APP_DEPLOYMENT_POLICY_SCHEMA).toBe(
      "pintpath-permanent-staging-app-deployment-policy/v2",
    );
    expect(PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA).toBe(
      "pintpath-permanent-staging-app-deployment-executor/v2",
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
      sourceContract: {
        railwayConfigSha256:
          "85dc659ebec2e0132092d917505d71678e92b8441b54bcefc80c6a082e3b967b",
        packageLockSha256:
          "0978ac482e875707a478d0d970fbadb899b8448dc21893ddb0973b5e2f700ecf",
      },
      postflightContract: {
        applicationAttestationPolicySha256:
          "b056b175f981d7b51a9590943e209e82a0dfcbea650de7a4cb5ecf37a67bbdd1",
      },
      spendContract: {
        currency: "USD",
        maximumRecurringStagingMonthlyCents: 5_000,
        costPolicyReference: {
          schemaVersion: "pintpath-permanent-staging-cost-policy/v1",
          policyId: "pintpath-permanent-staging-recurring-cost",
          relativePath: "ops/railway/permanent-staging-cost-policy.json",
          sha256:
            "895d5bdcfe0fb05d17b3fa7cab6c525a80f3beacf0ff0cbd1bafdb54c979c8ca",
        },
        preDeploymentCostReceiptRequired: true,
        postDeploymentCostReceiptRequired: true,
        additionalUnapprovedSpendAllowed: false,
      },
    });
    expect(lock.productionEnvironmentId).not.toBe(lock.stagingEnvironmentId);
    expect(lock.projectId).toBe(
      RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK.projectId,
    );
    expect(lock.stagingEnvironmentId).toBe(
      RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK
        .stagingEnvironmentId,
    );
    expect(lock.productionEnvironmentId).toBe(
      RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK
        .forbiddenProductionEnvironmentId,
    );
    expect(lock.serviceId).toBe(
      RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_LOCK.serviceId,
    );
    expect(lock.postflightContract.applicationAttestationPolicySha256).toBe(
      RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SHA256,
    );
    expect(sha256File("railway.toml")).toBe(
      lock.sourceContract.railwayConfigSha256,
    );
    expect(sha256File("package-lock.json")).toBe(
      lock.sourceContract.packageLockSha256,
    );
    expect(sha256File(
      "ops/railway/permanent-staging-app-deployment-attestation-policy.json",
    )).toBe(lock.postflightContract.applicationAttestationPolicySha256);
    expect(sha256File(lock.spendContract.costPolicyReference.relativePath))
      .toBe(lock.spendContract.costPolicyReference.sha256);
    expect(Object.isFrozen(lock)).toBe(true);
    expect(Object.isFrozen(lock.writeContract)).toBe(true);
    expect(Object.isFrozen(lock.postflightContract.requiredRuntimeRoutes))
      .toBe(true);
    expect(Object.isFrozen(lock.spendContract.costPolicyReference)).toBe(true);
  });

  it("forbids every adjacent Railway mutation and any unapproved spend", () => {
    expect(PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.writeContract).toEqual({
      mode: "single-source-upload",
      transportImplemented: false,
      providerNetworkAllowed: false,
      maximumWriteAttempts: 1,
      sequentialNotAtomic: true,
      externalMutationFreezeRequired: true,
      autoDeployAllowed: false,
      fromSourceAllowed: false,
      redeployAllowed: false,
      nativeRollbackAllowed: false,
      scaleAllowed: false,
      domainMutationAllowed: false,
      routeMutationAllowed: false,
      pitrMutationAllowed: false,
      deleteAllowed: false,
      variableMutationAllowed: false,
      volumeMutationAllowed: false,
      resourceCreationAllowed: false,
    });
    expect(PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.spendContract)
      .toMatchObject({
        currency: "USD",
        maximumRecurringStagingMonthlyCents: 5_000,
        preDeploymentCostReceiptRequired: true,
        postDeploymentCostReceiptRequired: true,
        additionalUnapprovedSpendAllowed: false,
      });
    expect(PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.spendContract)
      .not.toHaveProperty("reviewedRecurringStagingMonthlyUsd");
    expect(PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.spendContract)
      .not.toHaveProperty("maximumStagingMonthlyUsd");
  });

  it("accepts only the exact canonical checked-in policy bytes", () => {
    const checkedIn = fs.readFileSync(path.resolve(
      "ops/railway/permanent-staging-app-deployment-policy.json",
    ), "utf8");
    expect(checkedIn).toBe(
      PERMANENT_STAGING_APP_DEPLOYMENT_CANONICAL_POLICY_SOURCE,
    );
    const parsed = parsePermanentStagingAppDeploymentPolicy(checkedIn);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!)).toEqual([
      "schemaVersion",
      "policyId",
      "activationState",
      "projectId",
      "productionEnvironmentId",
      "stagingEnvironmentId",
      "serviceId",
      "railwayCli",
      "sourceContract",
      "writeContract",
      "postflightContract",
      "spendContract",
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed!.railwayCli)).toBe(true);
    expect(Object.isFrozen(parsed!.sourceContract)).toBe(true);
    expect(Object.isFrozen(parsed!.writeContract)).toBe(true);
    expect(Object.isFrozen(parsed!.postflightContract)).toBe(true);
    expect(Object.isFrozen(parsed!.spendContract)).toBe(true);
    expect(Object.isFrozen(parsed!.spendContract.costPolicyReference)).toBe(true);
  });

  it.each([
    ["missing final newline", () =>
      PERMANENT_STAGING_APP_DEPLOYMENT_CANONICAL_POLICY_SOURCE.trimEnd()],
    ["an extra final newline", () =>
      `${PERMANENT_STAGING_APP_DEPLOYMENT_CANONICAL_POLICY_SOURCE}\n`],
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
        railwayCli: value.railwayCli,
        sourceContract: value.sourceContract,
        writeContract: value.writeContract,
        postflightContract: value.postflightContract,
        spendContract: value.spendContract,
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
        writeContract: {
          ...(value.writeContract as Record<string, unknown>),
          unknown: true,
        },
      });
    }],
    ["malformed JSON", () => "{"],
    ["an array document", () => "[]\n"],
  ])("rejects %s", (_label, source) => {
    expect(parsePermanentStagingAppDeploymentPolicy(source())).toBeNull();
  });

  it("rejects duplicate JSON keys before they can collapse", () => {
    const source = PERMANENT_STAGING_APP_DEPLOYMENT_CANONICAL_POLICY_SOURCE
      .replace(
        '  "policyId":',
        '  "schemaVersion": "pintpath-permanent-staging-app-deployment-policy/v2",\n  "policyId":',
      );
    expect(source.match(/^  "schemaVersion"/gm)).toHaveLength(2);
    expect(parsePermanentStagingAppDeploymentPolicy(source)).toBeNull();
  });

  it("does not coerce objects or invoke accessors while parsing policy", () => {
    const toString = vi.fn(() =>
      PERMANENT_STAGING_APP_DEPLOYMENT_CANONICAL_POLICY_SOURCE);
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "toString", {
      enumerable: true,
      get: () => {
        throw new Error("accessor must not run");
      },
    });
    expect(parsePermanentStagingAppDeploymentPolicy(value)).toBeNull();
    expect(parsePermanentStagingAppDeploymentPolicy({ toString })).toBeNull();
    expect(toString).not.toHaveBeenCalled();
  });

  it("emits one exact canonical blocked receipt and returns one", async () => {
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await expect(runPermanentStagingAppDeploymentExecutor()).resolves.toBe(1);
    } finally {
      write.mockRestore();
    }
    expect(runPermanentStagingAppDeploymentExecutor).toHaveLength(0);
    expect(output).toEqual([
      `${JSON.stringify(PERMANENT_STAGING_APP_DEPLOYMENT_BLOCKED_RECEIPT)}\n`,
    ]);
    expect(JSON.parse(output[0]!)).toEqual({
      schemaVersion: PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA,
      operation: PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION,
      executorState: "HARD_DISABLED_REVIEW_REQUIRED",
      mode: "framework-disabled",
      outcome: "blocked",
      candidateSha: null,
      previousDeploymentIdSha256: null,
      deploymentIdSha256: null,
      intentSha256: null,
      attestationFileSha256: null,
      terminalEvidenceSha256: null,
      checks: {
        frameworkEnabled: false,
        policyExact: false,
        authorizationExact: false,
        localSourceAuthorityExact: false,
        boundaryPreflightExact: false,
        targetPreflightExact: false,
        preDeploymentCostReceiptExact: false,
        costCeilingMaintained: false,
        durableIntentExact: false,
        localAuthorityReasserted: false,
        boundaryReasserted: false,
        writeAttempted: false,
        acknowledgementExact: false,
        postflightAttempted: false,
        boundaryPostflightExact: false,
        targetPostflightExact: false,
        postDeploymentCostReceiptExact: false,
        runtimeAttestationExact: false,
        collateralStateUnchanged: false,
        terminalEvidenceExact: false,
        finalizationExact: false,
      },
    });
    expect(Object.isFrozen(PERMANENT_STAGING_APP_DEPLOYMENT_BLOCKED_RECEIPT))
      .toBe(true);
    expect(Object.isFrozen(
      PERMANENT_STAGING_APP_DEPLOYMENT_BLOCKED_RECEIPT.checks,
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
      const invoke = runPermanentStagingAppDeploymentExecutor as unknown as
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
      await import("../scripts/execute-permanent-staging-app-deployment.js");
    } finally {
      write.mockRestore();
    }
    expect(write).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(before);
  });

  it("contains no provider-capable or secret-bearing runtime surface", () => {
    const core = fs.readFileSync(path.resolve(
      "scripts/lib/permanent-staging-app-deployment-executor.ts",
    ), "utf8");
    const wrapper = fs.readFileSync(path.resolve(
      "scripts/execute-permanent-staging-app-deployment.ts",
    ), "utf8");
    const publicRunner = runPermanentStagingAppDeploymentExecutor.toString();
    for (const forbidden of [
      "process.argv",
      "process.stdin",
      "process.env",
      "node:fs",
      "node:child_process",
      "fetch(",
      "spawn(",
      "execFile(",
      "serviceInstanceDeploy",
      "deploymentRollback",
      "railway up",
      "railway scale",
      "railway domain",
      "railway delete",
      "Project-Access-Token",
      "RAILWAY_API_TOKEN",
      "RAILWAY_TOKEN",
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
