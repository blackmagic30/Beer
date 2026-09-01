import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ACCOUNT_DELETION_REHEARSAL_CLOSEOUT_SCHEMA,
  finalizeAccountDeletionRehearsalCloseout,
  validateAccountDeletionRehearsalCloseoutBundle,
} from "../scripts/finalize-account-deletion-rehearsal-closeout.mjs";

const candidate = "a".repeat(40);
const implementation = "f".repeat(40);
const activationRunId = "123";
const recoveryRunId = "456";
const temporaryDirectories: string[] = [];
const attemptOperations = [
  "prepare-two",
  "store-activation",
  "apply-active",
  "store-cleanup",
  "reconcile-cleanup",
  "cleanup-contained-zero",
  "apply-safe",
  "converge-one",
  "quarantine-zero",
  "quarantine-zero-retry-1",
  "quarantine-zero-retry-2",
] as const;

function canonical(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "pintpath-closeout-test-",
  ));
  temporaryDirectories.push(directory);
  return directory;
}

function write(directory: string, leaf: string, value: unknown) {
  const filename = path.join(directory, leaf);
  fs.writeFileSync(filename, canonical(value), { mode: 0o600 });
  return filename;
}

function cleanupArm() {
  return {
    schemaVersion: "pintpath-account-deletion-rehearsal-cleanup-arm/v1",
    candidateSha: candidate,
    activationRunId,
    projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
    environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    cleanupRequired: true,
    disarmCondition:
      "SAFE_ONE_PREACTIVATION_OR_SAFE_ONE_FINAL_OR_QUARANTINED_ZERO",
    secretMaterialIncluded: false,
  };
}

function attemptInventory() {
  return {
    schemaVersion: "pintpath-account-deletion-rehearsal-attempt-inventory/v1",
    repository: "blackmagic30/Beer",
    candidateSha: candidate,
    activationRunId,
    attempts: Object.fromEntries(attemptOperations.map((operation) => [
      operation,
      null,
    ])),
    complete: true,
    mutationCredentialExposed: false,
    secretMaterialIncluded: false,
  };
}

function attemptRecord() {
  return {
    artifactId: 1,
    artifactDigest: `sha256:${"1".repeat(64)}`,
    producerRunId: recoveryRunId,
    producerWorkflow: "reconcile",
    producerHeadSha: implementation,
    producerEvent: "schedule",
    contentSha256: "2".repeat(64),
    authoritySha256: "3".repeat(64),
    prerequisiteSha256: "4".repeat(64),
    providerSnapshotSha256: "5".repeat(64),
    providerInvariantSha256: "6".repeat(64),
  };
}

function authority(
  mode: "original" | "reconcile",
  armSource: string,
) {
  return mode === "original" ? {
    schemaVersion: "pintpath-account-deletion-rehearsal-authority/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    mode: "start",
    candidateSha: candidate,
    githubRunId: activationRunId,
    workflowPath:
      ".github/workflows/permanent-staging-account-deletion-rehearsal.yml",
    reviewedPullRequest: {
      number: 1,
      reviewedPrHeadSha: "b".repeat(40),
      mergeCommitSha: candidate,
      treeSha: "c".repeat(40),
      mergedAt: "2026-08-23T01:00:00.000Z",
      authorId: 1,
      mergedById: 2,
      githubMergeExact: true,
      reviewedTreeExact: true,
      pullRequestApprovalRequirement: "not_required",
      pullRequestApprovalRequirementExact: true,
      linearHistoryExact: true,
    },
    originalActivation: null,
    cleanupMayProceedAfterMainAdvances: false,
    secretMaterialIncluded: false,
  } : {
    schemaVersion: "pintpath-account-deletion-rehearsal-authority/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    mode: "cleanup",
    candidateSha: candidate,
    githubRunId: recoveryRunId,
    workflowPath:
      ".github/workflows/reconcile-permanent-staging-account-deletion-rehearsal.yml",
    reviewedPullRequest: null,
    originalActivation: {
      runId: activationRunId,
      terminalSha256: sha256(armSource),
      mainAdvanceIgnoredForCleanup: true,
    },
    cleanupMayProceedAfterMainAdvances: true,
    secretMaterialIncluded: false,
  };
}

function observation(
  state: "SAFE_ONE_PREACTIVATION" | "SAFE_ONE_FINAL" | "QUARANTINED_ZERO",
  producerRunId: string,
  authoritySource: string,
  overrides: Record<string, unknown> = {},
) {
  const zero = state === "QUARANTINED_ZERO";
  const replicas = zero ? 0 : 1;
  const rowCategory = state === "SAFE_ONE_PREACTIVATION"
    ? "preactivation" : "cleanup";
  const hashes = replicas === 1 ? ["1".repeat(64)] : [];
  return {
    schemaVersion: "pintpath-account-deletion-rehearsal-state-observation/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    state,
    candidateSha: candidate,
    activationRunId,
    githubRunId: producerRunId,
    implementationSha: implementation,
    authoritySha256: sha256(authoritySource),
    exact: true,
    lock: {
      projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
      environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
      serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
      region: "asia-southeast1-eqsg3a",
      publicOrigin: "https://beer-staging.up.railway.app",
    },
    providerSnapshot: {
      replicas,
      instanceCount: replicas,
      instanceIdSha256s: hashes,
      instanceStatuses: replicas === 1 ? ["RUNNING"] : [],
      deploymentIdSha256: "2".repeat(64),
      snapshotIdSha256: "3".repeat(64),
      imageDigestSha256: "4".repeat(64),
      invariantSha256: "5".repeat(64),
      rowNamesSha256: "6".repeat(64),
      rowCategory,
      patchSha256: "7".repeat(64),
      patchCategory: "empty",
    },
    runtime: {
      expected: zero ? "absent" : "safe",
      replicas,
      publicExact: !zero,
      providerExact: !zero,
      runtimeUnavailableExact: zero,
      replicaIdSha256s: hashes,
      responseSha256s: {
        "/health": hashes,
        "/startup": hashes,
        "/ready": hashes,
      },
      providerReadinessSha256s: hashes,
    },
    checks: {
      policyExact: true,
      githubAuthorityExact: true,
      tokenScopesExact: true,
      cliExact: true,
      boundaryPreflightExact: true,
      providerTopologyExact: true,
      candidateExact: true,
      rowCategoryExact: true,
      stagedPatchExact: true,
      activationMarkerExact: true,
      runtimeProofExact: true,
      boundaryPostflightExact: true,
    },
    mutationCredentialExposed: false,
    secretMaterialIncluded: false,
    ...overrides,
  };
}

function fixture(
  mode: "original" | "reconcile",
  state: "SAFE_ONE_PREACTIVATION" | "SAFE_ONE_FINAL" | "QUARANTINED_ZERO",
  observationOverrides: Record<string, unknown> = {},
) {
  const directory = temporaryDirectory();
  const arm = cleanupArm();
  const armSource = canonical(arm);
  const producerRunId = mode === "original" ? activationRunId : recoveryRunId;
  const authorityValue = authority(mode, armSource);
  const authoritySource = canonical(authorityValue);
  const inventoryValue = attemptInventory();
  const inventorySource = canonical(inventoryValue);
  const armFile = write(directory, "cleanup-arm.json", arm);
  const authorityFile = write(directory, "github-authority.json", authorityValue);
  const observationFile = write(directory, "state-observation.json", observation(
    state,
    producerRunId,
    authoritySource,
    observationOverrides,
  ));
  const inventoryFile = write(
    directory,
    "attempt-inventory.json",
    inventoryValue,
  );
  return {
    directory,
    outputDirectory: path.join(directory, "output"),
    armFile,
    authorityFile,
    observationFile,
    inventoryFile,
    producerRunId,
    armSource,
    authoritySource,
    inventorySource,
  };
}

function argv(value: ReturnType<typeof fixture>, mode: "original" | "reconcile") {
  return [
    "--mode", mode,
    "--candidate-sha", candidate,
    "--activation-run-id", activationRunId,
    "--producer-run-id", value.producerRunId,
    "--implementation-sha", implementation,
    "--cleanup-arm-file", value.armFile,
    "--authority-file", value.authorityFile,
    "--observation-file", value.observationFile,
    "--attempt-inventory-file", value.inventoryFile,
    "--output-dir", value.outputDirectory,
  ];
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("account-deletion rehearsal closeout", () => {
  it("creates and revalidates an exact original safe-one closeout bundle", () => {
    const value = fixture("original", "SAFE_ONE_FINAL");
    const result = finalizeAccountDeletionRehearsalCloseout(argv(value, "original"));
    expect(result.state).toBe("SAFE_ONE_FINAL");
    const closeoutSource = fs.readFileSync(
      path.join(value.outputDirectory, "closeout.json"),
      "utf8",
    );
    const closeout = validateAccountDeletionRehearsalCloseoutBundle({
      closeoutSource,
      providerEvidenceSource: fs.readFileSync(
        path.join(value.outputDirectory, "provider-evidence.json"),
        "utf8",
      ),
      authoritySource: fs.readFileSync(
        path.join(value.outputDirectory, "authority.json"),
        "utf8",
      ),
      cleanupArmSource: value.armSource,
      attemptInventorySource: fs.readFileSync(
        path.join(value.outputDirectory, "attempt-inventory.json"),
        "utf8",
      ),
      expectedMode: "original",
      expectedCandidateSha: candidate,
      expectedActivationRunId: activationRunId,
      expectedProducerRunId: activationRunId,
      expectedImplementationSha: implementation,
    });
    expect(closeout).toMatchObject({
      schemaVersion: ACCOUNT_DELETION_REHEARSAL_CLOSEOUT_SCHEMA,
      cleanupObligationDisarmed: true,
      recoveryImplementationSha: implementation,
      attemptArmCount: 0,
    });
    expect(fs.readdirSync(value.outputDirectory).sort()).toEqual([
      "attempt-inventory.json",
      "authority.json",
      "closeout.json",
      "provider-evidence.json",
    ]);
  });

  it("accepts exact preactivation safe one and clean quarantined zero", () => {
    for (const state of [
      "SAFE_ONE_PREACTIVATION",
      "QUARANTINED_ZERO",
    ] as const) {
      const value = fixture("reconcile", state);
      expect(finalizeAccountDeletionRehearsalCloseout(argv(value, "reconcile")))
        .toMatchObject({ state });
    }
  });

  it("rejects zero containment until cleanup rows and an empty patch are exact", () => {
    const active = fixture("reconcile", "QUARANTINED_ZERO", {
      providerSnapshot: {
        ...observation(
          "QUARANTINED_ZERO",
          recoveryRunId,
          "unused",
        ).providerSnapshot,
        rowCategory: "active",
      },
    });
    expect(() => finalizeAccountDeletionRehearsalCloseout(
      argv(active, "reconcile"),
    )).toThrow("provider_evidence_invalid");
  });

  it("rejects substituted implementation, authority, or closeout evidence", () => {
    const value = fixture("reconcile", "SAFE_ONE_FINAL");
    const substituted = argv(value, "reconcile");
    substituted[substituted.indexOf("--implementation-sha") + 1] =
      "0".repeat(40);
    expect(() => finalizeAccountDeletionRehearsalCloseout(substituted))
      .toThrow("provider_evidence_invalid");

    finalizeAccountDeletionRehearsalCloseout(argv(value, "reconcile"));
    const closeoutFile = path.join(value.outputDirectory, "closeout.json");
    const closeout = JSON.parse(fs.readFileSync(closeoutFile, "utf8"));
    closeout.cleanupObligationDisarmed = false;
    expect(() => validateAccountDeletionRehearsalCloseoutBundle({
      closeoutSource: canonical(closeout),
      providerEvidenceSource: fs.readFileSync(
        path.join(value.outputDirectory, "provider-evidence.json"),
        "utf8",
      ),
      authoritySource: value.authoritySource,
      cleanupArmSource: value.armSource,
      attemptInventorySource: value.inventorySource,
      expectedMode: "reconcile",
      expectedCandidateSha: candidate,
      expectedActivationRunId: activationRunId,
      expectedProducerRunId: recoveryRunId,
      expectedImplementationSha: implementation,
    })).toThrow("closeout_invalid");
  });

  it("rejects a substituted or incomplete attempt inventory", () => {
    const value = fixture("reconcile", "SAFE_ONE_FINAL");
    const inventory = JSON.parse(value.inventorySource);
    inventory.complete = false;
    fs.writeFileSync(value.inventoryFile, canonical(inventory), { mode: 0o600 });
    expect(() => finalizeAccountDeletionRehearsalCloseout(
      argv(value, "reconcile"),
    )).toThrow("attempt_inventory_invalid");
  });

  it("rejects symlinked and hard-linked input evidence", () => {
    const symlinked = fixture("reconcile", "SAFE_ONE_FINAL");
    const symlink = path.join(symlinked.directory, "cleanup-arm-link.json");
    fs.symlinkSync(symlinked.armFile, symlink);
    const symlinkArguments = argv(symlinked, "reconcile");
    symlinkArguments[symlinkArguments.indexOf("--cleanup-arm-file") + 1] =
      symlink;
    expect(() => finalizeAccountDeletionRehearsalCloseout(symlinkArguments))
      .toThrow("cleanup_arm_invalid");

    const hardLinked = fixture("reconcile", "SAFE_ONE_FINAL");
    const hardLink = path.join(hardLinked.directory, "authority-hard-link.json");
    fs.linkSync(hardLinked.authorityFile, hardLink);
    const hardLinkArguments = argv(hardLinked, "reconcile");
    hardLinkArguments[hardLinkArguments.indexOf("--authority-file") + 1] =
      hardLink;
    expect(() => finalizeAccountDeletionRehearsalCloseout(hardLinkArguments))
      .toThrow("authority_invalid");
  });

  it("requires clean zero after any immutable containment arm exists", () => {
    for (const operation of [
      "cleanup-contained-zero",
      "quarantine-zero",
      "quarantine-zero-retry-1",
      "quarantine-zero-retry-2",
    ] as const) {
      const safe = fixture("reconcile", "SAFE_ONE_FINAL");
      const safeInventory = JSON.parse(safe.inventorySource);
      safeInventory.attempts[operation] = attemptRecord();
      fs.writeFileSync(safe.inventoryFile, canonical(safeInventory), {
        mode: 0o600,
      });
      expect(() => finalizeAccountDeletionRehearsalCloseout(
        argv(safe, "reconcile"),
      )).toThrow("containment_terminal_state_invalid");

      const zero = fixture("reconcile", "QUARANTINED_ZERO");
      const zeroInventory = JSON.parse(zero.inventorySource);
      zeroInventory.attempts[operation] = attemptRecord();
      fs.writeFileSync(zero.inventoryFile, canonical(zeroInventory), {
        mode: 0o600,
      });
      expect(finalizeAccountDeletionRehearsalCloseout(
        argv(zero, "reconcile"),
      )).toMatchObject({ state: "QUARANTINED_ZERO", attemptArmCount: 1 });
    }
  });

  it("rejects a safe-one bundle when its final inventory adds containment", () => {
    const value = fixture("reconcile", "SAFE_ONE_FINAL");
    finalizeAccountDeletionRehearsalCloseout(argv(value, "reconcile"));
    const inventory = JSON.parse(fs.readFileSync(
      path.join(value.outputDirectory, "attempt-inventory.json"),
      "utf8",
    ));
    inventory.attempts["quarantine-zero"] = attemptRecord();
    expect(() => validateAccountDeletionRehearsalCloseoutBundle({
      closeoutSource: fs.readFileSync(
        path.join(value.outputDirectory, "closeout.json"), "utf8",
      ),
      providerEvidenceSource: fs.readFileSync(
        path.join(value.outputDirectory, "provider-evidence.json"), "utf8",
      ),
      authoritySource: value.authoritySource,
      cleanupArmSource: value.armSource,
      attemptInventorySource: canonical(inventory),
      expectedMode: "reconcile",
      expectedCandidateSha: candidate,
      expectedActivationRunId: activationRunId,
      expectedProducerRunId: recoveryRunId,
      expectedImplementationSha: implementation,
    })).toThrow("containment_terminal_state_invalid");
  });
});
