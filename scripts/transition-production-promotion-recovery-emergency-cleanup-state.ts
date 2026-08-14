import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  assertEmergencyCleanupRenewalSuccessor,
  initializeEmergencyCleanupState,
  parseArmVerification,
  parseEmergencyCleanupState,
  priorAcknowledgementFor,
  recoverEmergencyCleanupAcknowledgements,
  reconcileEmergencyCleanupState,
  renewEmergencyCleanupState,
} from "./lib/production-promotion-recovery-emergency-cleanup-state.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";
import {
  holdPrivateDirectoryIdentity,
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

const ARGUMENTS = new Set([
  "--operation",
  "--state-file",
  "--base-state-file",
  "--arm-result-file",
  "--railway-terminal-file",
  "--supabase-terminal-file",
  "--prior-railway-terminal-file",
  "--prior-railway-cleanup-run-id",
  "--prior-supabase-terminal-file",
  "--prior-supabase-cleanup-run-id",
  "--observed-cleanup-run-id",
  "--output",
  "--github-env",
]);
const REQUIRED_ARGUMENTS = new Set([
  "--operation",
  "--state-file",
  "--arm-result-file",
  "--railway-terminal-file",
  "--supabase-terminal-file",
  "--observed-cleanup-run-id",
  "--output",
  "--github-env",
]);
const RUN_ID = /^[1-9]\d{0,19}$/;

export class EmergencyCleanupStateTransitionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EmergencyCleanupStateTransitionError";
  }
}

function fail(code: string): never {
  throw new EmergencyCleanupStateTransitionError(code);
}

function absoluteOrNone(value: string): string | null {
  if (value === "none") return null;
  if (
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.includes("\0")
  )
    fail("arguments_invalid");
  return value;
}

function runIdOrNone(value: string): string | null {
  if (value === "none") return null;
  if (!RUN_ID.test(value)) fail("arguments_invalid");
  return value;
}

function readPrivate(filename: string): string {
  try {
    return readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 512 * 1024,
      requireOwner: true,
      requirePrivate: true,
    }).toString("utf8");
  } catch {
    fail("private_file_unsafe");
  }
}

function parseJsonFile(filename: string | null): unknown {
  if (!filename) return undefined;
  const source = readPrivate(filename);
  try {
    const value: unknown = JSON.parse(source);
    if (canonicalPostgresBackupJson(value) !== source) fail("terminal_invalid");
    return value;
  } catch (error) {
    if (error instanceof EmergencyCleanupStateTransitionError) throw error;
    fail("terminal_invalid");
  }
}

function appendGithubEnvironment(
  filename: string,
  values: Record<string, string>,
) {
  const source = Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (/[\r\n]/.test(Object.values(values).join(""))) fail("state_invalid");
  fs.appendFileSync(filename, source, { encoding: "utf8", mode: 0o600 });
}

export function transitionEmergencyCleanupState(
  argv: readonly string[],
  now = new Date(),
) {
  let values: ReadonlyMap<string, string>;
  try {
    values = parseStrictArguments(argv, {
      allowed: ARGUMENTS,
      required: REQUIRED_ARGUMENTS,
    });
  } catch {
    fail("arguments_invalid");
  }
  const operation = values.get("--operation")!;
  if (
    ![
      "initialize",
      "renew",
      "inspect",
      "verify",
      "recover",
      "reconcile",
    ].includes(operation)
  )
    fail("arguments_invalid");
  const stateFile = absoluteOrNone(values.get("--state-file")!);
  const baseStateFile = absoluteOrNone(
    values.get("--base-state-file") ?? "none",
  );
  const armResultFile = absoluteOrNone(values.get("--arm-result-file")!);
  const railwayTerminalFile = absoluteOrNone(
    values.get("--railway-terminal-file")!,
  );
  const supabaseTerminalFile = absoluteOrNone(
    values.get("--supabase-terminal-file")!,
  );
  const priorRailwayTerminalFile = absoluteOrNone(
    values.get("--prior-railway-terminal-file") ?? "none",
  );
  const priorRailwayCleanupRunId = runIdOrNone(
    values.get("--prior-railway-cleanup-run-id") ?? "none",
  );
  const priorSupabaseTerminalFile = absoluteOrNone(
    values.get("--prior-supabase-terminal-file") ?? "none",
  );
  const priorSupabaseCleanupRunId = runIdOrNone(
    values.get("--prior-supabase-cleanup-run-id") ?? "none",
  );
  const output = absoluteOrNone(values.get("--output")!);
  const githubEnv = absoluteOrNone(values.get("--github-env")!);
  const observedCleanupRunId = values.get("--observed-cleanup-run-id")!;
  if (
    (operation !== "inspect" && !armResultFile) ||
    !RUN_ID.test(observedCleanupRunId) ||
    ((operation === "initialize" ||
      operation === "renew" ||
      operation === "recover" ||
      operation === "reconcile") &&
      !output) ||
    (operation !== "initialize" && !stateFile) ||
    (operation !== "reconcile" &&
      operation !== "inspect" &&
      (railwayTerminalFile || supabaseTerminalFile)) ||
    (operation !== "recover" &&
      operation !== "reconcile" &&
      (priorRailwayTerminalFile ||
        priorRailwayCleanupRunId ||
        priorSupabaseTerminalFile ||
        priorSupabaseCleanupRunId)) ||
    Boolean(priorRailwayTerminalFile) !== Boolean(priorRailwayCleanupRunId) ||
    Boolean(priorSupabaseTerminalFile) !== Boolean(priorSupabaseCleanupRunId) ||
    (baseStateFile !== null &&
      operation !== "verify" &&
      operation !== "recover" &&
      operation !== "reconcile")
  )
    fail("arguments_invalid");
  const arm = armResultFile
    ? parseArmVerification(readPrivate(armResultFile))
    : null;
  const current = stateFile
    ? parseEmergencyCleanupState(readPrivate(stateFile))
    : null;
  const baseState = baseStateFile
    ? parseEmergencyCleanupState(readPrivate(baseStateFile))
    : null;
  if (baseState)
    assertEmergencyCleanupRenewalSuccessor({
      previous: baseState,
      current: current!,
      arm: arm!,
    });
  let next = current;
  const timestamp = now.toISOString();
  if (operation === "initialize") {
    next = initializeEmergencyCleanupState(arm!, timestamp, current);
  } else if (operation === "renew") {
    next = renewEmergencyCleanupState(current!, arm!, timestamp);
  } else if (operation === "inspect") {
    if (current!.status !== "open") fail("state_not_open");
    const railway = parseJsonFile(railwayTerminalFile);
    const supabase = parseJsonFile(supabaseTerminalFile);
    if (
      canonicalPostgresBackupJson(railway ?? null) !==
        canonicalPostgresBackupJson(
          current!.railwayDeleteAcknowledgement ?? null,
        ) ||
      canonicalPostgresBackupJson(supabase ?? null) !==
        canonicalPostgresBackupJson(
          current!.supabaseDeleteAcknowledgement ?? null,
        )
    )
      fail("terminal_invalid");
  } else if (operation === "verify") {
    if (
      current!.status !== "open" ||
      current!.currentArmAuthoritySha256 !== arm!.authoritySha256 ||
      current!.armLineageIdSha256 !== arm!.armLineageIdSha256 ||
      current!.activationRunId !== arm!.activationRunId ||
      current!.candidateSha !== arm!.candidateSha ||
      Date.parse(current!.armExpiresAt) <= now.getTime()
    )
      fail("state_not_open");
  } else if (operation === "recover") {
    next = recoverEmergencyCleanupAcknowledgements({
      current: current!,
      arm: arm!,
      railwayTerminal: parseJsonFile(priorRailwayTerminalFile),
      ...(priorRailwayCleanupRunId
        ? { railwayCleanupRunId: priorRailwayCleanupRunId }
        : {}),
      supabaseTerminal: parseJsonFile(priorSupabaseTerminalFile),
      ...(priorSupabaseCleanupRunId
        ? { supabaseCleanupRunId: priorSupabaseCleanupRunId }
        : {}),
      now: timestamp,
    });
  } else {
    next = reconcileEmergencyCleanupState({
      current: current!,
      arm: arm!,
      observedCleanupRunId,
      priorRailwayTerminal: parseJsonFile(priorRailwayTerminalFile),
      ...(priorRailwayCleanupRunId ? { priorRailwayCleanupRunId } : {}),
      priorSupabaseTerminal: parseJsonFile(priorSupabaseTerminalFile),
      ...(priorSupabaseCleanupRunId ? { priorSupabaseCleanupRunId } : {}),
      railwayTerminal: parseJsonFile(railwayTerminalFile),
      supabaseTerminal: parseJsonFile(supabaseTerminalFile),
      now: timestamp,
    });
  }
  if (output && operation !== "verify" && operation !== "inspect") {
    const parent = holdPrivateDirectoryIdentity(path.dirname(output), {
      requireExactDirectoryMode: true,
      requireOwner: true,
    });
    try {
      parent.assertExact();
      if (fs.existsSync(output)) fail("output_unsafe");
      const identity = parent.identity;
      parent.close();
      writePrivateExclusiveFile(
        path.dirname(output),
        path.basename(output),
        canonicalPostgresBackupJson(next),
        {
          requireExactDirectoryMode: true,
          requireOwner: true,
          expectedDirectoryIdentity: identity,
        },
      );
    } catch (error) {
      try {
        parent.close();
      } catch {
        // The original custody failure remains dominant.
      }
      if (error instanceof EmergencyCleanupStateTransitionError) throw error;
      fail("output_unsafe");
    }
  }
  if (githubEnv) {
    const state = next!;
    const railwayAck = state.railwayDeleteAcknowledgement;
    const supabaseAck = state.supabaseDeleteAcknowledgement;
    appendGithubEnvironment(githubEnv, {
      PINTPATH_RECOVERY_EMERGENCY_CANDIDATE_SHA: state.candidateSha,
      PINTPATH_RECOVERY_EMERGENCY_ACTIVATION_RUN_ID: state.activationRunId,
      PINTPATH_RECOVERY_EMERGENCY_RAILWAY_PROJECT_ID: state.projectId,
      PINTPATH_RECOVERY_EMERGENCY_PROJECT_NAME: state.projectName,
      PINTPATH_RECOVERY_EMERGENCY_RAILWAY_ENVIRONMENT_ID: state.environmentId,
      PINTPATH_RECOVERY_EMERGENCY_RAILWAY_INVENTORY_SHA256:
        state.inventorySha256,
      PINTPATH_RECOVERY_EMERGENCY_RAILWAY_WORKSPACE_ID: state.workspaceId,
      PINTPATH_RECOVERY_EMERGENCY_RAILWAY_WORKSPACE_NAME: state.workspaceName,
      PINTPATH_RECOVERY_EMERGENCY_RAILWAY_WORKSPACE_PROJECT_INVENTORY_SHA256:
        state.workspaceProjectInventorySha256,
      PINTPATH_RECOVERY_EMERGENCY_SUPABASE_PROJECT_REF:
        state.supabaseProjectRef,
      PINTPATH_RECOVERY_SUPABASE_ORGANIZATION_SLUG_SHA256:
        state.organizationSlugSha256,
      PINTPATH_RECOVERY_TARGET_SUPABASE_ORIGIN_SHA256:
        state.destinationOriginSha256,
      PINTPATH_RECOVERY_DESTINATION_RESTORE_AUTHORITY_SHA256:
        state.destinationRestoreAuthoritySha256,
      PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_AUTHORITY_SHA256:
        state.currentArmAuthoritySha256,
      PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_AUTHORITY_PUBLIC_KEY_SHA256:
        state.currentArmAuthorityPublicKeySha256,
      PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_LINEAGE_ID_SHA256:
        state.armLineageIdSha256,
      PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARMED:
        state.status === "open" ? "true" : "false",
      PINTPATH_RECOVERY_EMERGENCY_RAILWAY_PRIOR_ACK: railwayAck
        ? "present"
        : "none",
      PINTPATH_RECOVERY_EMERGENCY_SUPABASE_PRIOR_ACK: supabaseAck
        ? "present"
        : "none",
    });
  }
  return next;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const state = transitionEmergencyCleanupState(process.argv.slice(2));
    process.stdout.write(
      canonicalPostgresBackupJson({
        schemaVersion: 1,
        ok: true,
        status: state?.status ?? "open",
        sequence: state?.sequence ?? null,
        stateSha256: state?.stateSha256 ?? null,
      }),
    );
  } catch (error) {
    process.stdout.write(
      canonicalPostgresBackupJson({
        schemaVersion: 1,
        ok: false,
        failureCode:
          error instanceof EmergencyCleanupStateTransitionError
            ? error.code
            : error instanceof Error
              ? error.message
              : "unexpected_failure",
      }),
    );
    process.exitCode = 1;
  }
}
