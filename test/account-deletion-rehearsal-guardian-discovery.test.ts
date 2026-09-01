import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  ACCOUNT_DELETION_REHEARSAL_GUARDIAN_DISCOVERY_SCHEMA,
  discoverAccountDeletionRehearsalRecovery,
} from "../scripts/discover-github-account-deletion-rehearsal-recovery.mjs";
import { finalizeAccountDeletionRehearsalCloseout } from
  "../scripts/finalize-account-deletion-rehearsal-closeout.mjs";

const repository = "blackmagic30/Beer";
const candidate = "a".repeat(40);
const secondCandidate = "c".repeat(40);
const implementation = "f".repeat(40);
const activationRunId = "123";
const secondActivationRunId = "124";
const recoveryRunId = "456";
const secondRecoveryRunId = "457";
const token = "test-token-with-sufficient-length";
const now = Date.parse("2026-09-01T10:00:00.000Z");
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

function sha256(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "pintpath-guardian-test-",
  ));
  temporaryDirectories.push(directory);
  return directory;
}

function zip(files: Readonly<Record<string, string>>) {
  const directory = temporaryDirectory();
  for (const [leaf, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, leaf), source, { mode: 0o600 });
  }
  const archive = path.join(directory, "artifact.zip");
  execFileSync("/usr/bin/zip", [
    "-q",
    "-j",
    archive,
    ...Object.keys(files),
  ], { cwd: directory, shell: false });
  return fs.readFileSync(archive);
}

function cleanupArm(
  candidateSha = candidate,
  runId = activationRunId,
) {
  return {
    schemaVersion: "pintpath-account-deletion-rehearsal-cleanup-arm/v1",
    candidateSha,
    activationRunId: runId,
    projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
    environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    cleanupRequired: true,
    disarmCondition:
      "SAFE_ONE_PREACTIVATION_OR_SAFE_ONE_FINAL_OR_QUARANTINED_ZERO",
    secretMaterialIncluded: false,
  };
}

function originalAuthority(
  candidateSha = candidate,
  runId = activationRunId,
) {
  return {
    schemaVersion: "pintpath-account-deletion-rehearsal-authority/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    mode: "start",
    candidateSha,
    githubRunId: runId,
    workflowPath:
      ".github/workflows/permanent-staging-account-deletion-rehearsal.yml",
    reviewedPullRequest: {
      number: 1,
      reviewedPrHeadSha: "b".repeat(40),
      mergeCommitSha: candidateSha,
      treeSha: "d".repeat(40),
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
  };
}

function reconcileAuthority(
  armSource: string,
  candidateSha = candidate,
  originalRunId = activationRunId,
  producerRunId = recoveryRunId,
) {
  return {
    schemaVersion: "pintpath-account-deletion-rehearsal-authority/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    mode: "cleanup",
    candidateSha,
    githubRunId: producerRunId,
    workflowPath:
      ".github/workflows/reconcile-permanent-staging-account-deletion-rehearsal.yml",
    reviewedPullRequest: null,
    originalActivation: {
      runId: originalRunId,
      terminalSha256: sha256(armSource),
      mainAdvanceIgnoredForCleanup: true,
    },
    cleanupMayProceedAfterMainAdvances: true,
    secretMaterialIncluded: false,
  };
}

function emptyInventory(
  candidateSha = candidate,
  runId = activationRunId,
) {
  return {
    schemaVersion: "pintpath-account-deletion-rehearsal-attempt-inventory/v1",
    repository,
    candidateSha,
    activationRunId: runId,
    attempts: Object.fromEntries(attemptOperations.map((operation) => [
      operation,
      null,
    ])),
    complete: true,
    mutationCredentialExposed: false,
    secretMaterialIncluded: false,
  };
}

function observation({
  candidateSha,
  originalRunId,
  producerRunId,
  implementationSha,
  authoritySource,
}: {
  candidateSha: string;
  originalRunId: string;
  producerRunId: string;
  implementationSha: string;
  authoritySource: string;
}) {
  const hashes = ["1".repeat(64)];
  return {
    schemaVersion: "pintpath-account-deletion-rehearsal-state-observation/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    state: "SAFE_ONE_FINAL",
    candidateSha,
    activationRunId: originalRunId,
    githubRunId: producerRunId,
    implementationSha,
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
      replicas: 1,
      instanceCount: 1,
      instanceIdSha256s: hashes,
      instanceStatuses: ["RUNNING"],
      deploymentIdSha256: "2".repeat(64),
      snapshotIdSha256: "3".repeat(64),
      imageDigestSha256: "4".repeat(64),
      invariantSha256: "5".repeat(64),
      rowNamesSha256: "6".repeat(64),
      rowCategory: "cleanup",
      patchSha256: "7".repeat(64),
      patchCategory: "empty",
    },
    runtime: {
      expected: "safe",
      replicas: 1,
      publicExact: true,
      providerExact: true,
      runtimeUnavailableExact: false,
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
  };
}

function armEntries(
  candidateSha = candidate,
  runId = activationRunId,
) {
  return {
    "cleanup-arm.json": canonical(cleanupArm(candidateSha, runId)),
    "github-authority.json": canonical(originalAuthority(candidateSha, runId)),
  };
}

function closeoutEntries(
  mode: "original" | "reconcile",
  candidateSha = candidate,
  originalRunId = activationRunId,
  producerRunId = mode === "original" ? originalRunId : recoveryRunId,
  implementationSha = mode === "original" ? candidateSha : implementation,
) {
  const directory = temporaryDirectory();
  const armSource = canonical(cleanupArm(candidateSha, originalRunId));
  const authorityValue = mode === "original"
    ? originalAuthority(candidateSha, originalRunId)
    : reconcileAuthority(
      armSource,
      candidateSha,
      originalRunId,
      producerRunId,
    );
  const authoritySource = canonical(authorityValue);
  const inventory = emptyInventory(candidateSha, originalRunId);
  const inputs = {
    arm: path.join(directory, "cleanup-arm.json"),
    authority: path.join(directory, "authority-input.json"),
    observation: path.join(directory, "state-observation.json"),
    inventory: path.join(directory, "attempt-inventory-input.json"),
    output: path.join(directory, "output"),
  };
  fs.writeFileSync(inputs.arm, armSource, { mode: 0o600 });
  fs.writeFileSync(inputs.authority, authoritySource, { mode: 0o600 });
  fs.writeFileSync(inputs.observation, canonical(observation({
    candidateSha,
    originalRunId,
    producerRunId,
    implementationSha,
    authoritySource,
  })), { mode: 0o600 });
  fs.writeFileSync(inputs.inventory, canonical(inventory), { mode: 0o600 });
  finalizeAccountDeletionRehearsalCloseout([
    "--mode", mode,
    "--candidate-sha", candidateSha,
    "--activation-run-id", originalRunId,
    "--producer-run-id", producerRunId,
    "--implementation-sha", implementationSha,
    "--cleanup-arm-file", inputs.arm,
    "--authority-file", inputs.authority,
    "--observation-file", inputs.observation,
    "--attempt-inventory-file", inputs.inventory,
    "--output-dir", inputs.output,
  ]);
  return Object.fromEntries([
    "closeout.json",
    "provider-evidence.json",
    "authority.json",
    "attempt-inventory.json",
  ].map((leaf) => [
    leaf,
    fs.readFileSync(path.join(inputs.output, leaf), "utf8"),
  ]));
}

function mainRun(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: Number(activationRunId),
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    name: "Rehearse Pint Path permanent-staging account deletion",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: candidate,
    path: ".github/workflows/permanent-staging-account-deletion-rehearsal.yml",
    created_at: "2026-09-01T09:00:00.000Z",
    updated_at: "2026-09-01T09:10:00.000Z",
    repository: { full_name: repository },
    ...overrides,
  };
}

function reconcileRun(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: Number(recoveryRunId),
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    name: "Reconcile Pint Path account-deletion rehearsal cleanup",
    event: "schedule",
    head_branch: "main",
    head_sha: implementation,
    path:
      ".github/workflows/reconcile-permanent-staging-account-deletion-rehearsal.yml",
    created_at: "2026-09-01T09:30:00.000Z",
    updated_at: "2026-09-01T09:40:00.000Z",
    repository: { full_name: repository },
    ...overrides,
  };
}

type Artifact = {
  id: number;
  name: string;
  expired: boolean;
  size_in_bytes: number;
  digest: string;
  archive_download_url: string;
  workflow_run: { id: number };
};

function artifact(
  name: string,
  runId: string,
  archive: Buffer,
  id: number,
): Artifact {
  return {
    id,
    name,
    expired: false,
    size_in_bytes: archive.length,
    digest: `sha256:${sha256(archive)}`,
    archive_download_url:
      `https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`,
    workflow_run: { id: Number(runId) },
  };
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type FetchOptions = {
  mainRuns?: readonly ReturnType<typeof mainRun>[];
  runTotal?: number;
  runArtifacts?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  namedArtifacts?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  producerRuns?: Readonly<Record<string, ReturnType<typeof mainRun>>>;
  attemptOneRuns?: Readonly<Record<string, ReturnType<typeof mainRun>>>;
  archives?: ReadonlyMap<number, Buffer>;
};

function fetchFor(options: FetchOptions = {}, requests: string[] = []) {
  return async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input
      : input instanceof URL ? input.href : input.url);
    requests.push(`${url.pathname}${url.search}`);
    const archiveMatch = url.pathname.match(/\/actions\/artifacts\/(\d+)\/zip$/);
    if (archiveMatch) {
      const archive = options.archives?.get(Number(archiveMatch[1]));
      if (!archive) throw new Error(`missing_archive:${archiveMatch[1]}`);
      return new Response(archive, {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    }
    if (url.pathname.endsWith(
      "/actions/workflows/permanent-staging-account-deletion-rehearsal.yml/runs",
    )) {
      const runs = [...(options.mainRuns ?? [])];
      const page = Number(url.searchParams.get("page"));
      const total = options.runTotal ?? runs.length;
      return json({
        total_count: total,
        workflow_runs: runs.slice((page - 1) * 100, page * 100),
      });
    }
    const runArtifactsMatch = url.pathname.match(/\/actions\/runs\/(\d+)\/artifacts$/);
    if (runArtifactsMatch) {
      const artifacts = [
        ...(options.runArtifacts?.[runArtifactsMatch[1]] ?? []),
      ];
      const page = Number(url.searchParams.get("page"));
      return json({
        total_count: artifacts.length,
        artifacts: artifacts.slice((page - 1) * 100, page * 100),
      });
    }
    if (url.pathname.endsWith("/actions/artifacts")) {
      const name = url.searchParams.get("name") ?? "";
      const artifacts = [...(options.namedArtifacts?.[name] ?? [])];
      const page = Number(url.searchParams.get("page"));
      return json({
        total_count: artifacts.length,
        artifacts: artifacts.slice((page - 1) * 100, page * 100),
      });
    }
    const runAttemptMatch = url.pathname.match(
      /\/actions\/runs\/(\d+)\/attempts\/1$/,
    );
    if (runAttemptMatch) {
      const value = options.attemptOneRuns?.[runAttemptMatch[1]];
      if (!value) throw new Error(`missing_run_attempt:${runAttemptMatch[1]}:1`);
      return json(value);
    }
    const runMatch = url.pathname.match(/\/actions\/runs\/(\d+)$/);
    if (runMatch) {
      const value = options.producerRuns?.[runMatch[1]]
        ?? options.mainRuns?.find(({ id }) => String(id) === runMatch[1]);
      if (!value) throw new Error(`missing_run:${runMatch[1]}`);
      return json(value);
    }
    throw new Error(`unexpected_url:${url.pathname}${url.search}`);
  };
}

const env = { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token };

function inventoryForCurrentActivation() {
  return async (overrides: {
    env: Record<string, string>;
  }) => emptyInventory(
    overrides.env.PINTPATH_ACCOUNT_DELETION_CANDIDATE_SHA,
    overrides.env.PINTPATH_ACCOUNT_DELETION_ACTIVATION_RUN_ID,
  );
}

function recoveryResult(
  candidateSha = candidate,
  runId = activationRunId,
) {
  return {
    schemaVersion: ACCOUNT_DELETION_REHEARSAL_GUARDIAN_DISCOVERY_SCHEMA,
    outcome: "recovery_required",
    activationRunId: runId,
    candidateSha,
    originalConclusion: "failure",
    secretMaterialIncluded: false,
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("account-deletion rehearsal scheduled guardian discovery", () => {
  it("uses the workflow-specific endpoint and returns no-op only after complete discovery", async () => {
    const requests: string[] = [];
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({}, requests) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).resolves.toEqual({
      schemaVersion: ACCOUNT_DELETION_REHEARSAL_GUARDIAN_DISCOVERY_SCHEMA,
      outcome: "no_recovery_required",
      activationRunId: null,
      candidateSha: null,
      originalConclusion: null,
      secretMaterialIncluded: false,
    });
    expect(requests).toEqual([
      "/repos/blackmagic30/Beer/actions/workflows/"
        + "permanent-staging-account-deletion-rehearsal.yml/runs"
        + "?event=workflow_dispatch&status=completed&branch=main"
        + "&per_page=100&page=1",
    ]);
  });

  it("selects an exact failed run only after validating its durable arm", async () => {
    const armArchive = zip(armEntries());
    const arm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
      activationRunId,
      armArchive,
      1001,
    );
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [mainRun()],
        runArtifacts: { [activationRunId]: [arm] },
        archives: new Map([[arm.id, armArchive]]),
      }) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).resolves.toEqual(recoveryResult());
  });

  it("trusts a successful original run only with its exact four-file closeout", async () => {
    const armArchive = zip(armEntries());
    const closeoutArchive = zip(closeoutEntries("original"));
    const arm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
      activationRunId,
      armArchive,
      1002,
    );
    const closeout = artifact(
      `pintpath-account-deletion-rehearsal-closeout-${candidate}-${activationRunId}`,
      activationRunId,
      closeoutArchive,
      1003,
    );
    const original = mainRun({ conclusion: "success" });
    const result = await discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [original],
        runArtifacts: { [activationRunId]: [arm, closeout] },
        archives: new Map([
          [arm.id, armArchive],
          [closeout.id, closeoutArchive],
        ]),
      }) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    });
    expect(result.outcome).toBe("no_recovery_required");
  });

  it("trusts an exact successful reconciliation closeout", async () => {
    const armArchive = zip(armEntries());
    const closeoutArchive = zip(closeoutEntries("reconcile"));
    const arm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
      activationRunId,
      armArchive,
      1004,
    );
    const name =
      `pintpath-account-deletion-rehearsal-reconcile-closeout-${candidate}`
      + `-${activationRunId}`;
    const closeout = artifact(name, recoveryRunId, closeoutArchive, 1005);
    const result = await discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [mainRun()],
        runArtifacts: { [activationRunId]: [arm] },
        namedArtifacts: { [name]: [closeout] },
        producerRuns: { [recoveryRunId]: reconcileRun() },
        archives: new Map([
          [arm.id, armArchive],
          [closeout.id, closeoutArchive],
        ]),
      }) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    });
    expect(result.outcome).toBe("no_recovery_required");
  });

  it("ignores a failed producer duplicate when another closeout is fully trusted", async () => {
    const armArchive = zip(armEntries());
    const failedArchive = zip(closeoutEntries("reconcile"));
    const trustedArchive = zip(closeoutEntries(
      "reconcile",
      candidate,
      activationRunId,
      secondRecoveryRunId,
      implementation,
    ));
    const arm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
      activationRunId,
      armArchive,
      1301,
    );
    const name =
      `pintpath-account-deletion-rehearsal-reconcile-closeout-${candidate}`
      + `-${activationRunId}`;
    const failed = artifact(name, recoveryRunId, failedArchive, 1302);
    const trusted = artifact(
      name,
      secondRecoveryRunId,
      trustedArchive,
      1303,
    );
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [mainRun()],
        runArtifacts: { [activationRunId]: [arm] },
        namedArtifacts: { [name]: [failed, trusted] },
        producerRuns: {
          [recoveryRunId]: reconcileRun({ conclusion: "failure" }),
          [secondRecoveryRunId]: reconcileRun({
            id: Number(secondRecoveryRunId),
          }),
        },
        archives: new Map([
          [arm.id, armArchive],
          [failed.id, failedArchive],
          [trusted.id, trustedArchive],
        ]),
      }) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).resolves.toMatchObject({ outcome: "no_recovery_required" });
  });

  it("validates a completed rerun producer against immutable attempt one", async () => {
    const requests: string[] = [];
    const armArchive = zip(armEntries());
    const closeoutArchive = zip(closeoutEntries("reconcile"));
    const arm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
      activationRunId,
      armArchive,
      1304,
    );
    const name =
      `pintpath-account-deletion-rehearsal-reconcile-closeout-${candidate}`
      + `-${activationRunId}`;
    const closeout = artifact(name, recoveryRunId, closeoutArchive, 1305);
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [mainRun()],
        runArtifacts: { [activationRunId]: [arm] },
        namedArtifacts: { [name]: [closeout] },
        producerRuns: {
          [recoveryRunId]: reconcileRun({
            run_attempt: 2,
            conclusion: "failure",
          }),
        },
        attemptOneRuns: { [recoveryRunId]: reconcileRun() },
        archives: new Map([
          [arm.id, armArchive],
          [closeout.id, closeoutArchive],
        ]),
      }, requests) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).resolves.toMatchObject({ outcome: "no_recovery_required" });
    expect(requests).toContain(
      `/repos/${repository}/actions/runs/${recoveryRunId}/attempts/1`,
    );
  });

  it("does not trust attempt one while the producer rerun is still active", async () => {
    const requests: string[] = [];
    const armArchive = zip(armEntries());
    const closeoutArchive = zip(closeoutEntries("reconcile"));
    const arm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
      activationRunId,
      armArchive,
      1306,
    );
    const name =
      `pintpath-account-deletion-rehearsal-reconcile-closeout-${candidate}`
      + `-${activationRunId}`;
    const closeout = artifact(name, recoveryRunId, closeoutArchive, 1307);
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [mainRun()],
        runArtifacts: { [activationRunId]: [arm] },
        namedArtifacts: { [name]: [closeout] },
        producerRuns: {
          [recoveryRunId]: reconcileRun({
            run_attempt: 2,
            status: "in_progress",
            conclusion: null,
          }),
        },
        attemptOneRuns: { [recoveryRunId]: reconcileRun() },
        archives: new Map([
          [arm.id, armArchive],
          [closeout.id, closeoutArchive],
        ]),
      }, requests) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).resolves.toMatchObject({ outcome: "recovery_required" });
    expect(requests).not.toContain(
      `/repos/${repository}/actions/runs/${recoveryRunId}/attempts/1`,
    );
  });

  it("discovers a rerun activation through its immutable first attempt", async () => {
    const requests: string[] = [];
    const armArchive = zip(armEntries());
    const arm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
      activationRunId,
      armArchive,
      1308,
    );
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [mainRun({
          run_attempt: 2,
          updated_at: "2026-09-01T09:20:00.000Z",
        })],
        attemptOneRuns: { [activationRunId]: mainRun() },
        runArtifacts: { [activationRunId]: [arm] },
        archives: new Map([[arm.id, armArchive]]),
      }, requests) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).resolves.toEqual(recoveryResult());
    expect(requests).toContain(
      `/repos/${repository}/actions/runs/${activationRunId}/attempts/1`,
    );
  });

  it("never lets a tampered closeout suppress recovery", async () => {
    const armArchive = zip(armEntries());
    const entries = closeoutEntries("original");
    const closeout = JSON.parse(entries["closeout.json"]);
    closeout.cleanupObligationDisarmed = false;
    entries["closeout.json"] = canonical(closeout);
    const closeoutArchive = zip(entries);
    const arm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
      activationRunId,
      armArchive,
      1006,
    );
    const closeoutArtifact = artifact(
      `pintpath-account-deletion-rehearsal-closeout-${candidate}-${activationRunId}`,
      activationRunId,
      closeoutArchive,
      1007,
    );
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [mainRun({ conclusion: "success" })],
        runArtifacts: {
          [activationRunId]: [arm, closeoutArtifact],
        },
        archives: new Map([
          [arm.id, armArchive],
          [closeoutArtifact.id, closeoutArchive],
        ]),
      }) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).resolves.toMatchObject({ outcome: "recovery_required" });
  });

  it("continues recovery when a safe-one closeout has containment history", async () => {
    const armArchive = zip(armEntries());
    const entries = closeoutEntries("original");
    const inventory = JSON.parse(entries["attempt-inventory.json"]);
    inventory.attempts["quarantine-zero"] = {
      artifactId: 9999,
      artifactDigest: `sha256:${"8".repeat(64)}`,
      producerRunId: recoveryRunId,
      producerWorkflow: "reconcile",
      producerHeadSha: implementation,
      producerEvent: "schedule",
      contentSha256: "9".repeat(64),
      authoritySha256: "a".repeat(64),
      prerequisiteSha256: "b".repeat(64),
      providerSnapshotSha256: "c".repeat(64),
      providerInvariantSha256: "d".repeat(64),
    };
    entries["attempt-inventory.json"] = canonical(inventory);
    const closeoutArchive = zip(entries);
    const arm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
      activationRunId,
      armArchive,
      1310,
    );
    const closeout = artifact(
      `pintpath-account-deletion-rehearsal-closeout-${candidate}-${activationRunId}`,
      activationRunId,
      closeoutArchive,
      1311,
    );
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [mainRun({ conclusion: "success" })],
        runArtifacts: { [activationRunId]: [arm, closeout] },
        archives: new Map([
          [arm.id, armArchive],
          [closeout.id, closeoutArchive],
        ]),
      }) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).resolves.toMatchObject({ outcome: "recovery_required" });
  });

  it("rejects foreign-workflow and failed reconciliation producers", async () => {
    for (const producer of [
      reconcileRun({
        name: "Foreign workflow",
        path: ".github/workflows/foreign.yml",
      }),
      reconcileRun({ conclusion: "failure" }),
    ]) {
      const armArchive = zip(armEntries());
      const closeoutArchive = zip(closeoutEntries("reconcile"));
      const arm = artifact(
        `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
        activationRunId,
        armArchive,
        1100 + temporaryDirectories.length,
      );
      const name =
        `pintpath-account-deletion-rehearsal-reconcile-closeout-${candidate}`
        + `-${activationRunId}`;
      const closeout = artifact(
        name,
        recoveryRunId,
        closeoutArchive,
        1200 + temporaryDirectories.length,
      );
      await expect(discoverAccountDeletionRehearsalRecovery({
        env,
        now: () => now,
        fetchImpl: fetchFor({
          mainRuns: [mainRun()],
          runArtifacts: { [activationRunId]: [arm] },
          namedArtifacts: { [name]: [closeout] },
          producerRuns: { [recoveryRunId]: producer },
          archives: new Map([
            [arm.id, armArchive],
            [closeout.id, closeoutArchive],
          ]),
        }) as typeof fetch,
        inventoryImpl: inventoryForCurrentActivation(),
      })).resolves.toMatchObject({ outcome: "recovery_required" });
    }
  });

  it("invalidates a closeout when a post-closeout attempt arm appears", async () => {
    const armArchive = zip(armEntries());
    const closeoutArchive = zip(closeoutEntries("original"));
    const arm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
      activationRunId,
      armArchive,
      1008,
    );
    const closeout = artifact(
      `pintpath-account-deletion-rehearsal-closeout-${candidate}-${activationRunId}`,
      activationRunId,
      closeoutArchive,
      1009,
    );
    const live = emptyInventory();
    live.attempts["quarantine-zero"] = {
      artifactId: 9999,
      artifactDigest: `sha256:${"8".repeat(64)}`,
      producerRunId: recoveryRunId,
      producerWorkflow: "reconcile",
      producerHeadSha: implementation,
      producerEvent: "schedule",
      contentSha256: "9".repeat(64),
      authoritySha256: "a".repeat(64),
      prerequisiteSha256: "b".repeat(64),
      providerSnapshotSha256: "c".repeat(64),
      providerInvariantSha256: "d".repeat(64),
    };
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [mainRun({ conclusion: "success" })],
        runArtifacts: { [activationRunId]: [arm, closeout] },
        archives: new Map([
          [arm.id, armArchive],
          [closeout.id, closeoutArchive],
        ]),
      }) as typeof fetch,
      inventoryImpl: async () => live,
    })).resolves.toMatchObject({ outcome: "recovery_required" });
  });

  it("paginates every artifact row before finding an arm on page two", async () => {
    const armArchive = zip(armEntries());
    const arm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
      activationRunId,
      armArchive,
      1010,
    );
    const fillers = Array.from({ length: 100 }, (_, index) => ({
      id: 20_000 + index,
      name: `unrelated-${index}`,
    }));
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [mainRun()],
        runArtifacts: { [activationRunId]: [...fillers, arm] },
        archives: new Map([[arm.id, armArchive]]),
      }) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).resolves.toEqual(recoveryResult());
  });

  it("includes a run created before the epoch when it completed and armed after it", async () => {
    const armArchive = zip(armEntries());
    const arm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
      activationRunId,
      armArchive,
      1015,
    );
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [mainRun({
          created_at: "2026-08-31T23:50:00.000Z",
          updated_at: "2026-09-01T00:10:00.000Z",
        })],
        runArtifacts: { [activationRunId]: [arm] },
        archives: new Map([[arm.id, armArchive]]),
      }) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).resolves.toEqual(recoveryResult());
  });

  it("returns the oldest armed unresolved run", async () => {
    const olderArmArchive = zip(armEntries());
    const newerArmArchive = zip(armEntries(
      secondCandidate,
      secondActivationRunId,
    ));
    const olderArm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`,
      activationRunId,
      olderArmArchive,
      1011,
    );
    const newerArm = artifact(
      `pintpath-account-deletion-rehearsal-arm-${secondCandidate}`
        + `-${secondActivationRunId}`,
      secondActivationRunId,
      newerArmArchive,
      1012,
    );
    const older = mainRun({
      created_at: "2026-08-30T09:00:00.000Z",
      updated_at: "2026-09-01T08:00:00.000Z",
    });
    const newer = mainRun({
      id: Number(secondActivationRunId),
      head_sha: secondCandidate,
      created_at: "2026-09-01T09:00:00.000Z",
      updated_at: "2026-09-01T09:10:00.000Z",
    });
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [newer, older],
        runArtifacts: {
          [activationRunId]: [olderArm],
          [secondActivationRunId]: [newerArm],
        },
        archives: new Map([
          [olderArm.id, olderArmArchive],
          [newerArm.id, newerArmArchive],
        ]),
      }) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).resolves.toEqual(recoveryResult());
  });

  it("fails closed on duplicate exact cleanup arms", async () => {
    const armArchive = zip(armEntries());
    const name =
      `pintpath-account-deletion-rehearsal-arm-${candidate}-${activationRunId}`;
    const first = artifact(name, activationRunId, armArchive, 1013);
    const second = artifact(name, activationRunId, armArchive, 1014);
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({
        mainRuns: [mainRun()],
        runArtifacts: { [activationRunId]: [first, second] },
      }) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).rejects.toThrow("cleanup_arm_ambiguous");
  });

  it("blocks when the bounded run cap could hide an in-window run", async () => {
    const mainRuns = Array.from({ length: 1_000 }, (_, index) => mainRun({
      id: 10_000 + index,
      created_at: new Date(now - index * 60_000).toISOString(),
      updated_at: new Date(now - index * 30_000).toISOString(),
    }));
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => now,
      fetchImpl: fetchFor({ mainRuns, runTotal: 1_001 }) as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).rejects.toThrow("run_discovery_incomplete");
  });

  it("blocks at the fixed retention horizon until a reviewed epoch renewal", async () => {
    const expired = Date.parse("2026-09-01T00:00:00.000Z")
      + 89 * 24 * 60 * 60 * 1_000;
    await expect(discoverAccountDeletionRehearsalRecovery({
      env,
      now: () => expired,
      fetchImpl: fetchFor() as typeof fetch,
      inventoryImpl: inventoryForCurrentActivation(),
    })).rejects.toThrow("discovery_epoch_expired");
  });
});
