import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalPostgresBackupJson as canonical } from "../src/lib/postgres-logical-backup.js";
import {
  prepareRecoveryJitRunner,
  recoveryRunnerIdentity,
  verifyRecoveryJitJob,
  type RecoveryJitDependencies,
  type RecoveryRunnerRole,
} from "../scripts/control-production-recovery-jit-runner.js";
import {
  initializeEmergencyCleanupState,
  emergencyCleanupSha256 as hash,
  EMERGENCY_CLEANUP_STATE_REF,
  ACTIVATION_WORKFLOW_PATH,
  RAILWAY_CLEANUP_POLICY_SHA256,
  SUPABASE_CLEANUP_POLICY_SHA256,
} from "../scripts/lib/production-promotion-recovery-emergency-cleanup-state.js";

const RUN = "123456789";
const SHA = "a".repeat(40);
const NOW = new Date("2026-09-11T04:00:00.000Z");
const ARM = "PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_AUTHORITY";
const RAILWAY = "PINTPATH_RECOVERY_RAILWAY_TEARDOWN_AUTHORITY";
const SUPABASE = "PINTPATH_RECOVERY_SUPABASE_TEARDOWN_AUTHORITY";
const ACTIVATION_ENV = "production-promotion-recovery-activation";
const CLEANUP_ENV = "production-promotion-recovery-cleanup";
const POLICY = "e".repeat(64);
const NAMES = {
  "production-capture":
    "Capture production recovery authorities into immutable WORM",
  "disposable-recover": "Recover and prove exact disposable application",
};

function fixture(selectedRole: RecoveryRunnerRole = "production-capture") {
  const input = {
    candidateSha: SHA,
    runId: RUN,
    role: selectedRole,
    runnerGroupId: 1,
    authorityDirectory: "/private/authorities",
    journalDirectory: "/private/journal",
  };
  const files = new Map<string, string>();
  const written = new Map<string, string>();
  const calls: {
    method: string;
    endpoint: string;
    body?: Record<string, unknown>;
  }[] = [];
  const active = new Map<string, string>();
  const cleanup = new Map<string, string>();
  const target = {
    candidateSha: SHA,
    activationRunId: RUN,
    projectId: "11111111-1111-4111-8111-111111111111",
    projectName: "pintpath-disposable-restore-pilot",
    environmentId: "22222222-2222-4222-8222-222222222222",
    environmentName: "pintpath-disposable-restore-pilot",
    inventorySha256: "1".repeat(64),
    workspaceId: "33333333-3333-4333-8333-333333333333",
    workspaceName: "PintPath recovery",
    workspaceProjectInventorySha256: "",
    supabaseProjectRef: "abcdefghijklmnopqrst",
    supabaseProjectName: "pintpath-disposable-restore-pilot",
    organizationSlugSha256: hash("pilot-recovery"),
    destinationOriginSha256: hash("https://abcdefghijklmnopqrst.supabase.co"),
    destinationRestoreAuthoritySha256: "5".repeat(64),
  };
  const workspaceProjects = [
    { id: target.projectId, name: target.projectName },
  ];
  target.workspaceProjectInventorySha256 = hash(canonical(workspaceProjects));
  const issuedAt = "2026-09-11T03:00:00.000Z";
  const expiresAt = "2026-09-11T09:00:00.000Z";
  const sign = (
    name: string,
    prefix: string,
    schema: string,
    payload: Record<string, unknown>,
  ) => {
    const key = crypto.generateKeyPairSync("ed25519");
    const pem = key.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const full = {
      ...payload,
      reviewerIdSha256: "b".repeat(64),
      reviewerPublicKeySha256: hash(pem),
      issuedAt,
      expiresAt,
    };
    const source = canonical({
      schemaVersion: schema,
      payload: full,
      signatureBase64: crypto
        .sign(null, Buffer.from(canonical(full)), key.privateKey)
        .toString("base64"),
    });
    files.set(`/private/authorities/${name}.json`, source);
    files.set(`/private/authorities/${name}-public.pem`, pem);
    cleanup.set(`${prefix}_SHA256`, hash(source));
    cleanup.set(`${prefix}_PUBLIC_KEY_SHA256`, hash(pem));
    if (name === "arm") {
      active.set(`${prefix}_SHA256`, hash(source));
      active.set(`${prefix}_PUBLIC_KEY_SHA256`, hash(pem));
    }
    return { source, pem };
  };
  const lineage = hash(
    canonical({ repository: "blackmagic30/Beer", ...target }),
  );
  const arm = sign(
    "arm",
    ARM,
    "pintpath-production-promotion-recovery-emergency-cleanup-arm/v2",
    {
      schemaVersion:
        "pintpath-production-promotion-recovery-emergency-cleanup-arm-payload/v2",
      operation: "arm-exact-production-promotion-recovery-emergency-cleanup",
      singletonArmSlot: "production-promotion-recovery",
      mechanicalCasRequired: true,
      stateRef: EMERGENCY_CLEANUP_STATE_REF,
      armTransition: "initial",
      armLineageIdSha256: lineage,
      previousArmAuthoritySha256: null,
      renewalSequence: 0,
      repository: "blackmagic30/Beer",
      activationWorkflowPath: ACTIVATION_WORKFLOW_PATH,
      emergencyCleanupWorkflowPath:
        ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml",
      requiredGitRef: "refs/heads/main",
      requiredActivationRunAttempt: 1,
      ...target,
      railwayCleanupPolicySha256: RAILWAY_CLEANUP_POLICY_SHA256,
      supabaseCleanupPolicySha256: SUPABASE_CLEANUP_POLICY_SHA256,
    },
  );
  const state = initializeEmergencyCleanupState(
    {
      schemaVersion: 2,
      kind: "pintpath-production-promotion-recovery-emergency-cleanup-arm-verification",
      ok: true,
      ...target,
      armTransition: "initial",
      armLineageIdSha256: lineage,
      previousArmAuthoritySha256: null,
      renewalSequence: 0,
      issuedAt,
      expiresAt,
      authoritySha256: hash(arm.source),
      authorityPublicKeySha256: hash(arm.pem),
    },
    NOW.toISOString(),
  );
  const common = {
    candidateSha: SHA,
    repository: "blackmagic30/Beer",
    workflowPath: ACTIVATION_WORKFLOW_PATH,
    requiredGitRef: "refs/heads/main",
    requiredRunAttempt: 1,
    requiredGithubRunId: RUN,
    emergencyCleanupArmAuthoritySha256: hash(arm.source),
  };
  sign(
    "railway",
    RAILWAY,
    "pintpath-production-recovery-railway-teardown-authority/v2",
    {
      schemaVersion:
        "pintpath-production-recovery-railway-teardown-authority-payload/v2",
      operation: "delete-exact-disposable-railway-recovery-project",
      ...common,
      projectId: target.projectId,
      projectName: target.projectName,
      environmentId: target.environmentId,
      environmentName: target.environmentName,
      inventorySha256: target.inventorySha256,
      workspaceId: target.workspaceId,
      workspaceName: target.workspaceName,
      workspaceProjects,
      workspaceProjectInventorySha256: target.workspaceProjectInventorySha256,
      services: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          name: "postgres-restored",
        },
      ],
      serviceInstances: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          serviceId: "44444444-4444-4444-8444-444444444444",
          serviceName: "postgres-restored",
        },
      ],
      policySha256: RAILWAY_CLEANUP_POLICY_SHA256,
      forbiddenProjectIds: ["48d8c6cd-1c66-4148-874b-20877f48e1a5"],
      forbiddenEnvironmentIds: [
        "13dab015-df74-45c6-b26f-69323daea99a",
        "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
      ],
    },
  );
  sign(
    "supabase",
    SUPABASE,
    "pintpath-disposable-supabase-project-teardown-authority/v2",
    {
      schemaVersion:
        "pintpath-disposable-supabase-project-teardown-authority-payload/v2",
      operation: "delete-exact-disposable-supabase-project",
      ...common,
      projectRef: target.supabaseProjectRef,
      projectName: target.supabaseProjectName,
      destinationOrigin: "https://abcdefghijklmnopqrst.supabase.co",
      destinationOriginSha256: target.destinationOriginSha256,
      organizationSlug: "pilot-recovery",
      organizationSlugSha256: target.organizationSlugSha256,
      targetRailwayProjectId: target.projectId,
      targetRailwayEnvironmentId: target.environmentId,
      destinationRestoreAuthoritySha256:
        target.destinationRestoreAuthoritySha256,
    },
  );
  active.set(
    "PINTPATH_PRODUCTION_BACKUP_EPHEMERAL_RUNNER_POLICY_SHA256",
    POLICY,
  );
  active.set(
    "PINTPATH_DISPOSABLE_RECOVERY_EPHEMERAL_RUNNER_POLICY_SHA256",
    POLICY,
  );
  const identity = recoveryRunnerIdentity(RUN, selectedRole);
  const job = {
    id: 789,
    run_id: Number(RUN),
    head_sha: SHA,
    head_branch: "main",
    name: NAMES[selectedRole],
    status: "queued",
    conclusion: null,
    runner_id: 0,
    labels: identity.labels,
    runner_name: "",
    runner_group_id: 1,
  };
  const jobs = [job];
  if (selectedRole === "disposable-recover")
    jobs.unshift({
      ...job,
      id: 788,
      name: NAMES["production-capture"],
      status: "completed",
      conclusion: "success",
      runner_name: recoveryRunnerIdentity(RUN, "production-capture").name,
    } as typeof job);
  const secrets = (prefixes: string[], extra: string[] = []) =>
    [
      ...prefixes.flatMap((prefix) => [
        `${prefix}_BASE64`,
        `${prefix}_PUBLIC_KEY_BASE64`,
      ]),
      ...extra,
    ].map((name) => ({ name }));
  const actSecrets = secrets([ARM]);
  const cleanSecrets = secrets(
    [ARM, RAILWAY, SUPABASE],
    [
      "PINTPATH_RECOVERY_RAILWAY_READ_TOKEN",
      "PINTPATH_RECOVERY_RAILWAY_DELETE_TOKEN",
      "PINTPATH_RECOVERY_SUPABASE_READ_TOKEN",
      "PINTPATH_RECOVERY_SUPABASE_DELETE_TOKEN",
    ],
  );
  const responses = new Map<string, unknown>([
    ["/git/ref/heads/main", { object: { sha: SHA } }],
    [
      `/actions/runs/${RUN}`,
      {
        id: Number(RUN),
        run_attempt: 1,
        event: "workflow_dispatch",
        head_sha: SHA,
        head_branch: "main",
        path: ACTIVATION_WORKFLOW_PATH,
        status: "in_progress",
        conclusion: null,
        repository: { full_name: "blackmagic30/Beer" },
        head_repository: { full_name: "blackmagic30/Beer" },
      },
    ],
    [
      `/actions/runs/${RUN}/attempts/1/jobs?per_page=100`,
      { total_count: jobs.length, jobs },
    ],
    ["/actions/runners?per_page=100", { total_count: 0, runners: [] }],
    [
      `/contents/.pintpath/emergency-cleanup/state.json?ref=${encodeURIComponent(EMERGENCY_CLEANUP_STATE_REF)}`,
      {
        encoding: "base64",
        content: Buffer.from(canonical(state)).toString("base64"),
      },
    ],
    [
      `/environments/${ACTIVATION_ENV}/secrets?per_page=100`,
      { total_count: actSecrets.length, secrets: actSecrets },
    ],
    [
      `/environments/${CLEANUP_ENV}/secrets?per_page=100`,
      { total_count: cleanSecrets.length, secrets: cleanSecrets },
    ],
  ]);
  const dependencies: RecoveryJitDependencies = {
    now: () => NOW,
    readPrivate: (file) => {
      if (!files.has(file)) throw new Error("missing");
      return files.get(file)!;
    },
    writePrivate: (leaf, source) => {
      if (written.has(leaf)) throw new Error("exclusive file exists");
      written.set(leaf, source);
    },
    async request(method, endpoint, body) {
      calls.push({ method, endpoint, ...(body ? { body } : {}) });
      if (method === "POST")
        return {
          runner: {
            id: 456,
            name: identity.name,
            status: "offline",
            busy: false,
            labels: identity.labels.map((name) => ({ name })),
          },
          encoded_jit_config: "Y29uZmln",
        };
      if (
        endpoint === `/environments/${ACTIVATION_ENV}/variables?per_page=100` ||
        endpoint === `/environments/${CLEANUP_ENV}/variables?per_page=100`
      ) {
        const values = endpoint.includes(ACTIVATION_ENV) ? active : cleanup;
        return {
          total_count: values.size,
          variables: [...values].map(([name, value]) => ({ name, value })),
        };
      }
      if (!responses.has(endpoint)) throw new Error("unexpected endpoint");
      return responses.get(endpoint);
    },
  };
  return {
    input,
    dependencies,
    responses,
    written,
    calls,
    files,
    active,
    cleanup,
    job,
    jobs,
    identity,
    state,
    cleanSecrets,
  };
}

describe("exact-run recovery JIT eligibility controller", () => {
  it.each(["production-capture", "disposable-recover"] as const)(
    "registers one offline %s JIT runner only after actual signed authorities and exact held job",
    async (selectedRole) => {
      const f = fixture(selectedRole);
      const receipt = await prepareRecoveryJitRunner(f.input, f.dependencies);
      expect(f.calls.filter((call) => call.method === "POST")).toEqual([
        {
          method: "POST",
          endpoint: "/actions/runners/generate-jitconfig",
          body: {
            name: f.identity.name,
            runner_group_id: 1,
            labels: f.identity.labels,
            work_folder: "_work",
          },
        },
      ]);
      expect(receipt).toMatchObject({
        runnerId: 456,
        jobId: 789,
        runAttempt: 1,
        role: selectedRole,
        retryAllowed: false,
        writeAttempts: 1,
      });
      expect(f.written.size).toBe(3);
      expect(JSON.stringify(receipt)).not.toContain("Y29uZmln");
      await expect(
        prepareRecoveryJitRunner(f.input, f.dependencies),
      ).rejects.toThrow("exclusive file exists");
      expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    },
  );
  it.each([
    "base label only",
    "wrong run",
    "wrong role",
    "wrong attempt",
    "job assigned",
    "main changed",
    "missing arm",
    "missing cleanup token",
    "wrong authority pin",
    "tampered authority",
    "expired arm",
    "registered exact runner",
    "incomplete runner inventory",
  ])("rejects %s without registration", async (failure) => {
    const f = fixture();
    if (failure === "base label only") f.job.labels.pop();
    if (failure === "wrong run") f.job.run_id++;
    if (failure === "wrong role")
      f.job.labels = recoveryRunnerIdentity(RUN, "disposable-recover").labels;
    if (failure === "wrong attempt")
      (
        f.responses.get(`/actions/runs/${RUN}`) as Record<string, unknown>
      ).run_attempt = 2;
    if (failure === "job assigned") f.job.runner_id = 44;
    if (failure === "main changed")
      f.responses.set("/git/ref/heads/main", {
        object: { sha: "b".repeat(40) },
      });
    if (failure === "missing arm")
      f.files.delete("/private/authorities/arm.json");
    if (failure === "missing cleanup token") {
      f.cleanSecrets.pop();
      (
        f.responses.get(
          `/environments/${CLEANUP_ENV}/secrets?per_page=100`,
        ) as Record<string, unknown>
      ).total_count = f.cleanSecrets.length;
    }
    if (failure === "wrong authority pin")
      f.cleanup.set(`${RAILWAY}_SHA256`, "f".repeat(64));
    if (failure === "tampered authority") {
      const p = "/private/authorities/railway.json";
      const data = JSON.parse(f.files.get(p)!);
      data.payload.requiredGithubRunId = "99";
      const source = canonical(data);
      f.files.set(p, source);
      f.cleanup.set(`${RAILWAY}_SHA256`, hash(source));
    }
    if (failure === "expired arm")
      f.dependencies.now = () => new Date("2026-09-12T00:00:00.000Z");
    if (failure === "registered exact runner")
      f.responses.set("/actions/runners?per_page=100", {
        total_count: 1,
        runners: [{ name: f.identity.name }],
      });
    if (failure === "incomplete runner inventory")
      f.responses.set("/actions/runners?per_page=100", {
        total_count: 2,
        runners: [],
      });
    await expect(
      prepareRecoveryJitRunner(f.input, f.dependencies),
    ).rejects.toThrow();
    expect(f.calls.some((call) => call.method === "POST")).toBe(false);
  });
  it("preserves an uncertain one-write journal and cannot automatically register again", async () => {
    const f = fixture();
    const original = f.dependencies.request;
    f.dependencies.request = async (method, endpoint, body) => {
      const result = await original(method, endpoint, body);
      if (method === "POST") throw new Error("lost acknowledgment");
      return result;
    };
    await expect(
      prepareRecoveryJitRunner(f.input, f.dependencies),
    ).rejects.toThrow("registration_uncertain_no_retry");
    expect(
      [...f.written.keys()].some((leaf) => leaf.endsWith("uncertain.json")),
    ).toBe(true);
    await expect(
      prepareRecoveryJitRunner(f.input, f.dependencies),
    ).rejects.toThrow("exclusive file exists");
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
  it("rejects a changed authority during the immediate second observation", async () => {
    const f = fixture();
    const original = f.dependencies.request;
    let reads = 0;
    f.dependencies.request = async (method, endpoint, body) => {
      if (endpoint === "/git/ref/heads/main" && ++reads === 2)
        return { object: { sha: "b".repeat(40) } };
      return original(method, endpoint, body);
    };
    await expect(
      prepareRecoveryJitRunner(f.input, f.dependencies),
    ).rejects.toThrow("main_changed");
    expect(f.calls.some((call) => call.method === "POST")).toBe(false);
  });
  it("binds the root-installed proof to the actual assigned job without giving admin credentials to a data runner", async () => {
    const f = fixture();
    const receipt = await prepareRecoveryJitRunner(f.input, f.dependencies);
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "blackmagic30/Beer",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW_REF: `blackmagic30/Beer/${ACTIVATION_WORKFLOW_PATH}@refs/heads/main`,
      GITHUB_SHA: SHA,
      GITHUB_RUN_ID: RUN,
      GITHUB_JOB: "production-capture",
      RUNNER_NAME: f.identity.name,
      PINTPATH_PRODUCTION_BACKUP_EPHEMERAL_RUNNER_POLICY_SHA256: POLICY,
    };
    f.responses.set("/actions/jobs/789", {
      ...f.job,
      status: "in_progress",
      runner_id: 456,
      runner_name: f.identity.name,
    });
    expect(
      await verifyRecoveryJitJob(receipt, env, f.dependencies.request, NOW),
    ).toMatchObject({ ok: true, jobId: 789, runnerId: 456 });
    for (const changed of [
      { ...receipt, runnerId: 457 },
      { ...receipt, role: "disposable-recover" },
      { ...receipt, runAttempt: 2 },
      { ...receipt, jobId: 111 },
      {},
    ]) {
      await expect(
        verifyRecoveryJitJob(changed, env, f.dependencies.request, NOW),
      ).rejects.toThrow();
    }
    expect(
      f.calls.some((call) => /\/actions\/runners\/\d+$/.test(call.endpoint)),
    ).toBe(false);
  });
});
