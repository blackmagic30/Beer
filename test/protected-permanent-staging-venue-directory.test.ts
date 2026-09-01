import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  VENUE_DIRECTORY_CONSTRAINT_POSTFLIGHT_SCHEMA,
  VENUE_DIRECTORY_CONSTRAINT_PREFLIGHT_SCHEMA,
  VENUE_DIRECTORY_FENCED_AUTHORITY_SCHEMA,
  VENUE_DIRECTORY_IMPORT_TERMINAL_SCHEMA,
  VENUE_DIRECTORY_MIGRATION_APPLY_SCHEMA,
  VENUE_DIRECTORY_MIGRATION_PREWRITE_SCHEMA,
  VENUE_DIRECTORY_PLAN_SCHEMA,
  VENUE_DIRECTORY_POLICY_PATH,
  VENUE_DIRECTORY_POLICY_SHA256,
  VENUE_DIRECTORY_TERMINAL_SCHEMA,
  canonicalVenueDirectoryJson,
  runProtectedPermanentStagingVenueDirectory,
} from "../scripts/execute-protected-permanent-staging-venue-directory.js";

const root = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(root, ".github/workflows/permanent-staging-venue-directory.yml");
const policyPath = path.join(root, VENUE_DIRECTORY_POLICY_PATH);
const candidate = "a".repeat(40);
const fencedRunId = "4001";
const currentRunId = "5001";
const evidence = "/private/venue-evidence";
const authorityFile = `${evidence}/fenced-authority.json`;
const projectRef = "bbfibbadwjxzrcdncavy";
const targetFilename = "20260901032339_validate_external_venue_directory_constraints.sql";
const databaseContract = {
  migrationVersion: "20260901032339",
  migrationPath:
    "supabase/migrations/20260901032339_validate_external_venue_directory_constraints.sql",
  migrationSha256:
    "5068c2a678813e57fde83b29d3cb5e438ce9070705f246827b7ee8e2a70ee96c",
  migrationBytes: 161,
  validatedConstraints: [
    "venues_australian_postcode_check",
    "venues_business_status_check",
  ],
};

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function localVersions(): string[] {
  return fs.readdirSync(path.join(root, "supabase/migrations"))
    .filter((name) => /^[0-9]+_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => name.slice(0, name.indexOf("_")));
}

function environment(includeGoogle = true): Record<string, string> {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY: "blackmagic30/Beer",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: candidate,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: currentRunId,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/private/home",
    SUPABASE_URL: `https://${projectRef}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: "staging-secret-key",
    ...(includeGoogle ? { GOOGLE_PLACES_API_KEY: "staging-google-places-key" } : {}),
    SUPABASE_ACCESS_TOKEN: "staging-migration-token",
    SUPABASE_DB_PASSWORD: "staging-database-password",
    PINTPATH_VENUE_DIRECTORY_CONFIRMATION:
      `APPLY_REFRESH_VALIDATE_PERMANENT_STAGING_VENUE_DIRECTORY_${projectRef}_FOR_` +
      `${candidate}_AFTER_FENCED_RUN_${fencedRunId}`,
    PINTPATH_EXTERNAL_MUTATION_FREEZE_ATTESTATION:
      "I_ATTEST_EXTERNAL_PERMANENT_STAGING_VENUE_ROW_AND_SCHEMA_MIGRATION_WRITERS_ARE_FROZEN_FOR_THIS_RUN",
  };
}

function fencedAuthority() {
  return {
    schemaVersion: VENUE_DIRECTORY_FENCED_AUTHORITY_SCHEMA,
    repository: "blackmagic30/Beer",
    candidateSha: candidate,
    consumerWorkflowPath: ".github/workflows/permanent-staging-venue-directory.yml",
    consumerWorkflowRunId: currentRunId,
    consumerWorkflowRunAttempt: 1,
    fencedDeploymentWorkflowPath: ".github/workflows/deploy-permanent-staging.yml",
    fencedDeploymentRunId: fencedRunId,
    fencedDeploymentRunAttempt: 1,
    fencedDeploymentRunNumber: 88,
    fencedDeploymentCompletedAt: "2026-09-01T00:01:00.000Z",
    fencedDeploymentArtifactName:
      `pintpath-permanent-staging-fenced-deployment-${candidate}`,
    fencedDeploymentArtifactId: "6001",
    fencedDeploymentArtifactDigest: `sha256:${"b".repeat(64)}`,
    fencedDeploymentArtifactSizeBytes: 4096,
    fencedDeploymentReceiptSha256: "c".repeat(64),
    latestDeploymentRunExact: true,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
}

function emptyPlan() {
  const withoutDigest = {
    schemaVersion: VENUE_DIRECTORY_PLAN_SCHEMA,
    candidateSha: candidate,
    supabaseProjectRef: projectRef,
    databaseContract,
    operation: "directory-discovery-and-status-refresh",
    startedAt: "2026-09-01T00:03:00.000Z",
    completedAt: "2026-09-01T00:04:00.000Z",
    checkedAt: "2026-09-01T00:03:30.000Z",
    inputSnapshot: { rowCount: 0, sha256: "d".repeat(64) },
    collection: {
      discoveryCellAttemptedCount: 0,
      discoveryCellSuccessfulCount: 0,
      discoveryCellFailureCount: 0,
      discoveryQueryAttemptedCount: 0,
      discoveryQuerySuccessfulCount: 0,
      discoveryQueryFailureCount: 0,
      existingPlaceIdAttemptedCount: 0,
      existingPlaceIdSuccessfulCount: 0,
      existingPlaceIdFailureCount: 0,
      existingPlaceIdSatisfiedByDiscoveryCount: 0,
      existingRowMissingPlaceIdCount: 0,
      quarantinedVenueCount: 0,
    },
    projected: { insertCount: 0, updateCount: 0, exclusionCount: 0, totalTransitionCount: 0 },
    transitions: [],
  };
  return {
    ...withoutDigest,
    planSha256: sha256(canonicalVenueDirectoryJson(withoutDigest).slice(0, -1)),
  };
}

function importTerminal(plan: ReturnType<typeof emptyPlan>) {
  return {
    schemaVersion: VENUE_DIRECTORY_IMPORT_TERMINAL_SCHEMA,
    status: "succeeded",
    outcome: "applied",
    candidateSha: candidate,
    supabaseProjectRef: projectRef,
    databaseContract,
    planSha256: plan.planSha256,
    startedAt: "2026-09-01T00:09:00.000Z",
    completedAt: "2026-09-01T00:10:00.000Z",
    preflightSnapshot: plan.inputSnapshot,
    finalSnapshot: plan.inputSnapshot,
    attemptedWriteCount: 0,
    successfulWriteCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    excludedCount: 0,
    partialWrite: false,
    samePlanRetryAllowed: false,
    failure: null,
  };
}

function constraints(validated: boolean) {
  return [
    {
      name: "venues_australian_postcode_check",
      type: "c",
      validated,
      definition: "CHECK (((postcode IS NULL) OR (postcode ~ '^[0-9]{4}$'::text)))",
      businessStatus: 0,
      postcode: 0,
    },
    {
      name: "venues_business_status_check",
      type: "c",
      validated,
      definition:
        "CHECK ((business_status IS NULL OR business_status = ANY (ARRAY['OPERATIONAL','CLOSED_TEMPORARILY','CLOSED_PERMANENTLY','FUTURE_OPENING'])))",
      businessStatus: 0,
      postcode: 0,
    },
  ];
}

function targetLedger() {
  return {
    version: "20260901032339",
    name: "validate_external_venue_directory_constraints",
    statements: [
      "alter table public.venues\n  validate constraint venues_business_status_check",
      "alter table public.venues\n  validate constraint venues_australian_postcode_check",
    ],
  };
}

function ledger(steady: boolean) {
  return localVersions().slice(0, steady ? undefined : -1).map((version) =>
    version === "20260901032339" ? targetLedger() : {
      version,
      name: `migration_${version}`,
      statements: [],
    });
}

function commandHarness(
  files: Map<string, string>,
  plan: ReturnType<typeof emptyPlan>,
  mode: "first_run" | "steady_state",
  acknowledgement = true,
) {
  let observation = mode === "steady_state" ? "steady" : "first";
  const calls: string[][] = [];
  const runCommand = vi.fn((request: { command: string; args: readonly string[] }) => {
    const args = [...request.args];
    calls.push([request.command, ...args]);
    if (request.command === "supabase" && args.length === 1 && args[0] === "--version") {
      return { status: 0, signal: null, stdout: "2.109.1\n", stderr: "" };
    }
    if (request.command === "npm" && args.includes("--mode=plan")) {
      files.set(`${evidence}/venue-directory-plan.json`, canonicalVenueDirectoryJson(plan));
      return { status: 0, signal: null, stdout: "", stderr: "" };
    }
    if (request.command === "npm" && args.includes("--mode=apply")) {
      files.set(`${evidence}/venue-import-terminal.json`,
        canonicalVenueDirectoryJson(importTerminal(plan)));
      return { status: 0, signal: null, stdout: "", stderr: "" };
    }
    if (request.command === "supabase" && args[0] === "db" && args[1] === "push"
      && !args.includes("--dry-run")) {
      if (acknowledgement) observation = "steady";
      return {
        status: acknowledgement ? 0 : 1,
        signal: null,
        stdout: acknowledgement ? "Finished supabase db push.\n" : "",
        stderr: acknowledgement ? `Applying migration ${targetFilename}...\n` : "network lost\n",
      };
    }
    if (request.command === "supabase" && args[0] === "db" && args[1] === "push") {
      const first = observation === "first";
      return {
        status: 0,
        signal: null,
        stdout: first ? "Finished supabase db push.\n" : "Remote database is up to date.\n",
        stderr: first
          ? `DRY RUN: migrations will *not* be pushed to the database.\nWould push these migrations:\n • ${targetFilename}\n`
          : "DRY RUN: migrations will *not* be pushed to the database.\n",
      };
    }
    if (request.command === "supabase" && args[0] === "db" && args[1] === "query") {
      const sql = args.at(-1) ?? "";
      if (sql.startsWith("with violations")) {
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify(constraints(observation === "steady")),
          stderr: "",
        };
      }
      if (sql.startsWith("select version,name,statements")) {
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify(ledger(observation === "steady")),
          stderr: "",
        };
      }
    }
    return { status: 0, signal: null, stdout: "[]", stderr: "" };
  });
  return { calls, runCommand };
}

function dependencies(
  files: Map<string, string>,
  runCommand: ReturnType<typeof vi.fn>,
  argv: string[],
  env: Record<string, string>,
  times: string[],
) {
  let timeIndex = 0;
  return {
    argv,
    env,
    cwd: root,
    runCommand,
    now: () => new Date(times[Math.min(timeIndex++, times.length - 1)]!),
    readText: (filename: string) => {
      const source = files.get(filename);
      if (source === undefined) throw new Error("missing");
      return source;
    },
    writeExclusive: (directory: string, leaf: string, source: string) => {
      const filename = path.join(directory, leaf);
      if (files.has(filename)) throw new Error("exists");
      files.set(filename, source);
    },
    writeOutput: vi.fn(),
  };
}

function operationArgs(mode: string) {
  return [
    "--mode", mode,
    "--candidate-sha", candidate,
    "--fenced-deployment-run-id", fencedRunId,
    "--fenced-authority-file", authorityFile,
    "--evidence-dir", evidence,
  ];
}

async function preparePlan(mode: "first_run" | "steady_state") {
  const plan = emptyPlan();
  const files = new Map<string, string>([
    [authorityFile, canonicalVenueDirectoryJson(fencedAuthority())],
  ]);
  const harness = commandHarness(files, plan, mode);
  const code = await runProtectedPermanentStagingVenueDirectory(dependencies(
    files,
    harness.runCommand,
    operationArgs("plan-refresh-validate"),
    environment(true),
    ["2026-09-01T00:02:00.000Z", "2026-09-01T00:02:30.000Z"],
  ));
  expect(code).toBe(0);
  return { files, harness, plan };
}

describe("protected permanent-staging venue directory", () => {
  it("pins the protected workflow, two-state ledger contract, and exact secret inventory", () => {
    const workflow = fs.readFileSync(workflowPath, "utf8");
    const policySource = fs.readFileSync(policyPath, "utf8");
    const policy = JSON.parse(policySource) as Record<string, unknown>;
    expect(sha256(policySource)).toBe(VENUE_DIRECTORY_POLICY_SHA256);
    expect(policy).toEqual(expect.objectContaining({
      schemaVersion: "pintpath-protected-permanent-staging-venue-directory-policy/v1",
      githubEnvironment: "permanent-staging-venue-directory",
      databaseContract: expect.objectContaining({
        application: expect.objectContaining({
          mode: "REPEATABLE_EXACT_LEDGER_AWARE_PUSH_OR_PROVEN_NO_WRITE",
          firstRunMaximumPushInvocations: 1,
          steadyStateMaximumPushInvocations: 0,
          automaticRetriesAllowed: false,
          unexpectedOrExternalStateTransitionsAllowed: false,
        }),
      }),
    }));
    expect(workflow).toContain("name: Apply and prove permanent-staging venue directory");
    expect(workflow).toContain("environment: permanent-staging-venue-directory");
    expect(workflow).toContain("group: pintpath-permanent-staging-key-rollout");
    expect(workflow).toContain("version: 2.109.1");
    expect(workflow).toContain("--mode plan-refresh-validate");
    expect(workflow).toContain("--mode apply-refresh-validate");
    expect(workflow).toContain("--mode finalize-database-proof");
    expect(workflow).not.toContain('supabase db query --linked --file "$migration"');
    expect(workflow.match(/- name: Apply the exact venue plan and validate constraints/g))
      .toHaveLength(1);
    expect(workflow).toContain(
      "I_ATTEST_EXTERNAL_PERMANENT_STAGING_VENUE_ROW_AND_SCHEMA_MIGRATION_WRITERS_ARE_FROZEN_FOR_THIS_RUN",
    );
    const secretNames = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)]
      .map((match) => match[1]);
    expect(new Set(secretNames)).toEqual(new Set([
      "PINTPATH_SUPABASE_STAGING_DATABASE_MIGRATION_TOKEN",
      "PINTPATH_SUPABASE_STAGING_DATABASE_PASSWORD",
      "PINTPATH_STAGING_SUPABASE_SECRET_KEY",
      "PINTPATH_STAGING_GOOGLE_PLACES_API_KEY",
    ]));
    expect(workflow.indexOf("npm run check")).toBeLessThan(workflow.indexOf("${{ secrets."));
    expect(workflow).toContain(
      "name: pintpath-permanent-staging-venue-directory-${{ inputs.candidate_sha }}",
    );
  });

  it("seals a first-run plan only after exact read-only State A evidence", async () => {
    const { files, harness } = await preparePlan("first_run");
    const preflight = JSON.parse(files.get(`${evidence}/constraint-preflight.json`)!) as Record<string, unknown>;
    expect(preflight).toEqual(expect.objectContaining({
      schemaVersion: VENUE_DIRECTORY_CONSTRAINT_PREFLIGHT_SCHEMA,
      migrationMode: "first_run",
      remoteMigrationVersions: localVersions().slice(0, -1),
      targetLedger: null,
      violationCounts: { businessStatus: 0, postcode: 0 },
    }));
    expect(files.has(`${evidence}/venue-directory-plan.json`)).toBe(true);
    expect(files.has(`${evidence}/venue-directory-intent.json`)).toBe(true);
    expect(harness.calls.some((call) => call.includes("--mode=apply"))).toBe(false);
  });

  it("performs exactly one ledger-aware push, validates constraints, then applies the plan", async () => {
    const { files, harness, plan } = await preparePlan("first_run");
    const code = await runProtectedPermanentStagingVenueDirectory(dependencies(
      files,
      harness.runCommand,
      operationArgs("apply-refresh-validate"),
      environment(false),
      [
        "2026-09-01T00:05:00.000Z", "2026-09-01T00:06:00.000Z",
        "2026-09-01T00:07:00.000Z", "2026-09-01T00:08:00.000Z",
      ],
    ));
    expect(code).toBe(0);
    const actualPushes = harness.calls.filter((call) => call[0] === "supabase"
      && call[1] === "db" && call[2] === "push" && !call.includes("--dry-run"));
    expect(actualPushes).toEqual([[
      "supabase", "db", "push", "--linked", "--password",
      "staging-database-password", "--yes",
    ]]);
    expect(JSON.parse(files.get(`${evidence}/migration-apply.json`)!)).toEqual(
      expect.objectContaining({
        schemaVersion: VENUE_DIRECTORY_MIGRATION_APPLY_SCHEMA,
        migrationMode: "first_run",
        writeAttempts: 1,
        acknowledgement: "received",
      }),
    );
    expect(JSON.parse(files.get(`${evidence}/constraint-postflight.json`)!)).toEqual(
      expect.objectContaining({
        schemaVersion: VENUE_DIRECTORY_CONSTRAINT_POSTFLIGHT_SCHEMA,
        migrationMode: "first_run",
        remoteMigrationVersions: localVersions(),
      }),
    );
    expect(files.has(`${evidence}/venue-import-terminal.json`)).toBe(true);
    const finalizeCode = await runProtectedPermanentStagingVenueDirectory(dependencies(
      files,
      harness.runCommand,
      operationArgs("finalize-database-proof"),
      environment(false),
      ["2026-09-01T00:11:00.000Z"],
    ));
    expect(finalizeCode).toBe(0);
    const final = JSON.parse(files.get(`${evidence}/venue-directory-terminal.json`)!) as Record<string, unknown>;
    expect(final).toEqual(expect.objectContaining({
      schemaVersion: VENUE_DIRECTORY_TERMINAL_SCHEMA,
      status: "succeeded",
      outcome: "applied_and_validated",
      migrationMode: "first_run",
      planSha256: plan.planSha256,
      migrationWriteAttempts: 1,
      samePlanRetryAllowed: false,
    }));
    expect(final.importTerminalSha256).toBe(
      sha256(files.get(`${evidence}/venue-import-terminal.json`)!),
    );
  });

  it("is repeatable in steady state and performs zero migration writes", async () => {
    const { files, harness } = await preparePlan("steady_state");
    const code = await runProtectedPermanentStagingVenueDirectory(dependencies(
      files,
      harness.runCommand,
      operationArgs("apply-refresh-validate"),
      environment(false),
      [
        "2026-09-01T00:05:00.000Z", "2026-09-01T00:06:00.000Z",
        "2026-09-01T00:06:30.000Z", "2026-09-01T00:08:00.000Z",
      ],
    ));
    expect(code).toBe(0);
    expect(harness.calls.filter((call) => call[0] === "supabase"
      && call[1] === "db" && call[2] === "push" && !call.includes("--dry-run")))
      .toHaveLength(0);
    expect(JSON.parse(files.get(`${evidence}/migration-prewrite.json`)!)).toEqual(
      expect.objectContaining({
        schemaVersion: VENUE_DIRECTORY_MIGRATION_PREWRITE_SCHEMA,
        migrationMode: "steady_state",
      }),
    );
    expect(JSON.parse(files.get(`${evidence}/migration-apply.json`)!)).toEqual(
      expect.objectContaining({ writeAttempts: 0, acknowledgement: "not_attempted" }),
    );
  });

  it("rejects an external first-run to steady-state race before any write", async () => {
    const { files, plan } = await preparePlan("first_run");
    const raced = commandHarness(files, plan, "steady_state");
    await expect(runProtectedPermanentStagingVenueDirectory(dependencies(
      files,
      raced.runCommand,
      operationArgs("apply-refresh-validate"),
      environment(false),
      ["2026-09-01T00:05:00.000Z"],
    ))).rejects.toThrow("protected_permanent_staging_venue_directory_database_state_raced");
    expect(raced.calls.filter((call) => call[0] === "supabase"
      && call[1] === "db" && call[2] === "push" && !call.includes("--dry-run")))
      .toHaveLength(0);
    expect(raced.calls.some((call) => call.includes("--mode=apply"))).toBe(false);
  });

  it("stops before importer apply when first-run push acknowledgement is missing", async () => {
    const plan = emptyPlan();
    const files = new Map<string, string>([
      [authorityFile, canonicalVenueDirectoryJson(fencedAuthority())],
    ]);
    const planning = commandHarness(files, plan, "first_run");
    expect(await runProtectedPermanentStagingVenueDirectory(dependencies(
      files, planning.runCommand, operationArgs("plan-refresh-validate"), environment(true),
      ["2026-09-01T00:02:00.000Z", "2026-09-01T00:02:30.000Z"],
    ))).toBe(0);
    const failing = commandHarness(files, plan, "first_run", false);
    const code = await runProtectedPermanentStagingVenueDirectory(dependencies(
      files, failing.runCommand, operationArgs("apply-refresh-validate"), environment(false),
      ["2026-09-01T00:05:00.000Z", "2026-09-01T00:06:00.000Z", "2026-09-01T00:07:00.000Z"],
    ));
    expect(code).toBe(1);
    expect(files.has(`${evidence}/venue-import-terminal.json`)).toBe(false);
    expect(JSON.parse(files.get(`${evidence}/migration-apply.json`)!)).toEqual(
      expect.objectContaining({ acknowledgement: "missing_or_failed", writeAttempts: 1 }),
    );
    expect(failing.calls.some((call) => call.includes("--mode=apply"))).toBe(false);
  });
});
