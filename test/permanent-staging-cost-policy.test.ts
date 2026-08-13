import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runPermanentStagingCostReceiptBinder } from "../scripts/bind-permanent-staging-cost-receipt.js";
import {
  PERMANENT_STAGING_COST_CANONICAL_POLICY_SOURCE,
  PERMANENT_STAGING_COST_GATE_MANIFEST_SCHEMA,
  PERMANENT_STAGING_COST_OBSERVATION_SCHEMA,
  PERMANENT_STAGING_COST_POLICY_LOCK,
  PERMANENT_STAGING_COST_POLICY_PATH,
  PERMANENT_STAGING_COST_PUBLIC_PLANNING_REVIEW,
  PERMANENT_STAGING_COST_PUBLIC_REMEDIATION_DESIGN,
  auditPermanentStagingPublicPlanningCost,
  auditPermanentStagingPublicRemediationDesign,
  bindPermanentStagingCostReceipt,
  canonicalPermanentStagingCostJson,
  evaluatePermanentStagingCost,
  parsePermanentStagingCostObservation,
  parsePermanentStagingCostPolicy,
} from "../scripts/lib/permanent-staging-cost-policy.js";

const RELEASE_ID = "PP-LAUNCH-2026-COST1";
const CANDIDATE_SHA = "a".repeat(40);
const NOW = "2026-08-13T12:00:00.000Z";
const PRE_AT = "2026-08-13T10:00:00.000Z";
const POST_AT = "2026-08-13T11:00:00.000Z";
const POLICY_SHA256 = crypto.createHash("sha256")
  .update(PERMANENT_STAGING_COST_CANONICAL_POLICY_SOURCE)
  .digest("hex");
const temporaryDirectories: string[] = [];

function sha256(source: string | Buffer): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function provider(
  name: "railway" | "staging-supabase" | "staging-external-providers",
  upperBoundMonthlyCents: number,
) {
  return {
    provider: name,
    inventoryArtifactSha256: sha256(`${name}:inventory`),
    priceOrCapArtifactSha256: sha256(`${name}:price-or-cap`),
    inventoryComplete: true,
    upperBoundComplete: true,
    scopeIsolationVerified: true,
    hardLimitOrZeroBoundVerified: true,
    unknownResourceCount: 0,
    unpricedResourceCount: 0,
    sharedResourceCount: 0,
    unboundedResourceCount: 0,
    upperBoundMonthlyCents,
  };
}

function observation(
  phase: "pre-deployment" | "post-deployment",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: PERMANENT_STAGING_COST_OBSERVATION_SCHEMA,
    releaseId: RELEASE_ID,
    candidateSha: CANDIDATE_SHA,
    phase,
    environment: "permanent-staging",
    scope: "permanent-staging-only",
    currency: "USD",
    amountUnit: "integer-cents",
    lineItemRounding: "ceiling",
    observationSource: "provider-read-only-export",
    observedAt: phase === "pre-deployment" ? PRE_AT : POST_AT,
    externalExportSetSha256: sha256(`${phase}:raw-exports`),
    providers: [
      provider("railway", phase === "pre-deployment" ? 1_950 : 2_000),
      provider("staging-supabase", 2_500),
      provider("staging-external-providers", 200),
    ],
    excludedScopes: [
      {
        scope: "production-operational-copy",
        includedInPermanentStagingTotal: false,
        separateAuthorityArtifactSha256: sha256("production-copy-authority"),
      },
      {
        scope: "disposable-restore",
        includedInPermanentStagingTotal: false,
        separateAuthorityArtifactSha256: sha256("restore-authority"),
      },
    ],
    ...overrides,
  };
}

function canonicalObservation(
  phase: "pre-deployment" | "post-deployment",
  overrides: Record<string, unknown> = {},
): string {
  return canonicalPermanentStagingCostJson(observation(phase, overrides));
}

function boundInputs(overrides: Record<string, unknown> = {}) {
  const preObservationSource = canonicalObservation("pre-deployment");
  const postObservationSource = canonicalObservation("post-deployment");
  const preObservationSha256 = sha256(preObservationSource);
  const postObservationSha256 = sha256(postObservationSource);
  const privateManifestSource = canonicalPermanentStagingCostJson({
    schemaVersion: PERMANENT_STAGING_COST_GATE_MANIFEST_SCHEMA,
    releaseId: RELEASE_ID,
    candidateSha: CANDIDATE_SHA,
    environment: "permanent-staging",
    gateId: "permanent_staging_cost",
    preObservationSha256,
    postObservationSha256,
    approvedAt: "2026-08-13T11:30:00.000Z",
    approvedBy: "Finance Owner, release approver",
    independentlyVerifiedBy: "Infrastructure Owner, independent verifier",
  });
  return {
    policySource: PERMANENT_STAGING_COST_CANONICAL_POLICY_SOURCE,
    policySha256: POLICY_SHA256,
    preObservationSource,
    preObservationSha256,
    postObservationSource,
    postObservationSha256,
    privateManifestSource,
    privateManifestSha256: sha256(privateManifestSource),
    now: NOW,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("permanent staging cost policy", () => {
  it("pins the active canonical policy, a US$47 maximum, and US$3 headroom", () => {
    const checkedIn = fs.readFileSync(
      path.resolve(PERMANENT_STAGING_COST_POLICY_PATH),
      "utf8",
    );
    expect(checkedIn).toBe(PERMANENT_STAGING_COST_CANONICAL_POLICY_SOURCE);
    expect(sha256(checkedIn)).toBe(
      "57984ced59fa356baa9c19ac1e5018dad9c52829a6d7cc95a05cbd52112ddf86",
    );
    expect(PERMANENT_STAGING_COST_POLICY_LOCK).toMatchObject({
      activationState: "ACTIVE_READ_ONLY_EXTERNAL_OBSERVATION_BINDER",
      maximumRecurringMonthlyCents: 5_000,
      maximumObservedRecurringMonthlyCents: 4_700,
      requiredHeadroomMonthlyCents: 300,
      evidenceContract: {
        providerCollectorImplemented: false,
        externalProviderExportValidationImplemented: true,
        providerObservationBindingImplemented: true,
        providerNetworkAccessAllowed: false,
        credentialAccessAllowed: false,
        preAndPostDeploymentObservationRequired: true,
        privateApprovalManifestRequired: true,
        singleCombinedReceiptRequired: true,
        receiptMayAuthorizeDeployment: false,
      },
      topologyContract: {
        railway: { maximumRecurringMonthlyCents: 2_000 },
        stagingSupabase: { maximumRecurringMonthlyCents: 2_500 },
        stagingExternalProviders: { maximumRecurringMonthlyCents: 200 },
        configuredMaximumRecurringMonthlyCents: 4_700,
        explicitHeadroomMonthlyCents: 300,
      },
    });
    expect(parsePermanentStagingCostPolicy(checkedIn)).not.toBeNull();
    expect(parsePermanentStagingCostPolicy(checkedIn.trimEnd())).toBeNull();
  });

  it("keeps public-price planning distinct from live provider authority", () => {
    expect(PERMANENT_STAGING_COST_PUBLIC_PLANNING_REVIEW).toMatchObject({
      classification: "REVIEWED_PUBLIC_PRICING_PLANNING_ONLY",
      providerObservationPerformed: false,
      liveResourceInventoryVerified: false,
      repositoryRailwayStagingTargetMaxima: {
        beer: { cpuMilliVcpuPerReplica: 100, memoryMbPerReplica: 250 },
        postgres: {
          cpuMilliVcpuPerReplica: 100,
          memoryMbPerReplica: 250,
          volumeMaximumGb: 10,
        },
        redis: { cpuMilliVcpuPerReplica: 50, memoryMbPerReplica: 100 },
      },
    });
    expect(auditPermanentStagingPublicPlanningCost()).toMatchObject({
      passed: false,
      authority: "planning-only",
      maximumRecurringMonthlyCents: 5_000,
      configuredMaximumSubtotalBeforeUnknownsCents: 4_500,
      excessBeforeUnknownsCents: 0,
      failureCodes: [
        "provider_observation_not_implemented",
        "unknown_recurring_categories_present",
      ],
    });
    expect(PERMANENT_STAGING_COST_PUBLIC_REMEDIATION_DESIGN).toMatchObject({
      providerMutationPerformed: false,
      isolatedInfrastructureTarget: {
        maximumMonthlyCents: 4_500,
        remainingForAllExternalProvidersCents: 200,
        requiredHeadroomMonthlyCents: 300,
        railway: { repositoryPlanningMaximumFitsTarget: true },
      },
    });
    expect(auditPermanentStagingPublicRemediationDesign()).toMatchObject({
      passed: false,
      authority: "design-only",
      isolatedInfrastructureTargetCents: 4_500,
      remainingForAllExternalProvidersCents: 200,
      requiredHeadroomMonthlyCents: 300,
    });
  });

  it("validates canonical provider-export observations and fails closed on drift", () => {
    const source = canonicalObservation("post-deployment");
    expect(parsePermanentStagingCostObservation(source)).not.toBeNull();
    expect(evaluatePermanentStagingCost(source)).toEqual({
      passed: true,
      evaluatorState: "active-read-only-external-export-validator",
      currency: "USD",
      maximumRecurringMonthlyCents: 5_000,
      maximumObservedRecurringMonthlyCents: 4_700,
      requiredHeadroomMonthlyCents: 300,
      declaredRecurringMonthlyCents: 4_700,
      observedHeadroomMonthlyCents: 300,
      failureCodes: [],
    });
    expect(evaluatePermanentStagingCost(source.trimEnd()).failureCodes)
      .toEqual(["observation_invalid"]);
    const providerRows = structuredClone(observation("post-deployment").providers) as Array<Record<string, unknown>>;
    providerRows[2]!.upperBoundMonthlyCents = 201;
    providerRows[2]!.unboundedResourceCount = 1;
    expect(evaluatePermanentStagingCost(canonicalObservation("post-deployment", {
      providers: providerRows,
    })).failureCodes).toEqual(expect.arrayContaining([
      "staging-external-providers:unbounded_resources_present",
      "staging-external-providers:provider_limit_exceeded",
      "configured_maximum_exceeded",
      "required_headroom_not_met",
    ]));
  });

  it("binds fresh pre/post observations, two approvers, candidate, and exact hashes", () => {
    const result = bindPermanentStagingCostReceipt(boundInputs());
    expect(result).toMatchObject({
      passed: true,
      errors: [],
      receipt: {
        schemaVersion: "pintpath-permanent-staging-cost-receipt/v2",
        releaseId: RELEASE_ID,
        candidateSha: CANDIDATE_SHA,
        observationSource: "externally-captured-provider-read-only-exports",
        totalUpperBoundMonthlyCents: 4_700,
        maximumObservedAcrossPhasesMonthlyCents: 4_700,
        maximumRecurringMonthlyCents: 5_000,
        requiredHeadroomMonthlyCents: 300,
        observedHeadroomMonthlyCents: 300,
      },
    });

    const stalePre = canonicalObservation("pre-deployment", {
      observedAt: "2026-08-12T11:59:59.999Z",
    });
    const stale = bindPermanentStagingCostReceipt(boundInputs({
      preObservationSource: stalePre,
      preObservationSha256: sha256(stalePre),
    }));
    expect(stale.passed).toBe(false);
    expect(stale.errors).toEqual(expect.arrayContaining([
      "manifest_pre_observation_sha256_mismatch",
      "pre_observation_stale",
    ]));
  });

  it("writes only a sanitized mode-600 receipt from pinned private files", () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-cost-")),
    );
    temporaryDirectories.push(directory);
    fs.chmodSync(directory, 0o700);
    const inputs = boundInputs();
    const pre = path.join(directory, "pre.json");
    const post = path.join(directory, "post.json");
    const manifest = path.join(directory, "manifest.json");
    const output = path.join(directory, "receipt.json");
    for (const [filename, source] of [
      [pre, inputs.preObservationSource],
      [post, inputs.postObservationSource],
      [manifest, inputs.privateManifestSource],
    ] as const) {
      fs.writeFileSync(filename, source, { mode: 0o600 });
      fs.chmodSync(filename, 0o600);
    }
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    expect(runPermanentStagingCostReceiptBinder([
      "--policy", path.resolve(PERMANENT_STAGING_COST_POLICY_PATH),
      "--expected-policy-sha256", POLICY_SHA256,
      "--pre-observation", pre,
      "--expected-pre-observation-sha256", inputs.preObservationSha256,
      "--post-observation", post,
      "--expected-post-observation-sha256", inputs.postObservationSha256,
      "--private-manifest", manifest,
      "--expected-private-manifest-sha256", inputs.privateManifestSha256,
      "--expected-release-id", RELEASE_ID,
      "--expected-candidate-sha", CANDIDATE_SHA,
      "--output", output,
    ], new Date(NOW))).toBe(0);
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    const receipt = JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      releaseId: RELEASE_ID,
      candidateSha: CANDIDATE_SHA,
      observedHeadroomMonthlyCents: 300,
    });
    expect(writes.join("" )).not.toContain(inputs.privateManifestSource);
    expect(writes.join("" )).not.toContain(inputs.preObservationSource);
  });

  it("has no provider, environment, credential, filesystem, or network capability in the evaluator", () => {
    const source = fs.readFileSync(path.resolve(
      "scripts/lib/permanent-staging-cost-policy.ts",
    ), "utf8");
    expect(source).not.toMatch(/^import\s/m);
    for (const forbidden of [
      "process.env",
      "process.argv",
      "node:fs",
      "fetch(",
      "https.request",
      "RAILWAY_TOKEN",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]) expect(source).not.toContain(forbidden);
  });
});
