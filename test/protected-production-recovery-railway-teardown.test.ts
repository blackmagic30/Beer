import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import { protectedDisposableRestoreTeardownInternals } from "../scripts/execute-protected-disposable-restore-teardown.js";
import {
  PRODUCTION_RECOVERY_RAILWAY_TEARDOWN_TERMINAL_SCHEMA,
  productionRecoveryRailwayTeardownInternals,
  runProductionRecoveryRailwayTeardown,
} from "../scripts/execute-protected-production-recovery-railway-teardown.js";
import { initializeEmergencyCleanupState } from "../scripts/lib/production-promotion-recovery-emergency-cleanup-state.js";

const CANDIDATE = "a".repeat(40);
const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const SERVICE = "33333333-3333-4333-8333-333333333333";
const INSTANCE = "44444444-4444-4444-8444-444444444444";
const VOLUME = "55555555-5555-4555-8555-555555555555";
const VOLUME_INSTANCE = "66666666-6666-4666-8666-666666666666";
const BUCKET = "77777777-7777-4777-8777-777777777777";
const OTHER_PROJECT = "88888888-8888-4888-8888-888888888888";
const WORKSPACE = "99999999-9999-4999-8999-999999999999";
const WORKSPACE_NAME = "PintPath recovery rehearsals";
const NAME = "pintpath-disposable-restore-20260814";
const READ_TOKEN = "recovery-read-token-long-and-distinct";
const DELETE_TOKEN = "recovery-delete-token-long-and-distinct";
const POLICY_SHA256 =
  "4d1c22a4d5779f9383e133a1da8cfa40d10a6317343298210efc81e4f18403ef";
const GITHUB_RUN_ID = "123456789";
const ARM_AUTHORITY_SHA256 = "c".repeat(64);
const NOW = new Date("2026-08-14T05:00:00.000Z");
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
      projectId: value.values["--project-id"]!,
      projectName: NAME,
      environmentId: ENVIRONMENT,
      environmentName: NAME,
      inventorySha256: value.values["--inventory-sha256"]!,
      workspaceId: WORKSPACE,
      workspaceName: WORKSPACE_NAME,
      workspaceProjectInventorySha256:
        value.values["--workspace-project-inventory-sha256"]!,
      supabaseProjectRef: "bcdefghijklmnopqrstu",
      supabaseProjectName: NAME,
      organizationSlugSha256: "d".repeat(64),
      destinationOriginSha256: "e".repeat(64),
      destinationRestoreAuthoritySha256: "f".repeat(64),
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
    fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-railway-recovery-teardown-"),
    ),
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

function page(edges: unknown[]) {
  return {
    edges,
    pageInfo: { hasNextPage: false, endCursor: edges.length ? "end" : null },
  };
}

function workspaceProjects(projectId = PROJECT) {
  return [
    { id: projectId, name: NAME },
    { id: OTHER_PROJECT, name: "existing-reviewed-project" },
  ].sort((left, right) => left.id.localeCompare(right.id));
}

function workspaceInventoryResponse(input: {
  readonly projectId: string;
  readonly targetPresent: boolean;
  readonly workspaceId?: string;
  readonly workspaceName?: string;
  readonly incomplete?: boolean;
}): Response {
  const projects = workspaceProjects(input.projectId).filter(
    (project) => input.targetPresent || project.id !== input.projectId,
  );
  return json({
    data: {
      workspace: {
        id: input.workspaceId ?? WORKSPACE,
        name: input.workspaceName ?? WORKSPACE_NAME,
      },
      projects: {
        edges: projects.map((node) => ({ node })),
        pageInfo: input.incomplete
          ? { hasNextPage: true, endCursor: null }
          : { hasNextPage: false, endCursor: projects.length ? "end" : null },
      },
    },
  });
}

function providerInventory(
  input: { readonly serviceName?: string } = {},
): Record<string, unknown> {
  const serviceName = input.serviceName ?? "postgres-restored";
  return {
    data: {
      projectsByIds: [
        {
          id: PROJECT,
          name: NAME,
          isTempProject: true,
          baseEnvironmentId: ENVIRONMENT,
          primaryEnvironmentId: ENVIRONMENT,
          environments: page([
            {
              node: {
                id: ENVIRONMENT,
                name: NAME,
                projectId: PROJECT,
                isEphemeral: true,
                serviceInstances: page([
                  {
                    node: {
                      id: INSTANCE,
                      serviceId: SERVICE,
                      serviceName,
                      environmentId: ENVIRONMENT,
                    },
                  },
                ]),
                volumeInstances: page([
                  {
                    node: {
                      id: VOLUME_INSTANCE,
                      serviceId: SERVICE,
                      environmentId: ENVIRONMENT,
                      volume: {
                        id: VOLUME,
                        name: "restore-data",
                        projectId: PROJECT,
                      },
                    },
                  },
                ]),
              },
            },
          ]),
          services: page([
            { node: { id: SERVICE, name: serviceName, projectId: PROJECT } },
          ]),
          volumes: page([
            { node: { id: VOLUME, name: "restore-data", projectId: PROJECT } },
          ]),
          buckets: page([
            {
              node: {
                id: BUCKET,
                name: "restore-evidence",
                projectId: PROJECT,
              },
            },
          ]),
        },
      ],
    },
  };
}

function normalizedInventory(): Record<string, unknown> {
  const oldArgs = protectedDisposableRestoreTeardownInternals.parseArgs([
    "--candidate-sha",
    CANDIDATE,
    "--project-id",
    PROJECT,
    "--project-name",
    NAME,
    "--environment-id",
    ENVIRONMENT,
    "--environment-name",
    NAME,
    "--inventory-sha256",
    "f".repeat(64),
    "--evidence-dir",
    "/private/evidence",
  ]);
  const parsed = protectedDisposableRestoreTeardownInternals.inventory(
    providerInventory(),
    oldArgs!,
  );
  if (!parsed) throw new Error("fixture inventory invalid");
  return parsed;
}

function fixture(
  input: {
    readonly projectId?: string;
    readonly authorityOperation?: string;
    readonly authorityServiceName?: string;
    readonly authorityGithubRunId?: string;
    readonly readToken?: string;
    readonly deleteToken?: string;
    readonly authorityWorkspaceId?: string;
    readonly authorityWorkspaceName?: string;
  } = {},
) {
  const evidenceDir = privateRoot();
  const projectId = input.projectId ?? PROJECT;
  const inventory = normalizedInventory();
  const inventorySha256 = hash(`${JSON.stringify(inventory, null, 2)}\n`);
  const signedWorkspaceProjects = workspaceProjects(projectId);
  const workspaceProjectInventorySha256 = hash(
    canonicalPostgresBackupJson(signedWorkspaceProjects),
  );
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const payload = {
    schemaVersion:
      "pintpath-production-recovery-railway-teardown-authority-payload/v2",
    operation:
      input.authorityOperation ??
      "delete-exact-disposable-railway-recovery-project",
    candidateSha: CANDIDATE,
    repository: "blackmagic30/Beer",
    workflowPath:
      ".github/workflows/activate-production-promotion-recovery.yml",
    requiredGitRef: "refs/heads/main",
    requiredRunAttempt: 1,
    requiredGithubRunId: input.authorityGithubRunId ?? GITHUB_RUN_ID,
    emergencyCleanupArmAuthoritySha256: ARM_AUTHORITY_SHA256,
    projectId,
    projectName: NAME,
    environmentId: ENVIRONMENT,
    environmentName: NAME,
    inventorySha256,
    workspaceId: input.authorityWorkspaceId ?? WORKSPACE,
    workspaceName: input.authorityWorkspaceName ?? WORKSPACE_NAME,
    workspaceProjects: signedWorkspaceProjects,
    workspaceProjectInventorySha256,
    services: [
      { id: SERVICE, name: input.authorityServiceName ?? "postgres-restored" },
    ],
    serviceInstances: [
      {
        id: INSTANCE,
        serviceId: SERVICE,
        serviceName: input.authorityServiceName ?? "postgres-restored",
      },
    ],
    policySha256: POLICY_SHA256,
    forbiddenProjectIds: ["48d8c6cd-1c66-4148-874b-20877f48e1a5"],
    forbiddenEnvironmentIds: [
      "13dab015-df74-45c6-b26f-69323daea99a",
      "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    ],
    reviewerIdSha256: "b".repeat(64),
    reviewerPublicKeySha256: hash(publicKeyPem),
    issuedAt: "2026-08-14T04:00:00.000Z",
    expiresAt: "2026-08-14T06:00:00.000Z",
  };
  const authoritySource = canonicalPostgresBackupJson({
    schemaVersion: "pintpath-production-recovery-railway-teardown-authority/v2",
    payload,
    signatureBase64: crypto
      .sign(null, Buffer.from(canonicalPostgresBackupJson(payload)), privateKey)
      .toString("base64"),
  });
  const files: Record<string, string> = {
    "/private/authority.json": authoritySource,
    "/private/authority.pem": publicKeyPem,
    "/private/read-token": input.readToken ?? READ_TOKEN,
    "/private/delete-token": input.deleteToken ?? DELETE_TOKEN,
  };
  const values: Record<string, string> = {
    "--candidate-sha": CANDIDATE,
    "--activation-run-id": GITHUB_RUN_ID,
    "--project-id": projectId,
    "--project-name": NAME,
    "--environment-id": ENVIRONMENT,
    "--environment-name": NAME,
    "--inventory-sha256": inventorySha256,
    "--workspace-id": WORKSPACE,
    "--workspace-name": WORKSPACE_NAME,
    "--workspace-project-inventory-sha256": workspaceProjectInventorySha256,
    "--emergency-cleanup-arm-authority-sha256": ARM_AUTHORITY_SHA256,
    "--emergency-cleanup-state-file": "none",
    "--emergency-cleanup-state-sha256": "none",
    "--teardown-authority-file": "/private/authority.json",
    "--teardown-authority-sha256": hash(authoritySource),
    "--teardown-authority-public-key-file": "/private/authority.pem",
    "--teardown-authority-public-key-sha256": hash(publicKeyPem),
    "--read-token-file": "/private/read-token",
    "--delete-token-file": "/private/delete-token",
    "--evidence-dir": evidenceDir,
    "--output": path.join(evidenceDir, "railway-teardown-terminal.json"),
  };
  return {
    values,
    files,
    argv: Object.entries(values).flatMap(([key, value]) => [key, value]),
  };
}

function dependencies(
  value: ReturnType<typeof fixture>,
  fetchImpl: typeof fetch,
  options: {
    readonly githubRunId?: string;
    readonly targetPresent?: boolean;
    readonly workspaceId?: string;
    readonly workspaceName?: string;
    readonly workspaceIncomplete?: boolean;
    readonly workspaceMissing?: boolean;
    readonly passthroughWorkspace?: boolean;
    readonly watchdog?: boolean;
  } = { githubRunId: GITHUB_RUN_ID },
) {
  if (options.watchdog) installEmergencyState(value);
  const output: string[] = [];
  let mutationAttempted = false;
  const providerFetch = vi.fn(
    async (request: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
      };
      if (
        parsed.query?.includes("PintPathRecoveryWorkspaceInventory") &&
        options.passthroughWorkspace !== true
      ) {
        if (options.workspaceMissing === true) {
          return json({
            data: {
              workspace: null,
              projects: {
                edges: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        return workspaceInventoryResponse({
          projectId: value.values["--project-id"]!,
          targetPresent:
            (options.targetPresent ?? true) && mutationAttempted === false,
          workspaceId: options.workspaceId,
          workspaceName: options.workspaceName,
          incomplete: options.workspaceIncomplete,
        });
      }
      if (parsed.query?.includes("projectDelete")) mutationAttempted = true;
      return fetchImpl(request, init);
    },
  ) as unknown as typeof fetch;
  return {
    output,
    providerFetch,
    overrides: {
      argv: value.argv,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: options.githubRunId ?? GITHUB_RUN_ID,
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
        PINTPATH_RAILWAY_RECOVERY_TEARDOWN_CONFIRMATION: `DELETE_${value.values["--project-id"]}`,
      },
      cwd: process.cwd(),
      now: () => NOW,
      fetchImpl: providerFetch,
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

describe("protected production recovery Railway teardown", () => {
  it("binds the signed authority to the exact workspace inventory", () => {
    const value = fixture();
    const args = productionRecoveryRailwayTeardownInternals.parseArgs(
      value.argv,
    );
    expect(() =>
      productionRecoveryRailwayTeardownInternals.verifyAuthority({
        source: value.files["/private/authority.json"]!,
        sourceSha256: value.values["--teardown-authority-sha256"]!,
        publicKeyPem: value.files["/private/authority.pem"]!,
        publicKeySha256:
          value.values["--teardown-authority-public-key-sha256"]!,
        args,
        now: NOW,
      }),
    ).not.toThrow();
  });

  it("deletes the exact signed project once and proves absence", async () => {
    const value = fixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json({ data: { projectDelete: true } }))
      .mockResolvedValueOnce(json({ data: { projectsByIds: [] } }))
      .mockResolvedValueOnce(
        json({ data: { projectsByIds: [] } }),
      ) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl);
    expect(await runProductionRecoveryRailwayTeardown(deps.overrides)).toBe(0);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.filter((call) =>
          String((call[1] as RequestInit).body).includes("projectDelete"),
        ),
    ).toHaveLength(1);
    const terminalSource = fs.readFileSync(value.values["--output"]!, "utf8");
    const terminal = JSON.parse(terminalSource) as Record<string, unknown>;
    expect(terminal.schemaVersion).toBe(
      PRODUCTION_RECOVERY_RAILWAY_TEARDOWN_TERMINAL_SCHEMA,
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
      checks: {
        signedAuthorityExact: true,
        signedServiceInventoryExact: true,
        targetAbsentExact: true,
        terminalEvidenceExact: true,
      },
    });
    const { receiptSha256, ...withoutHash } = receipt;
    expect(receiptSha256).toBe(hash(canonicalPostgresBackupJson(withoutHash)));
    expect(terminalSource).not.toContain(READ_TOKEN);
    expect(terminalSource).not.toContain(DELETE_TOKEN);
    expect(fs.statSync(value.values["--output"]!).mode & 0o7777).toBe(0o600);
  });

  it("accepts a distinct scheduled watchdog run only under the signed activation arm", async () => {
    const value = fixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json({ data: { projectDelete: true } }))
      .mockResolvedValueOnce(json({ data: { projectsByIds: [] } }))
      .mockResolvedValueOnce(
        json({ data: { projectsByIds: [] } }),
      ) as unknown as typeof fetch;
    const cleanupRunId = "987654321";
    const deps = dependencies(value, fetchImpl, {
      githubRunId: cleanupRunId,
      watchdog: true,
    });

    expect(await runProductionRecoveryRailwayTeardown(deps.overrides)).toBe(0);
    const terminal = JSON.parse(
      fs.readFileSync(value.values["--output"]!, "utf8"),
    );
    expect(terminal.receipt).toMatchObject({
      ok: true,
      observedCleanupRunId: cleanupRunId,
      signedActivationRunId: GITHUB_RUN_ID,
      cleanupWorkflowPath:
        ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml",
      emergencyCleanupArmAuthoritySha256: ARM_AUTHORITY_SHA256,
    });
  });

  it("rejects transferred-or-deleted ambiguity after a lost acknowledgement", async () => {
    const value = fixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json(providerInventory()))
      .mockRejectedValueOnce(new Error("connection_lost_after_send"))
      .mockResolvedValueOnce(json({ data: { projectsByIds: [] } }))
      .mockResolvedValueOnce(
        json({ data: { projectsByIds: [] } }),
      ) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl);
    expect(await runProductionRecoveryRailwayTeardown(deps.overrides)).toBe(1);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.filter((call) =>
          String((call[1] as RequestInit).body).includes("projectDelete"),
        ),
    ).toHaveLength(1);
    const terminal = JSON.parse(
      fs.readFileSync(value.values["--output"]!, "utf8"),
    );
    expect(terminal.receipt).toMatchObject({
      ok: false,
      outcome: "mutation_uncertain",
      checks: { acknowledgementExact: false, targetAbsentExact: true },
    });
  });

  it("refuses to treat workspace-scoped preflight absence as global deletion", async () => {
    const value = fixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ data: { projectsByIds: [] } }))
      .mockResolvedValueOnce(json({ data: { projectsByIds: [] } }))
      .mockResolvedValueOnce(json({ data: { projectsByIds: [] } }))
      .mockResolvedValueOnce(
        json({ data: { projectsByIds: [] } }),
      ) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl, { targetPresent: false });
    expect(await runProductionRecoveryRailwayTeardown(deps.overrides)).toBe(1);
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

  it("rejects an absent-first target that reappears during the second observation", async () => {
    const value = fixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ data: { projectsByIds: [] } }))
      .mockResolvedValueOnce(json({ data: { projectsByIds: [] } }))
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(
        json(providerInventory()),
      ) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl, { targetPresent: false });

    expect(await runProductionRecoveryRailwayTeardown(deps.overrides)).toBe(1);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([, init]) =>
          String(init?.body).includes("projectDelete"),
        ),
    ).toBe(false);
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

  it("rejects wrong, missing, or incompletely paginated workspace authority", async () => {
    for (const options of [
      { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { workspaceName: "Wrong recovery workspace" },
      { workspaceMissing: true },
      { workspaceIncomplete: true },
    ]) {
      const value = fixture();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(json(providerInventory()))
        .mockResolvedValueOnce(
          json(providerInventory()),
        ) as unknown as typeof fetch;
      const deps = dependencies(value, fetchImpl, options);
      expect(await runProductionRecoveryRailwayTeardown(deps.overrides)).toBe(
        1,
      );
      expect(
        vi
          .mocked(fetchImpl)
          .mock.calls.some(([, init]) =>
            String(init?.body).includes("projectDelete"),
          ),
      ).toBe(false);
      const terminal = JSON.parse(
        fs.readFileSync(value.values["--output"]!, "utf8"),
      );
      expect(terminal.receipt).toMatchObject({
        ok: false,
        deleteAttempts: 0,
        checks: { targetAbsentExact: false },
      });
    }
  });

  it("rejects a production target or wrong operation before credentials/provider", async () => {
    for (const value of [
      fixture({ projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5" }),
      fixture({ authorityOperation: "restore-exact-disposable-project" }),
    ]) {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const deps = dependencies(value, fetchImpl);
      const readPrivateFile = vi.fn(deps.overrides.readPrivateFile);
      expect(
        await runProductionRecoveryRailwayTeardown({
          ...deps.overrides,
          readPrivateFile,
        }),
      ).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled();
      if (
        value.values["--project-id"] === "48d8c6cd-1c66-4148-874b-20877f48e1a5"
      ) {
        expect(readPrivateFile).not.toHaveBeenCalled();
      }
    }
  });

  it("rejects a missing run ID and a teardown authority replayed in another run", async () => {
    const missing = fixture();
    let fetchImpl = vi.fn() as unknown as typeof fetch;
    let deps = dependencies(missing, fetchImpl, { githubRunId: "" });
    let readPrivateFile = vi.fn(deps.overrides.readPrivateFile);
    expect(
      await runProductionRecoveryRailwayTeardown({
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
      await runProductionRecoveryRailwayTeardown({
        ...deps.overrides,
        readPrivateFile,
      }),
    ).toBe(1);
    expect(readPrivateFile).toHaveBeenCalledWith("/private/authority.json");
    expect(readPrivateFile).not.toHaveBeenCalledWith("/private/delete-token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cancels provider responses whose declared bodies exceed the cap", async () => {
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
    const deps = dependencies(value, fetchImpl, { passthroughWorkspace: true });
    expect(await runProductionRecoveryRailwayTeardown(deps.overrides)).toBe(1);
    await Promise.resolve();
    expect(cancelled).toBe(4);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([, init]) =>
          String(init?.body).includes("projectDelete"),
        ),
    ).toBe(false);
  });

  it("cancels undeclared streamed provider bodies when they cross the cap", async () => {
    const value = fixture();
    let cancelled = 0;
    const pulls = new WeakMap<object, number>();
    const fetchImpl = vi.fn(async () => {
      const source = {
        pull: (controller: ReadableStreamDefaultController<Uint8Array>) => {
          const next = (pulls.get(source) ?? 0) + 1;
          pulls.set(source, next);
          controller.enqueue(new Uint8Array(next === 1 ? 2 * 1024 * 1024 : 1));
        },
        cancel: () => {
          cancelled += 1;
        },
      };
      return new Response(new ReadableStream<Uint8Array>(source), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl, { passthroughWorkspace: true });
    expect(await runProductionRecoveryRailwayTeardown(deps.overrides)).toBe(1);
    expect(cancelled).toBe(4);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([, init]) =>
          String(init?.body).includes("projectDelete"),
        ),
    ).toBe(false);
  });

  it("uses the same deadline to cancel stalled streamed provider bodies", async () => {
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
    const deps = dependencies(value, fetchImpl, { passthroughWorkspace: true });
    const startedAt = Date.now();
    expect(
      await runProductionRecoveryRailwayTeardown({
        ...deps.overrides,
        requestTimeoutMs: 15,
      }),
    ).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cancelled).toBe(4);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([, init]) =>
          String(init?.body).includes("projectDelete"),
        ),
    ).toBe(false);
  });

  it("rejects service inventory substitution and equal credentials before mutation", async () => {
    const substituted = fixture({ authorityServiceName: "another-service" });
    let fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(
        json(providerInventory()),
      ) as unknown as typeof fetch;
    let deps = dependencies(substituted, fetchImpl);
    expect(await runProductionRecoveryRailwayTeardown(deps.overrides)).toBe(1);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.filter((call) =>
          String((call[1] as RequestInit).body).includes("projectDelete"),
        ),
    ).toHaveLength(0);

    const equal = fixture({ readToken: READ_TOKEN, deleteToken: READ_TOKEN });
    fetchImpl = vi.fn() as unknown as typeof fetch;
    deps = dependencies(equal, fetchImpl);
    expect(await runProductionRecoveryRailwayTeardown(deps.overrides)).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects output collision and evidence-directory symlink before private reads", async () => {
    const collision = fixture();
    fs.writeFileSync(collision.values["--output"]!, "occupied", {
      mode: 0o600,
    });
    let fetchImpl = vi.fn() as unknown as typeof fetch;
    let deps = dependencies(collision, fetchImpl);
    let readPrivateFile = vi.fn(deps.overrides.readPrivateFile);
    expect(
      await runProductionRecoveryRailwayTeardown({
        ...deps.overrides,
        readPrivateFile,
      }),
    ).toBe(1);
    expect(readPrivateFile).not.toHaveBeenCalled();

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
      await runProductionRecoveryRailwayTeardown({
        ...deps.overrides,
        readPrivateFile,
      }),
    ).toBe(1);
    expect(readPrivateFile).not.toHaveBeenCalled();
  });

  it("detects an evidence-directory swap during DELETE and emits no green terminal", async () => {
    const value = fixture();
    const evidenceDir = value.values["--evidence-dir"]!;
    const moved = `${evidenceDir}.moved`;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = String(init?.body);
        if (body.includes("projectDelete")) {
          fs.renameSync(evidenceDir, moved);
          roots.push(moved);
          fs.mkdirSync(evidenceDir, { mode: 0o700 });
          return json({ data: { projectDelete: true } });
        }
        if (vi.mocked(fetchImpl).mock.calls.length >= 5) {
          return json({ data: { projectsByIds: [] } });
        }
        return json(providerInventory());
      },
    ) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl);
    expect(await runProductionRecoveryRailwayTeardown(deps.overrides)).toBe(1);
    expect(fs.existsSync(value.values["--output"]!)).toBe(false);
  });

  it("makes held-directory close failure dominant before writing any green terminal", async () => {
    const value = fixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json({ data: { projectDelete: true } }))
      .mockResolvedValueOnce(
        json({ data: { projectsByIds: [] } }),
      ) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl);
    expect(
      await runProductionRecoveryRailwayTeardown({
        ...deps.overrides,
        holdEvidenceDirectory: (directory: string) => ({
          path: directory,
          identity: (() => {
            const stat = fs.statSync(directory, { bigint: true });
            return {
              dev: stat.dev,
              ino: stat.ino,
              mode: stat.mode,
              uid: stat.uid,
              gid: stat.gid,
            };
          })(),
          assertExact: () => undefined,
          close: () => {
            throw new Error("synthetic_close_failure");
          },
        }),
      }),
    ).toBe(1);
    expect(fs.existsSync(value.values["--output"]!)).toBe(false);
    expect(JSON.parse(deps.output.at(-1)!)).toMatchObject({
      ok: false,
      outcome: "mutation_uncertain",
    });
  });

  it("rejects parent replacement after held-directory close before terminal write", async () => {
    const value = fixture();
    const evidenceDir = value.values["--evidence-dir"]!;
    const moved = `${evidenceDir}.after-close`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json(providerInventory()))
      .mockResolvedValueOnce(json({ data: { projectDelete: true } }))
      .mockResolvedValueOnce(
        json({ data: { projectsByIds: [] } }),
      ) as unknown as typeof fetch;
    const deps = dependencies(value, fetchImpl);
    expect(
      await runProductionRecoveryRailwayTeardown({
        ...deps.overrides,
        holdEvidenceDirectory: (directory: string) => {
          const stat = fs.statSync(directory, { bigint: true });
          return {
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
          };
        },
      }),
    ).toBe(1);
    expect(fs.existsSync(value.values["--output"]!)).toBe(false);
  });
});
