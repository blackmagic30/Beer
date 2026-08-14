import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  PROTECTED_DISPOSABLE_SUPABASE_PROJECT_TEARDOWN_SCHEMA,
  SUPABASE_MANAGEMENT_ORIGIN,
  protectedDisposableSupabaseProjectTeardownInternals,
  runProtectedDisposableSupabaseProjectTeardown,
} from "../scripts/execute-protected-disposable-supabase-project-teardown.js";
import { initializeEmergencyCleanupState } from "../scripts/lib/production-promotion-recovery-emergency-cleanup-state.js";

const CANDIDATE = "c".repeat(40);
const PROJECT_REF = "bcdefghijklmnopqrstu";
const PROJECT_NAME = "pintpath-disposable-restore-20260814";
const ORGANIZATION = "pintpath-recovery";
const ORIGIN = `https://${PROJECT_REF}.supabase.co`;
const RAILWAY_PROJECT = "11111111-1111-4111-8111-111111111111";
const RAILWAY_ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const DESTINATION_RESTORE_AUTHORITY_SHA256 = "d".repeat(64);
const READ_TOKEN = "read-token-that-is-long-and-isolated";
const DELETE_TOKEN = "delete-token-that-is-long-and-isolated";
const NOW = new Date("2026-08-14T05:00:00.000Z");
const GITHUB_RUN_ID = "123456789";
const ARM_AUTHORITY_SHA256 = "e".repeat(64);
const roots: string[] = [];

function hash(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function installEmergencyState(value: ReturnType<typeof fixture>): void {
  const state = initializeEmergencyCleanupState(
    {
      schemaVersion: 2,
      kind: "pintpath-production-promotion-recovery-emergency-cleanup-arm-verification",
      ok: true,
      candidateSha: CANDIDATE,
      activationRunId: GITHUB_RUN_ID,
      projectId: RAILWAY_PROJECT,
      projectName: PROJECT_NAME,
      environmentId: RAILWAY_ENVIRONMENT,
      environmentName: PROJECT_NAME,
      inventorySha256: "1".repeat(64),
      workspaceId: "33333333-3333-4333-8333-333333333333",
      workspaceName: "PintPath recovery rehearsals",
      workspaceProjectInventorySha256: "2".repeat(64),
      supabaseProjectRef: value.projectRef,
      supabaseProjectName: PROJECT_NAME,
      organizationSlugSha256: hash(ORGANIZATION),
      destinationOriginSha256: hash(`https://${value.projectRef}.supabase.co`),
      destinationRestoreAuthoritySha256: DESTINATION_RESTORE_AUTHORITY_SHA256,
      armTransition: "initial",
      armLineageIdSha256: "b".repeat(64),
      previousArmAuthoritySha256: null,
      renewalSequence: 0,
      issuedAt: "2026-08-14T04:00:00.000Z",
      expiresAt: "2026-08-14T06:00:00.000Z",
      authoritySha256: ARM_AUTHORITY_SHA256,
      authorityPublicKeySha256: "a".repeat(64),
    },
    NOW.toISOString(),
  );
  const source = canonicalPostgresBackupJson(state);
  value.files["/private/emergency-state.json"] = source;
  for (const [key, replacement] of [
    ["--emergency-cleanup-state-file", "/private/emergency-state.json"],
    ["--emergency-cleanup-state-sha256", hash(source)],
  ] as const) {
    value.values[key] = replacement;
    value.argv[value.argv.indexOf(key) + 1] = replacement;
  }
}

function privateRoot(): string {
  const value = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-supabase-teardown-")),
  );
  fs.chmodSync(value, 0o700);
  roots.push(value);
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const value of roots.splice(0))
    fs.rmSync(value, { recursive: true, force: true });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function missingProject(): Response {
  return new Response(JSON.stringify({ message: "Project not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function directProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    ref: PROJECT_REF,
    organization_id: "44444444-4444-4444-8444-444444444444",
    organization_slug: ORGANIZATION,
    name: PROJECT_NAME,
    region: "ap-southeast-2",
    created_at: "2026-08-14T01:00:00Z",
    status: "ACTIVE_HEALTHY",
    database: {
      host: "db.bcdefghijklmnopqrstu.supabase.co",
      version: "17.4.1.065",
      postgres_engine: "17",
      release_channel: "ga",
    },
    ...overrides,
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    ref: PROJECT_REF,
    name: PROJECT_NAME,
    cloud_provider: "aws",
    region: "ap-southeast-2",
    is_branch: false,
    status: "ACTIVE_HEALTHY",
    inserted_at: "2026-08-14T01:00:00Z",
    databases: [
      {
        infra_compute_size: "small",
        region: "ap-southeast-2",
        status: "ACTIVE_HEALTHY",
        cloud_provider: "aws",
        identifier: "primary",
        type: "PRIMARY",
        disk_volume_size_gb: 8,
        disk_type: "gp3",
        disk_throughput_mbps: 125,
        disk_last_modified_at: "2026-08-14T01:00:00Z",
      },
    ],
    ...overrides,
  };
}

function inventory(
  projects: readonly unknown[],
  input: {
    readonly count?: number;
    readonly offset?: number;
    readonly limit?: number;
  } = {},
) {
  return {
    projects,
    pagination: {
      count: input.count ?? projects.length,
      limit: input.limit ?? 100,
      offset: input.offset ?? 0,
    },
  };
}

function fixture(
  input: {
    readonly projectRef?: string;
    readonly authoritySchema?: string;
    readonly readToken?: string;
    readonly deleteToken?: string;
    readonly cleanupMode?: "orderly" | "emergency";
    readonly authorityGithubRunId?: string;
  } = {},
) {
  const directory = privateRoot();
  const projectRef = input.projectRef ?? PROJECT_REF;
  const origin = `https://${projectRef}.supabase.co`;
  const purgeWithoutHash = {
    schemaVersion: 1,
    kind: "pintpath-postgres-private-storage-recovery-target-purge",
    ok: true,
    candidateSha: CANDIDATE,
    completedAt: "2026-08-14T04:30:00.000Z",
    destinationProjectRefSha256: hash(projectRef),
    targetRailwayProjectIdSha256: hash(RAILWAY_PROJECT),
    targetRailwayEnvironmentIdSha256: hash(RAILWAY_ENVIRONMENT),
    targetDatabaseIdentitySha256: "1".repeat(64),
    targetConnectionUrlSha256: "2".repeat(64),
    destinationOriginSha256: hash(origin),
    bucketNameSha256: hash("beermap-source-evidence"),
    destinationRestoreAuthoritySha256: DESTINATION_RESTORE_AUTHORITY_SHA256,
    purgeAuthoritySha256: "4".repeat(64),
    purgeAuthorityPublicKeySha256: "5".repeat(64),
    purgeAuthorityReviewerIdSha256: "6".repeat(64),
    recoverySetSha256: "7".repeat(64),
    recoveryManifestSha256: "8".repeat(64),
    restoreReceiptSha256: "9".repeat(64),
    restoredObjectSetSha256: "a".repeat(64),
    removedObjectCount: 1,
    bucketPrivateExact: true,
    restoredObjectSetExact: true,
    concurrentObjectSetAbsent: true,
    storageObjectsAbsentExact: true,
  };
  const purgeSource = canonicalPostgresBackupJson({
    ...purgeWithoutHash,
    receiptSha256: hash(canonicalPostgresBackupJson(purgeWithoutHash)),
  });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const payload = {
    schemaVersion:
      "pintpath-disposable-supabase-project-teardown-authority-payload/v2",
    operation: "delete-exact-disposable-supabase-project",
    candidateSha: CANDIDATE,
    projectRef,
    projectName: PROJECT_NAME,
    destinationOrigin: origin,
    destinationOriginSha256: hash(origin),
    organizationSlug: ORGANIZATION,
    organizationSlugSha256: hash(ORGANIZATION),
    targetRailwayProjectId: RAILWAY_PROJECT,
    targetRailwayEnvironmentId: RAILWAY_ENVIRONMENT,
    repository: "blackmagic30/Beer",
    workflowPath:
      ".github/workflows/activate-production-promotion-recovery.yml",
    requiredGitRef: "refs/heads/main",
    requiredRunAttempt: 1,
    requiredGithubRunId: input.authorityGithubRunId ?? GITHUB_RUN_ID,
    emergencyCleanupArmAuthoritySha256: ARM_AUTHORITY_SHA256,
    destinationRestoreAuthoritySha256: DESTINATION_RESTORE_AUTHORITY_SHA256,
    reviewerIdSha256: "b".repeat(64),
    reviewerPublicKeySha256: hash(publicKeyPem),
    issuedAt: "2026-08-14T04:00:00.000Z",
    expiresAt: "2026-08-14T06:00:00.000Z",
  };
  const authoritySource = canonicalPostgresBackupJson({
    schemaVersion:
      input.authoritySchema ??
      "pintpath-disposable-supabase-project-teardown-authority/v2",
    payload,
    signatureBase64: crypto
      .sign(null, Buffer.from(canonicalPostgresBackupJson(payload)), privateKey)
      .toString("base64"),
  });
  const files: Record<string, string> = {
    "/private/purge-receipt.json": purgeSource,
    "/private/teardown-authority.json": authoritySource,
    "/private/teardown-authority.pem": publicKeyPem,
    "/private/read-token": input.readToken ?? READ_TOKEN,
    "/private/delete-token": input.deleteToken ?? DELETE_TOKEN,
  };
  const values: Record<string, string> = {
    "--candidate-sha": CANDIDATE,
    "--activation-run-id": GITHUB_RUN_ID,
    "--project-ref": projectRef,
    "--project-name": PROJECT_NAME,
    "--organization-slug": ORGANIZATION,
    "--organization-slug-sha256": hash(ORGANIZATION),
    "--destination-origin-sha256": hash(origin),
    "--target-railway-project-id": RAILWAY_PROJECT,
    "--target-railway-environment-id": RAILWAY_ENVIRONMENT,
    "--cleanup-mode": input.cleanupMode ?? "orderly",
    "--destination-restore-authority-sha256":
      DESTINATION_RESTORE_AUTHORITY_SHA256,
    "--emergency-cleanup-arm-authority-sha256": ARM_AUTHORITY_SHA256,
    "--emergency-cleanup-state-file": "none",
    "--emergency-cleanup-state-sha256": "none",
    "--purge-receipt-file":
      input.cleanupMode === "emergency"
        ? "none"
        : "/private/purge-receipt.json",
    "--purge-receipt-sha256":
      input.cleanupMode === "emergency" ? "none" : hash(purgeSource),
    "--teardown-authority-file": "/private/teardown-authority.json",
    "--teardown-authority-sha256": hash(authoritySource),
    "--teardown-authority-public-key-file": "/private/teardown-authority.pem",
    "--teardown-authority-public-key-sha256": hash(publicKeyPem),
    "--read-token-file": "/private/read-token",
    "--delete-token-file": "/private/delete-token",
    "--evidence-dir": directory,
    "--output": path.join(directory, "supabase-project-teardown-terminal.json"),
  };
  return {
    projectRef,
    files,
    values,
    argv: Object.entries(values).flatMap(([key, value]) => [key, value]),
  };
}

function dependencies(
  value: ReturnType<typeof fixture>,
  fetchImpl: typeof fetch,
  options: { readonly githubRunId?: string; readonly watchdog?: boolean } = {
    githubRunId: GITHUB_RUN_ID,
  },
) {
  if (options.watchdog) installEmergencyState(value);
  const output: string[] = [];
  return {
    output,
    overrides: {
      argv: value.argv,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: options.githubRunId,
        GITHUB_EVENT_NAME: options.watchdog ? "schedule" : "workflow_dispatch",
        PINTPATH_CHECKED_OUT_CANDIDATE_SHA: CANDIDATE,
        GITHUB_WORKFLOW_REF: options.watchdog
          ? "blackmagic30/Beer/.github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml@refs/heads/main"
          : "blackmagic30/Beer/.github/workflows/activate-production-promotion-recovery.yml@refs/heads/main",
        PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARMED: options.watchdog
          ? "true"
          : undefined,
        PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_AUTHORITY_SHA256:
          options.watchdog ? ARM_AUTHORITY_SHA256 : undefined,
        PINTPATH_SUPABASE_PROJECT_TEARDOWN_CONFIRMATION: `DELETE_${value.projectRef}`,
      },
      cwd: process.cwd(),
      now: () => NOW,
      fetchImpl,
      readPrivateFile: async (filename: string) => {
        const source = value.files[filename];
        if (source === undefined) throw new Error("missing fixture");
        return source;
      },
      assertMutationAllowed: () => undefined,
      writeOutput: (source: string) => output.push(source),
    },
  };
}

describe("protected disposable Supabase project teardown", () => {
  it("pins the exact sorted permissions needed by inventory and direct project reads", () => {
    const policy = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          "ops/supabase/protected-disposable-project-teardown-policy.json",
        ),
        "utf8",
      ),
    );
    expect(policy.credentials).toMatchObject({
      readPermissions: ["organization_projects_read", "project_admin_read"],
      deletePermission: "project_admin_write",
    });
  });

  it("accepts documented transient project states and required-only database objects", () => {
    const value = project({
      ref: "abcdefghijklmnopqrst",
      name: "unrelated-project",
      status: "ACTIVE_UNHEALTHY",
      databases: [
        {
          region: "ap-southeast-2",
          status: "COMING_UP",
          cloud_provider: "aws",
          identifier: "primary",
          type: "PRIMARY",
        },
      ],
    });
    expect(() =>
      protectedDisposableSupabaseProjectTeardownInternals.parseProject(value),
    ).not.toThrow();
    expect(
      protectedDisposableSupabaseProjectTeardownInternals.parseProject(value),
    ).toMatchObject({
      ref: "abcdefghijklmnopqrst",
      status: "ACTIVE_UNHEALTHY",
    });
    expect(() =>
      protectedDisposableSupabaseProjectTeardownInternals.parseProject(
        project({
          ref: "abcdefghijklmnopqrst",
          name: "unrelated-project",
          databases: [
            {
              region: "ap-southeast-2",
              status: "COMING_UP",
              cloud_provider: "aws",
              identifier: "primary",
              type: "PRIMARY",
              undocumented_field: "reject",
            },
          ],
        }),
      ),
    ).toThrowError("inventory_invalid");
  });

  it("rejects fully rehashed purge receipts with any malformed SHA or count field", async () => {
    const mutations: ReadonlyArray<readonly [string, unknown]> = [
      ["targetDatabaseIdentitySha256", "not-a-sha"],
      ["targetConnectionUrlSha256", 42],
      ["bucketNameSha256", "f".repeat(64)],
      ["purgeAuthoritySha256", "short"],
      ["purgeAuthorityPublicKeySha256", null],
      ["purgeAuthorityReviewerIdSha256", "A".repeat(64)],
      ["recoverySetSha256", {}],
      ["recoveryManifestSha256", "0".repeat(63)],
      ["restoreReceiptSha256", true],
      ["restoredObjectSetSha256", "g".repeat(64)],
      ["removedObjectCount", -1],
      ["removedObjectCount", 1.5],
    ];
    for (const [field, replacement] of mutations) {
      const value = fixture();
      const parsed = JSON.parse(
        value.files["/private/purge-receipt.json"]!,
      ) as Record<string, unknown>;
      delete parsed.receiptSha256;
      parsed[field] = replacement;
      const source = canonicalPostgresBackupJson({
        ...parsed,
        receiptSha256: hash(canonicalPostgresBackupJson(parsed)),
      });
      value.files["/private/purge-receipt.json"] = source;
      value.values["--purge-receipt-sha256"] = hash(source);
      const index = value.argv.indexOf("--purge-receipt-sha256");
      value.argv[index + 1] = hash(source);
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const deps = dependencies(value, fetchImpl);
      expect(
        await runProtectedDisposableSupabaseProjectTeardown(deps.overrides),
        field,
      ).toBe(1);
      expect(fetchImpl, field).not.toHaveBeenCalled();
    }
  });

  it("deletes one signed disposable project once and proves whole-project absence", async () => {
    const value = fixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(inventory([project()])))
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(json(inventory([project()])))
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(
        json({ id: 42, ref: PROJECT_REF, name: PROJECT_NAME }),
      )
      .mockResolvedValueOnce(missingProject())
      .mockResolvedValueOnce(json(inventory([]))) as unknown as typeof fetch;
    vi.mocked(fetchImpl).mockResolvedValueOnce(missingProject());
    const deps = dependencies(value, fetchImpl);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown(deps.overrides),
    ).toBe(0);
    const calls = vi.mocked(fetchImpl).mock.calls;
    expect(calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(
      1,
    );
    expect(calls.filter(([, init]) => init?.method === "GET")).toHaveLength(7);
    expect(
      calls.every(
        ([url]) => new URL(String(url)).origin === SUPABASE_MANAGEMENT_ORIGIN,
      ),
    ).toBe(true);
    expect(
      calls
        .filter(([, init]) => init?.method === "GET")
        .every(
          ([, init]) =>
            (init?.headers as Record<string, string>).authorization ===
            `Bearer ${READ_TOKEN}`,
        ),
    ).toBe(true);
    expect(
      calls
        .filter(([, init]) => init?.method === "DELETE")
        .every(
          ([, init]) =>
            (init?.headers as Record<string, string>).authorization ===
            `Bearer ${DELETE_TOKEN}`,
        ),
    ).toBe(true);
    const terminalSource = fs.readFileSync(value.values["--output"]!, "utf8");
    const terminal = JSON.parse(terminalSource) as Record<string, unknown>;
    expect(terminal.schemaVersion).toBe(
      PROTECTED_DISPOSABLE_SUPABASE_PROJECT_TEARDOWN_SCHEMA,
    );
    const receipt = terminal.receipt as Record<string, unknown>;
    expect(receipt).toMatchObject({
      ok: true,
      outcome: "deleted",
      deleteAttempts: 1,
      observedCleanupRunId: GITHUB_RUN_ID,
      signedActivationRunId: GITHUB_RUN_ID,
      cleanupWorkflowPath:
        ".github/workflows/activate-production-promotion-recovery.yml",
      checks: { targetAbsentExact: true, terminalEvidenceExact: true },
    });
    const { receiptSha256, ...withoutHash } = receipt;
    expect(receiptSha256).toBe(hash(canonicalPostgresBackupJson(withoutHash)));
    expect(fs.statSync(value.values["--output"]!).mode & 0o7777).toBe(0o600);
    expect(
      fs.statSync(
        path.join(
          value.values["--evidence-dir"]!,
          "supabase-project-delete-intent.json",
        ),
      ).mode & 0o7777,
    ).toBe(0o600);
    expect(terminalSource).not.toContain(READ_TOKEN);
    expect(terminalSource).not.toContain(DELETE_TOKEN);
  });

  it("allows emergency cleanup from a distinct scheduled watchdog run bound to the activation", async () => {
    const value = fixture({ cleanupMode: "emergency" });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(inventory([project()])))
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(json(inventory([project()])))
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(
        json({ id: 42, ref: PROJECT_REF, name: PROJECT_NAME }),
      )
      .mockResolvedValueOnce(missingProject())
      .mockResolvedValueOnce(json(inventory([])))
      .mockResolvedValueOnce(missingProject()) as unknown as typeof fetch;
    const cleanupRunId = "987654321";
    const deps = dependencies(value, fetchImpl, {
      githubRunId: cleanupRunId,
      watchdog: true,
    });

    expect(
      await runProtectedDisposableSupabaseProjectTeardown(deps.overrides),
    ).toBe(0);
    const terminal = JSON.parse(
      fs.readFileSync(value.values["--output"]!, "utf8"),
    );
    expect(terminal.receipt).toMatchObject({
      ok: true,
      cleanupMode: "emergency",
      observedCleanupRunId: cleanupRunId,
      signedActivationRunId: GITHUB_RUN_ID,
      cleanupWorkflowPath:
        ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml",
      emergencyCleanupArmAuthoritySha256: ARM_AUTHORITY_SHA256,
    });
  });

  it("accepts a lost delete acknowledgement only after read-only absence reconciliation", async () => {
    const value = fixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(inventory([project()])))
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(json(inventory([project()])))
      .mockResolvedValueOnce(json(directProject()))
      .mockRejectedValueOnce(new Error("connection_lost_after_send"))
      .mockResolvedValueOnce(missingProject())
      .mockResolvedValueOnce(json(inventory([]))) as unknown as typeof fetch;
    vi.mocked(fetchImpl).mockResolvedValueOnce(missingProject());
    const deps = dependencies(value, fetchImpl);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown(deps.overrides),
    ).toBe(0);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
    const terminal = JSON.parse(
      fs.readFileSync(value.values["--output"]!, "utf8"),
    );
    expect(terminal.receipt).toMatchObject({
      ok: true,
      outcome: "deleted_reconciled",
      deleteAttempts: 1,
      checks: { acknowledgementExact: false, targetAbsentExact: true },
    });
  });

  it("does not green raw preflight absence without a persisted delete acknowledgement", async () => {
    const value = fixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(inventory([])))
      .mockResolvedValueOnce(missingProject())
      .mockResolvedValueOnce(json(inventory([])))
      .mockResolvedValueOnce(missingProject()) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown(deps.overrides),
    ).toBe(1);
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(4);
    const terminal = JSON.parse(
      fs.readFileSync(value.values["--output"]!, "utf8"),
    );
    expect(terminal.receipt).toMatchObject({
      ok: false,
      outcome: "already_absent",
      deleteAttempts: 0,
      checks: { targetAbsentExact: true },
    });
  });

  it("deletes in emergency cleanup mode without reading volatile purge evidence", async () => {
    const value = fixture({ cleanupMode: "emergency" });
    delete value.files["/private/purge-receipt.json"];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(inventory([project()])))
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(json(inventory([project()])))
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(
        json({ id: 42, ref: PROJECT_REF, name: PROJECT_NAME }),
      )
      .mockResolvedValueOnce(missingProject())
      .mockResolvedValueOnce(json(inventory([]))) as unknown as typeof fetch;
    vi.mocked(fetchImpl).mockResolvedValueOnce(missingProject());
    const deps = dependencies(value, fetchImpl);
    const readPrivateFile = vi.fn(deps.overrides.readPrivateFile);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown({
        ...deps.overrides,
        readPrivateFile,
      }),
    ).toBe(0);
    expect(readPrivateFile).not.toHaveBeenCalledWith(
      "/private/purge-receipt.json",
    );
    const terminal = JSON.parse(
      fs.readFileSync(value.values["--output"]!, "utf8"),
    );
    expect(terminal.receipt).toMatchObject({
      ok: true,
      cleanupMode: "emergency",
      purgeReceiptSha256: null,
      destinationRestoreAuthoritySha256: DESTINATION_RESTORE_AUTHORITY_SHA256,
      checks: {
        orderlyPurgeEvidenceExactOrNotRequired: true,
        targetAbsentExact: true,
      },
    });
  });

  it("rejects protected project refs before reading credentials or calling the provider", async () => {
    const value = fixture({ projectRef: "jxpubqlmqnnqwadmjgyk" });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const readPrivateFile = vi.fn(async () => "must-not-read");
    const deps = dependencies(value, fetchImpl);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown({
        ...deps.overrides,
        readPrivateFile,
      }),
    ).toBe(1);
    expect(readPrivateFile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an unrelated authority and equal credentials before provider access", async () => {
    const wrongAuthority = fixture({
      authoritySchema: "pintpath-private-storage-disposable-authority/v1",
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    let deps = dependencies(wrongAuthority, fetchImpl);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown(deps.overrides),
    ).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();

    const equalTokens = fixture({
      readToken: READ_TOKEN,
      deleteToken: READ_TOKEN,
    });
    deps = dependencies(equalTokens, fetchImpl);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown(deps.overrides),
    ).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a missing run ID and a teardown authority replayed in another run", async () => {
    const missing = fixture();
    let fetchImpl = vi.fn() as unknown as typeof fetch;
    let deps = dependencies(missing, fetchImpl, {});
    let readPrivateFile = vi.fn(deps.overrides.readPrivateFile);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown({
        ...deps.overrides,
        readPrivateFile,
      }),
    ).toBe(1);
    expect(readPrivateFile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    const replayed = fixture({ authorityGithubRunId: "123456788" });
    fetchImpl = vi.fn() as unknown as typeof fetch;
    deps = dependencies(replayed, fetchImpl);
    readPrivateFile = vi.fn(deps.overrides.readPrivateFile);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown({
        ...deps.overrides,
        readPrivateFile,
      }),
    ).toBe(1);
    expect(readPrivateFile).toHaveBeenCalledWith(
      "/private/teardown-authority.json",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed on incomplete pagination without issuing DELETE", async () => {
    const value = fixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json(inventory([], { count: 1 })),
      ) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown(deps.overrides),
    ).toBe(1);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(0);
    const terminal = JSON.parse(
      fs.readFileSync(value.values["--output"]!, "utf8"),
    );
    expect(terminal.receipt).toMatchObject({
      ok: false,
      outcome: "failed_before_attempt",
      deleteAttempts: 0,
      checks: { targetAbsentExact: false },
    });
  });

  it("cancels a response whose declared body exceeds the provider cap", async () => {
    const value = fixture();
    let cancelled = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel: () => {
              cancelled += 1;
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(2 * 1024 * 1024 + 1),
            },
          },
        ),
    ) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown(deps.overrides),
    ).toBe(1);
    await Promise.resolve();
    expect(cancelled).toBe(1);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });

  it("cancels an undeclared streamed provider body as soon as it crosses the cap", async () => {
    const value = fixture();
    let cancelled = 0;
    let pulls = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (controller) => {
              pulls += 1;
              controller.enqueue(
                new Uint8Array(pulls === 1 ? 2 * 1024 * 1024 : 1),
              );
            },
            cancel: () => {
              cancelled += 1;
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown(deps.overrides),
    ).toBe(1);
    expect(pulls).toBeGreaterThanOrEqual(2);
    expect(cancelled).toBe(1);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });

  it("uses the same deadline to cancel a stalled streamed provider body", async () => {
    const value = fixture();
    let cancelled = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
            cancel: () => {
              cancelled += 1;
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl);
    const startedAt = Date.now();
    expect(
      await runProtectedDisposableSupabaseProjectTeardown({
        ...deps.overrides,
        requestTimeoutMs: 15,
      }),
    ).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(cancelled).toBe(1);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });

  it("does not let mutable offset pagination hide a still-present target after delete", async () => {
    const value = fixture();
    const dummy = (index: number) =>
      project({
        ref: `p${String(index).padStart(19, "0")}`,
        name: `pintpath-disposable-restore-dummy-${index}`,
      });
    const stableFirst = [
      project(),
      ...Array.from({ length: 99 }, (_, index) => dummy(index)),
    ];
    const stableSecond = [dummy(99)];
    const shiftedFirst = Array.from({ length: 100 }, (_, index) =>
      dummy(index),
    );
    const shiftedSecond = [dummy(100)];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(inventory(stableFirst, { count: 101 })))
      .mockResolvedValueOnce(
        json(inventory(stableSecond, { count: 101, offset: 100 })),
      )
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(json(inventory(stableFirst, { count: 101 })))
      .mockResolvedValueOnce(
        json(inventory(stableSecond, { count: 101, offset: 100 })),
      )
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(
        json({ id: 42, ref: PROJECT_REF, name: PROJECT_NAME }),
      )
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(json(inventory(shiftedFirst, { count: 101 })))
      .mockResolvedValueOnce(
        json(inventory(shiftedSecond, { count: 101, offset: 100 })),
      )
      .mockResolvedValueOnce(json(directProject())) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown(deps.overrides),
    ).toBe(1);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
    const terminal = JSON.parse(
      fs.readFileSync(value.values["--output"]!, "utf8"),
    );
    expect(terminal.receipt).toMatchObject({
      ok: false,
      outcome: "mutation_uncertain",
      deleteAttempts: 1,
      checks: { postflightAttempted: true, targetAbsentExact: false },
    });
  });

  it("rejects output collisions and evidence-directory symlinks before credentials", async () => {
    const collision = fixture();
    fs.writeFileSync(collision.values["--output"]!, "occupied", {
      mode: 0o600,
    });
    let fetchImpl = vi.fn() as unknown as typeof fetch;
    let deps = dependencies(collision, fetchImpl);
    let readPrivateFile = vi.fn(deps.overrides.readPrivateFile);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown({
        ...deps.overrides,
        readPrivateFile,
      }),
    ).toBe(1);
    expect(readPrivateFile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    const symlinked = fixture();
    const evidenceDir = symlinked.values["--evidence-dir"]!;
    const realDir = `${evidenceDir}.real`;
    fs.renameSync(evidenceDir, realDir);
    roots.push(realDir);
    fs.symlinkSync(realDir, evidenceDir, "dir");
    fetchImpl = vi.fn() as unknown as typeof fetch;
    deps = dependencies(symlinked, fetchImpl);
    readPrivateFile = vi.fn(deps.overrides.readPrivateFile);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown({
        ...deps.overrides,
        readPrivateFile,
      }),
    ).toBe(1);
    expect(readPrivateFile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("detects evidence-directory replacement after preflight and never deletes", async () => {
    const value = fixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(inventory([project()])))
      .mockResolvedValueOnce(json(directProject())) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl);
    const evidenceDir = value.values["--evidence-dir"]!;
    const replaced = `${evidenceDir}.replaced`;
    const writePrivate = vi.fn((filename: string, payload: object) => {
      if (filename.endsWith("supabase-project-delete-intent.json")) {
        fs.renameSync(evidenceDir, replaced);
        roots.push(replaced);
        fs.mkdirSync(evidenceDir, { mode: 0o700 });
      }
      return hash(canonicalPostgresBackupJson(payload));
    });
    expect(
      await runProtectedDisposableSupabaseProjectTeardown({
        ...deps.overrides,
        writePrivate,
      }),
    ).toBe(1);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(0);
  });

  it("makes close failure dominant and writes no successful terminal", async () => {
    const value = fixture();
    const directory = value.values["--evidence-dir"]!;
    const stat = fs.statSync(directory, { bigint: true });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(inventory([project()])))
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(json(inventory([project()])))
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(
        json({ id: 42, ref: PROJECT_REF, name: PROJECT_NAME }),
      )
      .mockResolvedValueOnce(missingProject())
      .mockResolvedValueOnce(json(inventory([]))) as unknown as typeof fetch;
    vi.mocked(fetchImpl).mockResolvedValueOnce(missingProject());
    const deps = dependencies(value, fetchImpl);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown({
        ...deps.overrides,
        holdEvidenceDirectory: () => ({
          path: directory,
          identity: {
            dev: stat.dev,
            ino: stat.ino,
            mode: stat.mode,
            uid: stat.uid,
            gid: stat.gid,
          },
          assertExact: () => undefined,
          close: () => {
            throw new Error("synthetic_close_failure");
          },
        }),
      }),
    ).toBe(1);
    expect(fs.existsSync(value.values["--output"]!)).toBe(false);
  });

  it("rejects parent replacement after close before terminal output", async () => {
    const value = fixture();
    const directory = value.values["--evidence-dir"]!;
    const moved = `${directory}.after-close`;
    const stat = fs.statSync(directory, { bigint: true });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(inventory([project()])))
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(json(inventory([project()])))
      .mockResolvedValueOnce(json(directProject()))
      .mockResolvedValueOnce(
        json({ id: 42, ref: PROJECT_REF, name: PROJECT_NAME }),
      )
      .mockResolvedValueOnce(missingProject())
      .mockResolvedValueOnce(json(inventory([]))) as unknown as typeof fetch;
    vi.mocked(fetchImpl).mockResolvedValueOnce(missingProject());
    const deps = dependencies(value, fetchImpl);
    expect(
      await runProtectedDisposableSupabaseProjectTeardown({
        ...deps.overrides,
        holdEvidenceDirectory: () => ({
          path: directory,
          identity: {
            dev: stat.dev,
            ino: stat.ino,
            mode: stat.mode,
            uid: stat.uid,
            gid: stat.gid,
          },
          assertExact: () => undefined,
          close: () => {
            fs.renameSync(directory, moved);
            roots.push(moved);
            fs.mkdirSync(directory, { mode: 0o700 });
          },
        }),
      }),
    ).toBe(1);
    expect(fs.existsSync(value.values["--output"]!)).toBe(false);
  });
});
