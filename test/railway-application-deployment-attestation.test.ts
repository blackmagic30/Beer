import crypto from "node:crypto";
import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_PROVIDER_RESPONSE_BYTES,
  RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SHA256,
  RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RECEIPT_STATE,
  buildRailwayApplicationDeploymentAttestationReceipt,
  canonicalRailwayApplicationDeploymentAttestationReceipt,
  evaluateRailwayApplicationDeploymentAttestation,
  parseRailwayApplicationDeploymentAttestationEmptyPatchResponse,
  parseRailwayApplicationDeploymentAttestationPolicy,
  parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse,
  parseRailwayApplicationDeploymentAttestationReceipt,
  parseRailwayApplicationDeploymentAttestationRuntimeResponse,
  parseRailwayApplicationDeploymentAttestationTokenScopeResponse,
  railwayApplicationDeploymentAttestationReceiptFreshAt,
  sha256RailwayApplicationDeploymentAttestationReceipt,
  type RailwayApplicationDeploymentAttestationEvaluationInput,
  type RailwayApplicationDeploymentAttestationProviderSnapshot,
  type RailwayApplicationDeploymentAttestationRuntimeResponse,
} from "../src/lib/railway-application-deployment-attestation.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";

const IDS = Object.freeze({
  project: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  environment: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  service: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  serviceInstance: "11111111-1111-4111-8111-111111111111",
  deployment: "22222222-2222-4222-8222-222222222222",
  snapshot: "33333333-3333-4333-8333-333333333333",
  domain: "44444444-4444-4444-8444-444444444444",
  replica: "railway-private-replica-fixture",
} as const);
const CANDIDATE_SHA = "a".repeat(40);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const TARGET_HOST = "pintpath-staging-fixture.up.railway.app";
const TARGET_ORIGIN = `https://${TARGET_HOST}`;
const STARTED_AT = "2026-08-11T00:00:00.000Z";
const COMPLETED_AT = "2026-08-11T00:00:30.000Z";
const POLICY_SOURCE = fs.readFileSync(
  "ops/railway/permanent-staging-app-deployment-attestation-policy.json",
  "utf8",
);

function normalReadyRestoreState(): Record<string, unknown> {
  return {
    enabled: false,
    externalWritesAllowed: true,
    httpMutationRoutesAllowed: true,
    runtimeDatabase: "primary_runtime_database",
    remoteVenueDirectoryEnabled: true,
  };
}

function replaceProperty(
  target: object,
  key: PropertyKey,
  value: unknown,
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (descriptor === undefined) {
      Reflect.deleteProperty(target, key);
    } else {
      Object.defineProperty(target, key, descriptor);
    }
  };
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tokenScopeSource(): string {
  return JSON.stringify({
    data: {
      projectToken: {
        projectId: IDS.project,
        environmentId: IDS.environment,
      },
    },
  });
}

function emptyPatchSource(): string {
  return JSON.stringify({
    data: {
      environment: { id: IDS.environment },
      staged: { environmentId: IDS.environment, patch: {} },
    },
  });
}

function providerSource(
  transform?: (value: Record<string, unknown>) => void,
): string {
  const value: Record<string, unknown> = {
    data: {
      serviceInstance: {
        id: IDS.serviceInstance,
        serviceId: IDS.service,
        environmentId: IDS.environment,
        numReplicas: 1,
        latestDeployment: {
          id: IDS.deployment,
          status: "SUCCESS",
          deploymentStopped: false,
          snapshotId: IDS.snapshot,
        },
        activeDeployments: [{
          id: IDS.deployment,
          status: "SUCCESS",
          deploymentStopped: false,
        }],
        domains: {
          serviceDomains: [{
            id: IDS.domain,
            domain: TARGET_HOST,
            targetPort: 3_000,
          }],
          customDomains: [],
        },
      },
      deployment: {
        id: IDS.deployment,
        projectId: IDS.project,
        environmentId: IDS.environment,
        serviceId: IDS.service,
        snapshotId: IDS.snapshot,
        meta: {
          commitHash: CANDIDATE_SHA,
          imageDigest: IMAGE_DIGEST,
          patchId: null,
          unrelatedProviderMetadata: "discarded-before-evidence",
        },
      },
    },
  };
  transform?.(value);
  return JSON.stringify(value);
}

function runtimeSource(
  route: "/health" | "/startup" | "/ready",
  transform?: (value: Record<string, unknown>) => void,
): string {
  const status = route === "/health"
    ? "ok"
    : route === "/startup"
      ? "startup_ready"
      : "ready";
  const value: Record<string, unknown> = {
    ok: true,
    data: {
      service: "pint-path",
      status,
      deployment: {
        version: "0.1.0",
        commitSha: CANDIDATE_SHA,
        environment: "production",
        projectIdSha256: railwayDeploymentIdentityIdSha256("project", IDS.project),
        environmentIdSha256: railwayDeploymentIdentityIdSha256(
          "environment",
          IDS.environment,
        ),
        serviceIdSha256: railwayDeploymentIdentityIdSha256("service", IDS.service),
        deploymentIdSha256: railwayDeploymentIdentityIdSha256(
          "deployment",
          IDS.deployment,
        ),
        replicaIdSha256: railwayDeploymentIdentityIdSha256("replica", IDS.replica),
      },
      ...(route === "/health" ? {} : { dependencies: { postgres: { ready: true } } }),
    },
  };
  transform?.(value);
  return JSON.stringify(value);
}

function parseFixture() {
  const policy = parseRailwayApplicationDeploymentAttestationPolicy(POLICY_SOURCE);
  const tokenScope = parseRailwayApplicationDeploymentAttestationTokenScopeResponse(
    tokenScopeSource(),
  );
  const patchBefore = parseRailwayApplicationDeploymentAttestationEmptyPatchResponse(
    emptyPatchSource(),
  );
  const providerBefore =
    parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(
      providerSource(),
    );
  const health = parseRailwayApplicationDeploymentAttestationRuntimeResponse(
    "/health",
    runtimeSource("/health"),
  );
  const startup = parseRailwayApplicationDeploymentAttestationRuntimeResponse(
    "/startup",
    runtimeSource("/startup"),
  );
  const ready = parseRailwayApplicationDeploymentAttestationRuntimeResponse(
    "/ready",
    runtimeSource("/ready"),
  );
  expect(policy).not.toBeNull();
  expect(tokenScope).not.toBeNull();
  expect(patchBefore).not.toBeNull();
  expect(providerBefore).not.toBeNull();
  expect(health).not.toBeNull();
  expect(startup).not.toBeNull();
  expect(ready).not.toBeNull();
  return {
    policy: policy!,
    tokenScope: tokenScope!,
    patchBefore: patchBefore!,
    providerBefore: providerBefore!,
    health: health!,
    startup: startup!,
    ready: ready!,
  };
}

function evaluationInput(): RailwayApplicationDeploymentAttestationEvaluationInput {
  const fixture = parseFixture();
  return {
    policy: fixture.policy,
    policySha256: sha256(POLICY_SOURCE),
    candidateSha: CANDIDATE_SHA,
    targetOrigin: TARGET_ORIGIN,
    targetOriginSha256: sha256(TARGET_ORIGIN),
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    queriesReadOnly: true,
    tokenScope: fixture.tokenScope,
    patchBefore: fixture.patchBefore,
    providerBefore: fixture.providerBefore,
    runtime: {
      health: fixture.health,
      startup: fixture.startup,
      ready: fixture.ready,
    },
    patchAfter: fixture.patchBefore,
    providerAfter: fixture.providerBefore,
  };
}

describe("Railway application deployment attestation contract", () => {
  it("strictly parses the fixed policy, token scope, and empty undecrypted patch", () => {
    expect(sha256(POLICY_SOURCE)).toBe(
      RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SHA256,
    );
    const policy = parseRailwayApplicationDeploymentAttestationPolicy(POLICY_SOURCE);
    expect(policy).toMatchObject({
      policyId: "pintpath-permanent-staging-application-deployment-attestation",
      projectId: IDS.project,
      stagingEnvironmentId: IDS.environment,
      serviceId: IDS.service,
      activationAuthorized: false,
      launchBlockerRemoved: false,
    });
    expect(parseRailwayApplicationDeploymentAttestationTokenScopeResponse(
      tokenScopeSource(),
    )).toEqual({ projectId: IDS.project, environmentId: IDS.environment });
    expect(parseRailwayApplicationDeploymentAttestationTokenScopeResponse(
      JSON.stringify({
        data: {
          projectToken: {
            project: { id: IDS.project },
            environment: { id: IDS.environment },
          },
        },
      }),
    )).toBeNull();
    expect(parseRailwayApplicationDeploymentAttestationEmptyPatchResponse(
      emptyPatchSource(),
    )).toEqual({ environmentId: IDS.environment, patchEmpty: true });

    const policyWithExtra = JSON.parse(POLICY_SOURCE) as Record<string, unknown>;
    policyWithExtra.unreviewed = true;
    expect(parseRailwayApplicationDeploymentAttestationPolicy(
      JSON.stringify(policyWithExtra),
    )).toBeNull();
    const wrongTargetPolicy = JSON.parse(POLICY_SOURCE) as Record<string, unknown>;
    wrongTargetPolicy.serviceId = IDS.domain;
    expect(parseRailwayApplicationDeploymentAttestationPolicy(
      JSON.stringify(wrongTargetPolicy),
    )).toBeNull();
    expect(parseRailwayApplicationDeploymentAttestationEmptyPatchResponse(
      JSON.stringify({
        data: {
          environment: { id: IDS.environment },
          staged: { environmentId: IDS.environment, patch: { DATABASE_URL: "redacted" } },
        },
      }),
    )).toBeNull();
    expect(parseRailwayApplicationDeploymentAttestationTokenScopeResponse(
      "x".repeat(RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_PROVIDER_RESPONSE_BYTES + 1),
    )).toBeNull();
  });

  it("normalizes only bounded provider proof and exact non-restore runtime routes", () => {
    const provider = parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(
      providerSource(),
    );
    expect(provider).toMatchObject({
      serviceInstanceId: IDS.serviceInstance,
      serviceId: IDS.service,
      environmentId: IDS.environment,
      numReplicas: 1,
      deployment: {
        id: IDS.deployment,
        commitHash: CANDIDATE_SHA,
        imageDigest: IMAGE_DIGEST,
        patchId: null,
      },
    });
    expect(JSON.stringify(provider)).not.toContain("unrelatedProviderMetadata");

    for (const route of ["/health", "/startup", "/ready"] as const) {
      expect(parseRailwayApplicationDeploymentAttestationRuntimeResponse(
        route,
        runtimeSource(route),
      )).toMatchObject({ route, restoreMarkerPresent: false });
    }

    expect(parseRailwayApplicationDeploymentAttestationRuntimeResponse(
      "/ready",
      runtimeSource("/ready", (value) => {
        const data = value.data as Record<string, unknown>;
        const dependencies = data.dependencies as Record<string, unknown>;
        dependencies.restoreRehearsal = normalReadyRestoreState();
      }),
    )).toMatchObject({ route: "/ready", restoreMarkerPresent: false });

    expect(parseRailwayApplicationDeploymentAttestationRuntimeResponse(
      "/health",
      runtimeSource("/health", (value) => {
        const data = value.data as Record<string, unknown>;
        data.restoreRehearsal = { phase: "active" };
      }),
    )).toBeNull();
    expect(parseRailwayApplicationDeploymentAttestationRuntimeResponse(
      "/ready",
      runtimeSource("/ready", (value) => {
        const data = value.data as Record<string, unknown>;
        const dependencies = data.dependencies as Record<string, unknown>;
        dependencies.restoreRehearsal = {
          ...normalReadyRestoreState(),
          enabled: true,
          externalWritesAllowed: false,
        };
      }),
    )).toBeNull();
    expect(parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(
      providerSource((value) => {
        const data = value.data as Record<string, unknown>;
        const deployment = data.deployment as Record<string, unknown>;
        const meta = deployment.meta as Record<string, unknown>;
        meta.imageDigest = "latest";
      }),
    )).toBeNull();
  });

  it("joins exact provider and runtime identity into a canonical evidence-only receipt", () => {
    const evaluation = evaluateRailwayApplicationDeploymentAttestation(evaluationInput());
    expect(evaluation).not.toBeNull();
    const receipt = buildRailwayApplicationDeploymentAttestationReceipt(evaluation!);
    const canonical = canonicalRailwayApplicationDeploymentAttestationReceipt(receipt);
    const parsed = parseRailwayApplicationDeploymentAttestationReceipt(
      Buffer.from(canonical, "utf8"),
    );

    expect(parsed).toEqual(receipt);
    expect(receipt).toMatchObject({
      state: RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RECEIPT_STATE,
      candidateSha: CANDIDATE_SHA,
      expectedEnvironment: "permanent-staging",
      readOnlyEvidence: true,
      activationAuthorized: false,
      launchBlockerRemoved: false,
      hashes: {
        projectIdSha256: railwayDeploymentIdentityIdSha256("project", IDS.project),
        environmentIdSha256: railwayDeploymentIdentityIdSha256(
          "environment",
          IDS.environment,
        ),
        serviceIdSha256: railwayDeploymentIdentityIdSha256("service", IDS.service),
        deploymentIdSha256: railwayDeploymentIdentityIdSha256(
          "deployment",
          IDS.deployment,
        ),
        targetOriginSha256: sha256(TARGET_ORIGIN),
      },
    });
    expect(Object.values(receipt.checks).every((value) => value === true)).toBe(true);
    expect(receipt.hashes.replicaIdSha256s).toHaveLength(1);
    expect(receipt.hashes.providerSnapshotSha256).toBe(
      sha256(JSON.stringify(evaluationInput().providerBefore)),
    );
    expect(canonical.endsWith("\n")).toBe(true);
    expect(canonical).toBe(`${JSON.stringify(receipt)}\n`);
    expect(sha256RailwayApplicationDeploymentAttestationReceipt(receipt)).toBe(
      sha256(canonical),
    );
    for (const privateValue of [
      ...Object.values(IDS),
      IMAGE_DIGEST,
      TARGET_HOST,
      TARGET_ORIGIN,
      "unrelatedProviderMetadata",
    ]) {
      expect(canonical).not.toContain(privateValue);
    }
  });

  it("rejects provider, deployment, route, replica, origin, and observation drift", () => {
    const base = evaluationInput();
    const differentProvider = structuredClone(
      base.providerBefore,
    ) as RailwayApplicationDeploymentAttestationProviderSnapshot;
    (differentProvider.deployment as { patchId: string | null }).patchId = IDS.domain;
    const differentRuntime = structuredClone(
      base.runtime.ready,
    ) as RailwayApplicationDeploymentAttestationRuntimeResponse;
    (differentRuntime.deployment as { replicaIdSha256: string }).replicaIdSha256 =
      "f".repeat(64);

    expect(evaluateRailwayApplicationDeploymentAttestation({
      ...base,
      providerAfter: differentProvider,
    })).toBeNull();
    expect(evaluateRailwayApplicationDeploymentAttestation({
      ...base,
      providerBefore: differentProvider,
      providerAfter: differentProvider,
    })).toBeNull();
    expect(evaluateRailwayApplicationDeploymentAttestation({
      ...base,
      runtime: { ...base.runtime, ready: differentRuntime },
    })).toBeNull();
    expect(evaluateRailwayApplicationDeploymentAttestation({
      ...base,
      targetOrigin: "https://example.com",
      targetOriginSha256: sha256("https://example.com"),
    })).toBeNull();
    expect(evaluateRailwayApplicationDeploymentAttestation({
      ...base,
      completedAt: "2026-08-11T00:02:01.000Z",
    })).toBeNull();
    expect(evaluateRailwayApplicationDeploymentAttestation({
      ...base,
      policySha256: "f".repeat(64),
    })).toBeNull();
  });

  it("accepts only exact canonical bytes, retained false state, and an explicit fresh clock", () => {
    const evaluation = evaluateRailwayApplicationDeploymentAttestation(evaluationInput());
    const receipt = buildRailwayApplicationDeploymentAttestationReceipt(evaluation!);
    const canonical = canonicalRailwayApplicationDeploymentAttestationReceipt(receipt);

    expect(railwayApplicationDeploymentAttestationReceiptFreshAt(
      receipt,
      new Date(COMPLETED_AT),
    )).toBe(true);
    expect(railwayApplicationDeploymentAttestationReceiptFreshAt(
      receipt,
      new Date("2026-08-11T00:15:30.000Z"),
    )).toBe(true);
    expect(railwayApplicationDeploymentAttestationReceiptFreshAt(
      receipt,
      new Date("2026-08-10T23:59:59.999Z"),
    )).toBe(false);
    expect(railwayApplicationDeploymentAttestationReceiptFreshAt(
      receipt,
      new Date("2026-08-11T00:15:30.001Z"),
    )).toBe(false);
    expect(parseRailwayApplicationDeploymentAttestationReceipt(
      JSON.stringify(receipt),
    )).toBeNull();
    expect(parseRailwayApplicationDeploymentAttestationReceipt(` ${canonical}`)).toBeNull();

    const activated = { ...receipt, activationAuthorized: true };
    expect(parseRailwayApplicationDeploymentAttestationReceipt(
      `${JSON.stringify(activated)}\n`,
    )).toBeNull();
    const falseCheck = {
      ...receipt,
      checks: { ...receipt.checks, providerSnapshotStable: false },
    };
    expect(parseRailwayApplicationDeploymentAttestationReceipt(
      `${JSON.stringify(falseCheck)}\n`,
    )).toBeNull();
    const obsoletePolicy = {
      ...receipt,
      hashes: { ...receipt.hashes, policySha256: "f".repeat(64) },
    };
    expect(parseRailwayApplicationDeploymentAttestationReceipt(
      `${JSON.stringify(obsoletePolicy)}\n`,
    )).toBeNull();
  });

  it("stays fail closed under post-import intrinsic and prototype poisoning", () => {
    const base = evaluationInput();
    const evaluation = evaluateRailwayApplicationDeploymentAttestation(base)!;
    const receipt = buildRailwayApplicationDeploymentAttestationReceipt(evaluation);
    const canonical = canonicalRailwayApplicationDeploymentAttestationReceipt(receipt);
    const expectedReceiptSha256 = sha256(canonical);
    const falseCheckSource = `${JSON.stringify({
      ...receipt,
      checks: { ...receipt.checks, providerSnapshotStable: false },
    })}\n`;
    const invalidCandidateSource = `${JSON.stringify({
      ...receipt,
      candidateSha: "z".repeat(40),
    })}\n`;

    const restoreEvery = replaceProperty(Array.prototype, "every", () => true);
    let falseCheckResult;
    try {
      falseCheckResult = parseRailwayApplicationDeploymentAttestationReceipt(
        falseCheckSource,
      );
    } finally {
      restoreEvery();
    }
    expect(falseCheckResult).toBeNull();

    const providerSetterDriftSource = providerSource((value) => {
      const data = value.data as Record<string, unknown>;
      const serviceInstance = data.serviceInstance as Record<string, unknown>;
      const activeDeployments = serviceInstance.activeDeployments as Array<
        Record<string, unknown>
      >;
      activeDeployments[0]!.id = "99999999-9999-4999-8999-999999999999";
      const domains = serviceInstance.domains as Record<string, unknown>;
      const serviceDomains = domains.serviceDomains as Array<Record<string, unknown>>;
      serviceDomains[0]!.domain = "drift.up.railway.app";
    });
    const pendingRestoreSource = runtimeSource("/ready", (value) => {
      const data = value.data as Record<string, unknown>;
      const dependencies = data.dependencies as Record<string, unknown>;
      dependencies.nested = { activeRestoreExecution: true };
    });
    const numericSetterDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "0",
    );
    let numericSetterCalls = 0;
    Object.defineProperty(Array.prototype, "0", {
      configurable: true,
      set(this: unknown[], incoming: unknown) {
        numericSetterCalls += 1;
        let replacement: unknown = null;
        if (typeof incoming === "object" && incoming !== null) {
          const record = incoming as Record<string, unknown>;
          if (typeof record.status === "string") {
            replacement = { ...record, id: IDS.deployment };
          } else if (typeof record.kind === "string") {
            replacement = { ...record, domain: TARGET_HOST };
          }
        }
        Object.defineProperty(this, "0", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: replacement,
        });
      },
    });
    let providerSetterDrift;
    let pendingRestoreResult;
    try {
      providerSetterDrift =
        parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(
          providerSetterDriftSource,
        );
      pendingRestoreResult =
        parseRailwayApplicationDeploymentAttestationRuntimeResponse(
          "/ready",
          pendingRestoreSource,
        );
    } finally {
      if (numericSetterDescriptor === undefined) {
        Reflect.deleteProperty(Array.prototype, "0");
      } else {
        Object.defineProperty(Array.prototype, "0", numericSetterDescriptor);
      }
    }
    expect(numericSetterCalls).toBe(0);
    expect(providerSetterDrift?.activeDeployments[0]?.id).toBe(
      "99999999-9999-4999-8999-999999999999",
    );
    expect(providerSetterDrift?.domains[0]?.domain).toBe("drift.up.railway.app");
    expect(pendingRestoreResult).toBeNull();
    expect(evaluateRailwayApplicationDeploymentAttestation({
      ...base,
      providerAfter: providerSetterDrift!,
    })).toBeNull();

    const missingCommitHashSource = providerSource((value) => {
      const data = value.data as Record<string, unknown>;
      const deployment = data.deployment as Record<string, unknown>;
      const meta = deployment.meta as Record<string, unknown>;
      Reflect.deleteProperty(meta, "commitHash");
    });
    const restoreInheritedCommitHash = replaceProperty(
      Object.prototype,
      "commitHash",
      CANDIDATE_SHA,
    );
    let inheritedCommitHashResult;
    try {
      inheritedCommitHashResult =
        parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(
          missingCommitHashSource,
        );
    } finally {
      restoreInheritedCommitHash();
    }
    expect(inheritedCommitHashResult).toBeNull();

    const accessorReceipt = { ...receipt };
    Object.defineProperty(accessorReceipt, "candidateSha", {
      configurable: true,
      enumerable: true,
      get: () => CANDIDATE_SHA,
    });
    expect(railwayApplicationDeploymentAttestationReceiptFreshAt(
      accessorReceipt,
      new Date(COMPLETED_AT),
    )).toBe(false);

    const providerAfter = structuredClone(
      base.providerBefore,
    ) as RailwayApplicationDeploymentAttestationProviderSnapshot;
    (providerAfter as { serviceInstanceId: string }).serviceInstanceId =
      "55555555-5555-4555-8555-555555555555";
    const restoreToJson = replaceProperty(
      Object.prototype,
      "toJSON",
      () => ({ attackerControlled: true }),
    );
    let canonicalWithPoisonedToJson: string;
    let providerDriftResult;
    try {
      canonicalWithPoisonedToJson =
        canonicalRailwayApplicationDeploymentAttestationReceipt(receipt);
      providerDriftResult = evaluateRailwayApplicationDeploymentAttestation({
        ...base,
        providerAfter,
      });
    } finally {
      restoreToJson();
    }
    expect(canonicalWithPoisonedToJson!).toBe(canonical);
    expect(providerDriftResult).toBeNull();

    const replicaCountDrift = structuredClone(
      base.providerBefore,
    ) as RailwayApplicationDeploymentAttestationProviderSnapshot;
    (replicaCountDrift as { numReplicas: number }).numReplicas = 2;
    const restoreGlobalString = replaceProperty(globalThis, "String", () => "1");
    let replicaCountDriftResult;
    try {
      replicaCountDriftResult = evaluateRailwayApplicationDeploymentAttestation({
        ...base,
        providerAfter: replicaCountDrift,
      });
    } finally {
      restoreGlobalString();
    }
    expect(replicaCountDriftResult).toBeNull();

    const restoreRegExpExec = replaceProperty(
      RegExp.prototype,
      "exec",
      () => ["attacker-controlled-match"],
    );
    const restoreRegExpTest = replaceProperty(RegExp.prototype, "test", () => true);
    let invalidCandidateResult;
    let validRuntimeResult;
    try {
      invalidCandidateResult = parseRailwayApplicationDeploymentAttestationReceipt(
        invalidCandidateSource,
      );
      validRuntimeResult = parseRailwayApplicationDeploymentAttestationRuntimeResponse(
        "/ready",
        runtimeSource("/ready"),
      );
    } finally {
      restoreRegExpTest();
      restoreRegExpExec();
    }
    expect(invalidCandidateResult).toBeNull();
    expect(validRuntimeResult).not.toBeNull();

    const validTokenObject = JSON.parse(tokenScopeSource()) as Record<string, unknown>;
    const restoreJsonParse = replaceProperty(JSON, "parse", () => validTokenObject);
    const restoreJsonStringify = replaceProperty(
      JSON,
      "stringify",
      () => "\"attacker-controlled\"",
    );
    let invalidTokenResult;
    let canonicalWithPoisonedJson: string;
    try {
      invalidTokenResult =
        parseRailwayApplicationDeploymentAttestationTokenScopeResponse("{}");
      canonicalWithPoisonedJson =
        canonicalRailwayApplicationDeploymentAttestationReceipt(receipt);
    } finally {
      restoreJsonStringify();
      restoreJsonParse();
    }
    expect(invalidTokenResult).toBeNull();
    expect(canonicalWithPoisonedJson!).toBe(canonical);

    const badOriginProvider = structuredClone(
      base.providerBefore,
    ) as RailwayApplicationDeploymentAttestationProviderSnapshot;
    (badOriginProvider.domains[0] as { domain: string }).domain = "example.com";
    const restoreIncludes = replaceProperty(String.prototype, "includes", () => false);
    const restoreEndsWith = replaceProperty(String.prototype, "endsWith", () => true);
    const restoreLowerCase = replaceProperty(
      String.prototype,
      "toLowerCase",
      function poisonedToLowerCase(this: string) { return this; },
    );
    let badOriginResult;
    try {
      badOriginResult = evaluateRailwayApplicationDeploymentAttestation({
        ...base,
        targetOrigin: "https://example.com",
        targetOriginSha256: sha256("https://example.com"),
        providerBefore: badOriginProvider,
        providerAfter: badOriginProvider,
      });
    } finally {
      restoreLowerCase();
      restoreEndsWith();
      restoreIncludes();
    }
    expect(badOriginResult).toBeNull();

    const httpOrigin = `http://${TARGET_HOST}`;
    const restoreUrlProtocol = replaceProperty(URL.prototype, "protocol", "https:");
    let httpOriginResult;
    try {
      httpOriginResult = evaluateRailwayApplicationDeploymentAttestation({
        ...base,
        targetOrigin: httpOrigin,
        targetOriginSha256: sha256(httpOrigin),
      });
    } finally {
      restoreUrlProtocol();
    }
    expect(httpOriginResult).toBeNull();

    const throwingCollectionMethod = () => {
      throw new Error("poisoned collection prototype was invoked");
    };
    const restoreSome = replaceProperty(Array.prototype, "some", throwingCollectionMethod);
    const restoreMap = replaceProperty(Array.prototype, "map", throwingCollectionMethod);
    const restoreSort = replaceProperty(Array.prototype, "sort", throwingCollectionMethod);
    const restorePush = replaceProperty(Array.prototype, "push", throwingCollectionMethod);
    const restorePop = replaceProperty(Array.prototype, "pop", throwingCollectionMethod);
    const restoreSetAdd = replaceProperty(Set.prototype, "add", throwingCollectionMethod);
    const restoreMapSet = replaceProperty(Map.prototype, "set", throwingCollectionMethod);
    let collectionSafeResult;
    try {
      collectionSafeResult = evaluateRailwayApplicationDeploymentAttestation(base);
    } finally {
      restoreMapSet();
      restoreSetAdd();
      restorePop();
      restorePush();
      restoreSort();
      restoreMap();
      restoreSome();
    }
    expect(collectionSafeResult).not.toBeNull();

    const completedMs = Date.parse(COMPLETED_AT);
    const restoreGetTime = replaceProperty(
      Date.prototype,
      "getTime",
      () => completedMs,
    );
    let expiredFreshResult;
    try {
      expiredFreshResult = railwayApplicationDeploymentAttestationReceiptFreshAt(
        receipt,
        new Date("2026-08-11T00:15:30.001Z"),
      );
    } finally {
      restoreGetTime();
    }
    expect(expiredFreshResult).toBe(false);

    const restoreDateParse = replaceProperty(Date, "parse", () => 0);
    const restoreToISOString = replaceProperty(
      Date.prototype,
      "toISOString",
      () => "1970-01-01T00:00:00.000Z",
    );
    let dateSafeResult;
    try {
      dateSafeResult = evaluateRailwayApplicationDeploymentAttestation(base);
    } finally {
      restoreToISOString();
      restoreDateParse();
    }
    expect(dateSafeResult?.expiresAt).toBe("2026-08-11T00:15:30.000Z");

    const hashProbe = crypto.createHash("sha256");
    const hashPrototype = Object.getPrototypeOf(hashProbe) as object;
    const restoreHashUpdate = replaceProperty(
      hashPrototype,
      "update",
      function poisonedHashUpdate(this: unknown) { return this; },
    );
    const restoreHashDigest = replaceProperty(
      hashPrototype,
      "digest",
      () => "0".repeat(64),
    );
    let hashWithPoisonedPrototype: string;
    try {
      hashWithPoisonedPrototype =
        sha256RailwayApplicationDeploymentAttestationReceipt(receipt);
    } finally {
      restoreHashDigest();
      restoreHashUpdate();
    }
    expect(hashWithPoisonedPrototype!).toBe(expectedReceiptSha256);

    const invalidUtf8 = Buffer.from([0xff]);
    const restoreBufferToString = replaceProperty(
      Buffer.prototype,
      "toString",
      () => canonical,
    );
    let invalidUtf8Result;
    try {
      invalidUtf8Result = parseRailwayApplicationDeploymentAttestationReceipt(
        invalidUtf8,
      );
    } finally {
      restoreBufferToString();
    }
    expect(invalidUtf8Result).toBeNull();

    const substitutedReceipt = structuredClone(receipt) as {
      candidateSha: string;
    };
    substitutedReceipt.candidateSha = "c".repeat(40);
    const substitutedCanonical =
      canonicalRailwayApplicationDeploymentAttestationReceipt(
        substitutedReceipt as typeof receipt,
      );
    expect(Buffer.byteLength(substitutedCanonical, "utf8")).toBe(
      Buffer.byteLength(canonical, "utf8"),
    );
    const authenticBytes = Buffer.from(canonical, "utf8");
    const substitutedBytes = Buffer.from(substitutedCanonical, "utf8");
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "length",
    )!;
    const nativeLengthGetter = lengthDescriptor.get!;
    const nativeSet = Uint8Array.prototype.set;
    const targetByteLength = Buffer.byteLength(canonical, "utf8");
    let poisonedLengthGetterCalls = 0;
    Object.defineProperty(typedArrayPrototype, "length", {
      configurable: lengthDescriptor.configurable,
      enumerable: lengthDescriptor.enumerable,
      get(this: Uint8Array) {
        const length = Reflect.apply(nativeLengthGetter, this, []) as number;
        if (Buffer.isBuffer(this) && length === targetByteLength) {
          poisonedLengthGetterCalls += 1;
          Reflect.apply(nativeSet, this, [substitutedBytes, 0]);
        }
        return length;
      },
    });
    let substitutedReceiptResult;
    try {
      substitutedReceiptResult =
        parseRailwayApplicationDeploymentAttestationReceipt(authenticBytes);
    } finally {
      Object.defineProperty(typedArrayPrototype, "length", lengthDescriptor);
    }
    expect(poisonedLengthGetterCalls).toBe(0);
    expect(substitutedReceiptResult?.candidateSha).toBe(receipt.candidateSha);
  });
});
