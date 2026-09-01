import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  ACCOUNT_DELETION_REHEARSAL_ATTEMPT_OPERATIONS,
  ACCOUNT_DELETION_REHEARSAL_ATTEMPT_INVENTORY_SCHEMA,
  inventoryAccountDeletionRehearsalAttempts,
} from "../scripts/inventory-github-account-deletion-rehearsal-attempts.mjs";

const repository = "blackmagic30/Beer";
const candidate = "a".repeat(40);
const activationRunId = "123";
const producerRunId = "456";
const producerHeadSha = "f".repeat(40);
const operation = "quarantine-zero";
const name = `pintpath-account-deletion-rehearsal-attempt-${operation}`
  + `-${candidate}-${activationRunId}`;
const token = "test-token-with-sufficient-length";
const temporaryDirectories: string[] = [];

function sha256(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function attemptFiles(overrides: Record<string, unknown> = {}) {
  const arm = {
    schemaVersion: "pintpath-account-deletion-rehearsal-attempt-arm/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    operation,
    candidateSha: candidate,
    activationRunId,
    githubRunId: producerRunId,
    projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
    environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    authoritySha256: "b".repeat(64),
    prerequisiteSha256: "c".repeat(64),
    providerSnapshotSha256: "d".repeat(64),
    providerInvariantSha256: "e".repeat(64),
    maximumAttempts: 1,
    retryAllowed: false,
    mutationCredentialExposed: false,
    secretMaterialIncluded: false,
    ...overrides,
  };
  const armSource = canonical(arm);
  const result = {
    ok: true,
    schemaVersion: arm.schemaVersion,
    operation: arm.operation,
    candidateSha: arm.candidateSha,
    activationRunId: arm.activationRunId,
    contentSha256: sha256(armSource),
    providerSnapshotSha256: arm.providerSnapshotSha256,
    providerInvariantSha256: arm.providerInvariantSha256,
    mutationCredentialExposed: false,
    secretMaterialIncluded: false,
  };
  return {
    "attempt-arm.json": armSource,
    "result.json": `${JSON.stringify(result)}\n`,
  };
}

function zip(files: Record<string, string>) {
  const directory = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "pintpath-inventory-test-",
  ));
  temporaryDirectories.push(directory);
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

function artifact(archive: Buffer, id = 789) {
  return {
    id,
    name,
    expired: false,
    size_in_bytes: archive.length,
    digest: `sha256:${sha256(archive)}`,
    archive_download_url:
      `https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`,
    workflow_run: { id: Number(producerRunId) },
  };
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fetchFor(options: {
  archive?: Buffer;
  artifacts?: readonly Record<string, unknown>[];
  conclusion?: string;
  latestRunAttempt?: number;
  status?: string;
} = {}) {
  return async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input
      : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/actions/artifacts")
      && url.searchParams.get("name") === name) {
      const artifacts = [...(options.artifacts ?? [])];
      return json({ total_count: artifacts.length, artifacts });
    }
    if (url.pathname.endsWith("/actions/artifacts")) {
      return json({ total_count: 0, artifacts: [] });
    }
    if (url.pathname.endsWith(`/actions/runs/${producerRunId}/attempts/1`)
      || url.pathname.endsWith(`/actions/runs/${producerRunId}`)) {
      const immutableAttemptOne = url.pathname.endsWith("/attempts/1");
      return json({
        id: Number(producerRunId),
        run_attempt: immutableAttemptOne ? 1 : options.latestRunAttempt ?? 1,
        status: options.status ?? "completed",
        conclusion: options.status === "in_progress"
          ? null : options.conclusion ?? "failure",
        event: "schedule",
        head_branch: "main",
        head_sha: producerHeadSha,
        path:
          ".github/workflows/reconcile-permanent-staging-account-deletion-rehearsal.yml",
        repository: { full_name: repository },
      });
    }
    if (url.pathname.endsWith("/zip") && options.archive) {
      return new Response(options.archive, {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    }
    throw new Error(`unexpected_url:${url.pathname}${url.search}`);
  };
}

const env = {
  GITHUB_REPOSITORY: repository,
  GITHUB_TOKEN: token,
  PINTPATH_ACCOUNT_DELETION_CANDIDATE_SHA: candidate,
  PINTPATH_ACCOUNT_DELETION_ACTIVATION_RUN_ID: activationRunId,
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("account-deletion rehearsal attempt inventory", () => {
  it("returns a complete empty inventory without mutation authority", async () => {
    const result = await inventoryAccountDeletionRehearsalAttempts({
      env,
      fetchImpl: fetchFor() as typeof fetch,
    });
    expect(result).toMatchObject({
      schemaVersion: ACCOUNT_DELETION_REHEARSAL_ATTEMPT_INVENTORY_SCHEMA,
      candidateSha: candidate,
      activationRunId,
      complete: true,
      mutationCredentialExposed: false,
      secretMaterialIncluded: false,
    });
    expect(Object.values(result.attempts).every((value) => value === null))
      .toBe(true);
    expect(Object.keys(result.attempts)).toEqual(
      ACCOUNT_DELETION_REHEARSAL_ATTEMPT_OPERATIONS,
    );
    expect(result.attempts["quarantine-zero-retry-1"]).toBeNull();
    expect(result.attempts["quarantine-zero-retry-2"]).toBeNull();
  });

  it("authenticates one canonical arm and binds it to its producer run", async () => {
    const archive = zip(attemptFiles());
    const result = await inventoryAccountDeletionRehearsalAttempts({
      env,
      fetchImpl: fetchFor({
        archive,
        artifacts: [artifact(archive)],
      }) as typeof fetch,
    });
    expect(result.attempts[operation]).toMatchObject({
      producerRunId,
      producerWorkflow: "reconcile",
      producerHeadSha,
      producerEvent: "schedule",
      providerSnapshotSha256: "d".repeat(64),
      providerInvariantSha256: "e".repeat(64),
    });
  });

  it("accepts an arm produced earlier in the currently running workflow", async () => {
    const archive = zip(attemptFiles());
    const result = await inventoryAccountDeletionRehearsalAttempts({
      env: { ...env, GITHUB_RUN_ID: producerRunId },
      fetchImpl: fetchFor({
        archive,
        artifacts: [artifact(archive)],
        status: "in_progress",
      }) as typeof fetch,
    });
    expect(result.attempts[operation]).toMatchObject({
      producerRunId,
      producerWorkflow: "reconcile",
    });
  });

  it("binds a completed arm to immutable attempt one after a later rerun", async () => {
    const archive = zip(attemptFiles());
    const result = await inventoryAccountDeletionRehearsalAttempts({
      env,
      fetchImpl: fetchFor({
        archive,
        artifacts: [artifact(archive)],
        latestRunAttempt: 2,
      }) as typeof fetch,
    });
    expect(result.attempts[operation]).toMatchObject({
      producerRunId,
      producerWorkflow: "reconcile",
    });
  });

  it("fails closed on duplicate arms for the same activation operation", async () => {
    const archive = zip(attemptFiles());
    await expect(inventoryAccountDeletionRehearsalAttempts({
      env,
      fetchImpl: fetchFor({
        archive,
        artifacts: [artifact(archive), artifact(archive, 790)],
      }) as typeof fetch,
    })).rejects.toThrow("attempt_history_ambiguous");
  });

  it("rejects malformed arm content and untrusted producer completion", async () => {
    const malformed = zip(attemptFiles({ retryAllowed: true }));
    await expect(inventoryAccountDeletionRehearsalAttempts({
      env,
      fetchImpl: fetchFor({
        archive: malformed,
        artifacts: [artifact(malformed)],
      }) as typeof fetch,
    })).rejects.toThrow("attempt_arm_invalid");

    const valid = zip(attemptFiles());
    await expect(inventoryAccountDeletionRehearsalAttempts({
      env,
      fetchImpl: fetchFor({
        archive: valid,
        artifacts: [artifact(valid)],
        conclusion: "neutral",
      }) as typeof fetch,
    })).rejects.toThrow("attempt_producer_invalid");
  });
});
