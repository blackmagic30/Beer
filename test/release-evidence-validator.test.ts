import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const validator = path.resolve(root, "scripts/validate-release-evidence.ts");
const currentSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const oldestSha = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: root, encoding: "utf8" })
  .trim()
  .split("\n")[0]!;
const sameTreeNonAncestorSha = execFileSync(
  "git",
  ["commit-tree", `${currentSha}^{tree}`],
  {
    cwd: root,
    encoding: "utf8",
    input: "Synthetic reviewed PR head for squash-merge validation\n",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Pint Path Test",
      GIT_AUTHOR_EMAIL: "test@pintpath.invalid",
      GIT_COMMITTER_NAME: "Pint Path Test",
      GIT_COMMITTER_EMAIL: "test@pintpath.invalid",
    },
  },
).trim();
const releaseId = "PP-LAUNCH-2026-TEST1";
const costPolicySha256 = crypto.createHash("sha256").update(fs.readFileSync(
  path.resolve(root, "ops/railway/permanent-staging-cost-policy.json"),
)).digest("hex");
const checkedInSource = JSON.parse(fs.readFileSync(
  path.resolve(root, "docs/release-evidence.json"),
  "utf8",
)) as {
  version: number;
  release: {
    id: string | null;
    reviewedPrHeadSha: string | null;
    candidateSha: string | null;
    environment: string;
  };
  items: Array<Record<string, unknown>>;
};
const source = structuredClone(checkedInSource);
source.release = {
  id: null,
  reviewedPrHeadSha: null,
  candidateSha: null,
  environment: "production",
};
source.items = source.items.map((item) => ({
  ...item,
  status: "pending",
  evidence: null,
  evidenceSha256: null,
  verifiedAt: null,
  verifiedBy: null,
  ...(item.id === "permanent_staging_cost" ? { costReceipt: null } : {}),
}));
const temporaryDirectories: string[] = [];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function otherwiseCompleteWithCostPending(): typeof source {
  const value = clone(source);
  value.release = {
    id: releaseId,
    reviewedPrHeadSha: currentSha,
    candidateSha: currentSha,
    environment: "production",
  };
  value.items = value.items.map((item) => ({
    ...item,
    ...(item.id === "permanent_staging_cost"
      ? {}
      : {
          status: "pass",
          evidence: `${releaseId}/${String(item.id)}`,
          evidenceSha256: "a".repeat(64),
          verifiedAt: new Date().toISOString(),
          verifiedBy: "Release Owner, independent verifier",
        }),
  }));
  return value;
}

function completeCostReceipt(overrides: Record<string, unknown> = {}) {
  const postObservedAt = new Date().toISOString();
  const preObservedAt = new Date(Date.parse(postObservedAt) - 60_000).toISOString();
  return {
    schemaVersion: "pintpath-permanent-staging-cost-receipt/v2",
    releaseId,
    candidateSha: currentSha,
    gateId: "permanent_staging_cost",
    environment: "permanent-staging",
    scope: "permanent-staging-only",
    currency: "USD",
    amountUnit: "integer-cents",
    lineItemRounding: "ceiling",
    observationSource: "externally-captured-provider-read-only-exports",
    externalProviderExportValidationImplemented: true,
    providerObservationBindingImplemented: true,
    policySha256: costPolicySha256,
    preObservationSha256: "8".repeat(64),
    postObservationSha256: "9".repeat(64),
    preObservedAt,
    postObservedAt,
    privateManifestSha256: "a".repeat(64),
    totalUpperBoundMonthlyCents: 4_700,
    maximumObservedAcrossPhasesMonthlyCents: 4_700,
    maximumRecurringMonthlyCents: 5_000,
    requiredHeadroomMonthlyCents: 300,
    observedHeadroomMonthlyCents: 300,
    providers: [
      {
        provider: "railway",
        inventoryArtifactSha256: "b".repeat(64),
        priceOrCapArtifactSha256: "c".repeat(64),
        inventoryComplete: true,
        upperBoundComplete: true,
        scopeIsolationVerified: true,
        hardLimitOrZeroBoundVerified: true,
        unknownResourceCount: 0,
        unpricedResourceCount: 0,
        sharedResourceCount: 0,
        unboundedResourceCount: 0,
        upperBoundMonthlyCents: 2_000,
      },
      {
        provider: "staging-supabase",
        inventoryArtifactSha256: "d".repeat(64),
        priceOrCapArtifactSha256: "e".repeat(64),
        inventoryComplete: true,
        upperBoundComplete: true,
        scopeIsolationVerified: true,
        hardLimitOrZeroBoundVerified: true,
        unknownResourceCount: 0,
        unpricedResourceCount: 0,
        sharedResourceCount: 0,
        unboundedResourceCount: 0,
        upperBoundMonthlyCents: 2_500,
      },
      {
        provider: "staging-external-providers",
        inventoryArtifactSha256: "f".repeat(64),
        priceOrCapArtifactSha256: "1".repeat(64),
        inventoryComplete: true,
        upperBoundComplete: true,
        scopeIsolationVerified: true,
        hardLimitOrZeroBoundVerified: true,
        unknownResourceCount: 0,
        unpricedResourceCount: 0,
        sharedResourceCount: 0,
        unboundedResourceCount: 0,
        upperBoundMonthlyCents: 200,
      },
    ],
    excludedScopes: [
      {
        scope: "production-operational-copy",
        includedInPermanentStagingTotal: false,
        separateAuthorityArtifactSha256: "2".repeat(64),
      },
      {
        scope: "disposable-restore",
        includedInPermanentStagingTotal: false,
        separateAuthorityArtifactSha256: "3".repeat(64),
      },
    ],
    ...overrides,
  };
}

function otherwiseAllPassed(costReceipt = completeCostReceipt()): typeof source {
  const value = otherwiseCompleteWithCostPending();
  const item = value.items.find((candidate) => candidate.id === "permanent_staging_cost")!;
  Object.assign(item, {
    status: "pass",
    evidence: `${releaseId}/permanent_staging_cost`,
    evidenceSha256: "a".repeat(64),
    verifiedAt: new Date().toISOString(),
    verifiedBy: "Finance Owner, independent infrastructure verifier",
    costReceipt,
  });
  return value;
}

function costReceiptPolicyErrors(
  receipt: ReturnType<typeof completeCostReceipt>,
): string[] {
  const errors: string[] = [];
  const requiredProviders = [
    "railway",
    "staging-supabase",
    "staging-external-providers",
  ];
  const providerNames = receipt.providers.map((provider) => provider.provider);
  if (
    providerNames.length !== requiredProviders.length
    || new Set(providerNames).size !== providerNames.length
    || requiredProviders.some((provider) => !providerNames.includes(provider))
  ) errors.push("costReceipt.providers must contain exactly Railway, staging Supabase, and staging external providers");
  for (const provider of receipt.providers) {
    if (!provider.inventoryComplete) errors.push(`${provider.provider} inventory is incomplete`);
    if (!provider.upperBoundComplete) errors.push(`${provider.provider} upper bound is incomplete`);
    if (!provider.scopeIsolationVerified) errors.push(`${provider.provider} scope is not isolated`);
    if (!provider.hardLimitOrZeroBoundVerified) errors.push(`${provider.provider} hard limit is not verified`);
    if (provider.unknownResourceCount !== 0) errors.push(`${provider.provider} has unknown resources`);
    if (provider.unpricedResourceCount !== 0) errors.push(`${provider.provider} has unpriced resources`);
    if (provider.sharedResourceCount !== 0) errors.push(`${provider.provider} has shared resources`);
    if (provider.unboundedResourceCount !== 0) errors.push(`${provider.provider} has unbounded resources`);
  }
  const summedUpperBound = receipt.providers.reduce(
    (sum, provider) => sum + provider.upperBoundMonthlyCents,
    0,
  );
  if (receipt.totalUpperBoundMonthlyCents !== summedUpperBound) {
    errors.push("costReceipt.totalUpperBoundMonthlyCents must equal the provider sum");
  }
  if (receipt.totalUpperBoundMonthlyCents > 5_000) {
    errors.push("costReceipt.totalUpperBoundMonthlyCents exceeds 5000 USD cents");
  }
  if (receipt.maximumObservedAcrossPhasesMonthlyCents > 4_700) {
    errors.push("costReceipt.maximumObservedAcrossPhasesMonthlyCents exceeds 4700 USD cents");
  }
  return errors;
}

function validate(value: unknown, strict = false): { status: number | null; output: Record<string, any>; stderr: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-release-evidence-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "evidence.json");
  fs.writeFileSync(filename, `${JSON.stringify(value)}\n`);
  const result = spawnSync(
    process.execPath,
    // The supported Node 22 runtime strips these erasable TypeScript annotations
    // itself. Avoid starting a separate tsx loader for every CLI fixture.
    [validator, ...(strict ? ["--strict"] : [])],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, RELEASE_EVIDENCE_PATH: filename },
    },
  );
  return {
    status: result.status,
    output: JSON.parse(result.stdout) as Record<string, any>,
    stderr: result.stderr,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("release evidence validator", () => {
  it("keeps valid pending evidence informational in normal mode and blocking in strict mode", () => {
    const normal = validate(source);
    const strict = validate(source, true);

    expect(normal.status).toBe(0);
    expect(normal.output).toMatchObject({ valid: true, launchReady: false, strict: false });
    expect(normal.output.incomplete).toHaveLength(13);
    expect(normal.output.incomplete.map((item: { id: string }) => item.id)).not.toContain("android_release");
    expect(normal.output.incomplete[0]).toMatchObject({
      id: "production_public_smoke",
      owner: expect.any(String),
      nextAction: expect.any(String),
    });
    expect(strict.status).toBe(1);
    expect(strict.output).toMatchObject({ valid: true, launchReady: false, strict: true });
  });

  it("accepts an otherwise-complete file with a fresh candidate-bound cost receipt", () => {
    const result = validate(otherwiseAllPassed(), true);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.output).toMatchObject({
      valid: true,
      launchReady: true,
      strict: true,
      release: {
        id: releaseId,
        reviewedPrHeadSha: currentSha,
        candidateSha: currentSha,
        environment: "production",
      },
    });
    expect(result.output.permanentStagingCostReceiptErrors).toEqual([]);
  });

  it("rejects cost proof that drifts from the candidate, policy, manifest, or fresh observation window", () => {
    const fixtures: Array<[string, Record<string, unknown>, string]> = [
      [
        "candidate",
        { candidateSha: "f".repeat(40) },
        "costReceipt.candidateSha must match release.candidateSha",
      ],
      [
        "policy",
        { policySha256: "4".repeat(64) },
        "costReceipt.policySha256 must match the checked-in cost policy",
      ],
      [
        "manifest",
        { privateManifestSha256: "5".repeat(64) },
        "costReceipt.privateManifestSha256 must match evidenceSha256",
      ],
    ];
    for (const [label, override, expectedError] of fixtures) {
      const result = validate(otherwiseAllPassed(completeCostReceipt(override)), true);
      expect(result.status, label).toBe(1);
      expect(result.output.permanentStagingCostReceiptErrors, label)
        .toContain(expectedError);
    }

    const stale = validate(otherwiseAllPassed(completeCostReceipt({
      preObservedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    })));
    expect(stale.status).toBe(1);
    expect(stale.output).toMatchObject({ evidenceCurrent: false, launchReady: false });
    expect(stale.output.stalePermanentStagingCostReceipt)
      .toEqual(["permanent_staging_cost"]);
  });

  it("rejects incomplete, unknown, unpriced, shared, unbounded, or over-ceiling provider rows", () => {
    const providerFailure = completeCostReceipt();
    const firstProvider = providerFailure.providers[0]!;
    firstProvider.inventoryComplete = false;
    firstProvider.upperBoundComplete = false;
    firstProvider.scopeIsolationVerified = false;
    firstProvider.hardLimitOrZeroBoundVerified = false;
    firstProvider.unknownResourceCount = 1;
    firstProvider.unpricedResourceCount = 1;
    firstProvider.sharedResourceCount = 1;
    firstProvider.unboundedResourceCount = 1;
    expect(costReceiptPolicyErrors(providerFailure)).toEqual(
      expect.arrayContaining([
        "railway inventory is incomplete",
        "railway upper bound is incomplete",
        "railway scope is not isolated",
        "railway hard limit is not verified",
        "railway has unknown resources",
        "railway has unpriced resources",
        "railway has shared resources",
        "railway has unbounded resources",
      ]),
    );
    const failedProvider = validate(otherwiseAllPassed(providerFailure), true);
    expect(failedProvider.output.permanentStagingCostReceiptErrors).toEqual(
      expect.arrayContaining([
        "railway inventory is incomplete",
        "railway upper bound is incomplete",
        "railway scope is not isolated",
        "railway hard limit is not verified",
        "railway has unknown resources",
        "railway has unpriced resources",
        "railway has shared resources",
        "railway has unbounded resources",
      ]),
    );

    const overCeiling = completeCostReceipt();
    overCeiling.providers[2]!.upperBoundMonthlyCents = 501;
    overCeiling.totalUpperBoundMonthlyCents = 5_001;
    overCeiling.maximumObservedAcrossPhasesMonthlyCents = 5_001;
    overCeiling.observedHeadroomMonthlyCents = 0;
    expect(costReceiptPolicyErrors(overCeiling)).toContain(
      "costReceipt.totalUpperBoundMonthlyCents exceeds 5000 USD cents",
    );
    const overCeilingResult = validate(otherwiseAllPassed(overCeiling), true);
    expect(overCeilingResult.output.permanentStagingCostReceiptErrors)
      .toContain("costReceipt.totalUpperBoundMonthlyCents exceeds 5000 USD cents");

    const missingProvider = completeCostReceipt({
      providers: completeCostReceipt().providers.slice(0, 2),
      totalUpperBoundMonthlyCents: 3_900,
    });
    expect(costReceiptPolicyErrors(missingProvider)).toContain(
      "costReceipt.providers must contain exactly Railway, staging Supabase, and staging external providers",
    );
    const missingProviderResult = validate(otherwiseAllPassed(missingProvider), true);
    expect(missingProviderResult.output.permanentStagingCostReceiptErrors).toContain(
      "costReceipt.providers must contain exactly Railway, staging Supabase, and staging external providers",
    );
  });

  it("keeps production operational-copy and disposable-restore spend under separate exact authorities", () => {
    const includedProductionCopy = completeCostReceipt();
    includedProductionCopy.excludedScopes[0]!.includedInPermanentStagingTotal = true;
    const includedResult = validate(otherwiseAllPassed(includedProductionCopy), true);
    expect(includedResult.output.permanentStagingCostReceiptErrors).toContain(
      "production-operational-copy must be excluded under its exact separate cost authority",
    );

    const missingRestore = completeCostReceipt({
      excludedScopes: completeCostReceipt().excludedScopes.slice(0, 1),
    });
    const missingResult = validate(otherwiseAllPassed(missingRestore), true);
    expect(missingResult.output.permanentStagingCostReceiptErrors).toEqual(
      expect.arrayContaining([
        "costReceipt.excludedScopes must contain exactly two separate cost authorities",
        "costReceipt.excludedScopes is missing disposable-restore",
      ]),
    );
  });

  it("keeps a supported failed gate launch-blocking and rejects not-applicable required gates", () => {
    const failed = otherwiseCompleteWithCostPending();
    failed.items[0] = { ...failed.items[0], status: "fail" };
    const failedResult = validate(failed, true);
    expect(failedResult.status).toBe(1);
    expect(failedResult.output).toMatchObject({ valid: true, launchReady: false });

    const failedCostWithUncheckedReceipt = otherwiseCompleteWithCostPending();
    const failedCostItem = failedCostWithUncheckedReceipt.items.find(
      (item) => item.id === "permanent_staging_cost",
    )!;
    Object.assign(failedCostItem, {
      status: "fail",
      evidence: `${releaseId}/permanent_staging_cost`,
      evidenceSha256: "a".repeat(64),
      verifiedAt: new Date().toISOString(),
      verifiedBy: "Finance Owner, independent infrastructure verifier",
      costReceipt: { unchecked: true },
    });
    const failedCostResult = validate(failedCostWithUncheckedReceipt, true);
    expect(failedCostResult.status).toBe(1);
    expect(failedCostResult.output.schemaErrors).toContain(
      `items[${failedCostWithUncheckedReceipt.items.indexOf(failedCostItem)}].costReceipt must be null unless status is pass`,
    );

    const notApplicable = otherwiseCompleteWithCostPending();
    notApplicable.items[0] = {
      ...notApplicable.items[0],
      status: "not_applicable",
      evidence: null,
      evidenceSha256: null,
      verifiedAt: null,
      verifiedBy: null,
    };
    const notApplicableResult = validate(notApplicable, true);
    expect(notApplicableResult.status).toBe(1);
    expect(notApplicableResult.output).toMatchObject({ valid: false, launchReady: false });
    expect(notApplicableResult.output.invalidNotApplicable).toContain("production_public_smoke");
  });

  it("rejects unbound, unhashed, anonymous, future, and stale live proof", () => {
    const wrongReference = otherwiseCompleteWithCostPending();
    wrongReference.items[0] = { ...wrongReference.items[0], evidence: "some note" };
    const missingDigest = otherwiseCompleteWithCostPending();
    missingDigest.items[0] = { ...missingDigest.items[0], evidenceSha256: null };
    const anonymous = otherwiseCompleteWithCostPending();
    anonymous.items[0] = { ...anonymous.items[0], verifiedBy: "someone" };
    const future = otherwiseCompleteWithCostPending();
    future.items[0] = {
      ...future.items[0],
      verifiedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    const stale = otherwiseCompleteWithCostPending();
    stale.release.reviewedPrHeadSha = oldestSha;
    stale.release.candidateSha = oldestSha;
    stale.items[0] = {
      ...stale.items[0],
      verifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };

    for (const fixture of [wrongReference, missingDigest, anonymous]) {
      const result = validate(fixture, true);
      expect(result.status).toBe(1);
      expect(result.output.valid).toBe(false);
      expect(result.output.unsupportedProof).toContain("production_public_smoke");
    }

    const futureResult = validate(future, true);
    expect(futureResult.status).toBe(1);
    expect(futureResult.output.futureEvidence).toContain("production_public_smoke");

    const staleInformation = validate(stale);
    expect(staleInformation.status).toBe(0);
    expect(staleInformation.output).toMatchObject({ valid: true, evidenceCurrent: false, launchReady: false });
    expect(staleInformation.output.staleLiveEvidence).toContain("production_public_smoke");

    const staleStrict = validate(stale, true);
    expect(staleStrict.status).toBe(1);
    expect(staleStrict.output.staleLiveEvidence).toContain("production_public_smoke");
  });

  it("rejects proof for an unknown candidate commit and pending items that retain old proof", () => {
    const unknownCandidate = otherwiseCompleteWithCostPending();
    unknownCandidate.release.candidateSha = "f".repeat(40);
    const unknownResult = validate(unknownCandidate, true);
    expect(unknownResult.status).toBe(1);
    expect(unknownResult.output.repositoryBindingErrors).toContain(
      "release.candidateSha is not a commit in this repository",
    );

    const retained = clone(source);
    retained.items[0] = {
      ...retained.items[0],
      evidence: "old-proof",
      evidenceSha256: "b".repeat(64),
      verifiedAt: new Date().toISOString(),
      verifiedBy: "Old Owner, release verifier",
    };
    const retainedResult = validate(retained);
    expect(retainedResult.status).toBe(1);
    expect(retainedResult.output.pendingWithProof).toContain("production_public_smoke");
  });

  it("accepts a same-tree squash merge without requiring reviewed PR-head ancestry", () => {
    const squash = otherwiseAllPassed();
    squash.release.reviewedPrHeadSha = sameTreeNonAncestorSha;
    const ancestry = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", sameTreeNonAncestorSha, currentSha],
      { cwd: root },
    );
    expect(ancestry.status).not.toBe(0);

    const result = validate(squash, true);
    expect(result.status).toBe(0);
    expect(result.output.repositoryBindingErrors).toEqual([]);
  });

  it("rejects an unknown reviewed PR head or a reviewed tree that differs from candidate", () => {
    const unknown = otherwiseAllPassed();
    unknown.release.reviewedPrHeadSha = "f".repeat(40);
    const unknownResult = validate(unknown, true);
    expect(unknownResult.status).toBe(1);
    expect(unknownResult.output.repositoryBindingErrors).toContain(
      "release.reviewedPrHeadSha is not a commit in this repository",
    );

    const drifted = otherwiseAllPassed();
    drifted.release.reviewedPrHeadSha = oldestSha;
    const driftedResult = validate(drifted, true);
    expect(driftedResult.status).toBe(1);
    expect(driftedResult.output.repositoryBindingErrors).toContain(
      "release.reviewedPrHeadSha tree does not match release.candidateSha tree",
    );
  });

  it("rejects malformed schemas, gate drift, and impossible timestamps in both modes", () => {
    const missing = clone(source);
    missing.items = missing.items.slice(1);
    const duplicate = clone(source);
    duplicate.items.push(clone(duplicate.items[0]!));
    const unexpected = clone(source);
    unexpected.items.push({
      id: "unreviewed_gate",
      label: "Unexpected launch gate",
      owner: "Release owner",
      nextAction: "Review the gate.",
      required: false,
      status: "pending",
      evidence: null,
      evidenceSha256: null,
      verifiedAt: null,
      verifiedBy: null,
    });
    const notRequired = clone(source);
    notRequired.items[0] = { ...notRequired.items[0], required: false };
    const impossibleDate = otherwiseCompleteWithCostPending();
    impossibleDate.items[0] = { ...impossibleDate.items[0], verifiedAt: "2026-02-30T10:00:00.000Z" };
    const extraField = clone(source);
    extraField.items[0] = { ...extraField.items[0], signedOff: true };
    const invalidFixtures: unknown[] = [
      missing,
      duplicate,
      unexpected,
      notRequired,
      impossibleDate,
      extraField,
      { version: "not-a-version", release: source.release, items: source.items },
      { version: 2, release: source.release, items: null },
      { version: 2, release: source.release, items: [null] },
      [],
    ];

    for (const fixture of invalidFixtures) {
      for (const strict of [false, true]) {
        const result = validate(fixture, strict);
        expect(result.status, JSON.stringify({ fixture, strict })).toBe(1);
        expect(result.output).toMatchObject({ valid: false, launchReady: false, strict });
      }
    }
  });

  it("requires the release ID, reviewed head, and protected-main candidate as one identity", () => {
    const partial = clone(source);
    partial.release = {
      id: releaseId,
      reviewedPrHeadSha: null,
      candidateSha: currentSha,
      environment: "production",
    };
    const result = validate(partial);
    expect(result.status).toBe(1);
    expect(result.output.releaseMetadataErrors).toContain(
      "release.id, release.reviewedPrHeadSha, and release.candidateSha must all be null or all be set",
    );
  });
});
