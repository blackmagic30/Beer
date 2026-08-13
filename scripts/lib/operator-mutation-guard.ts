const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);
const RESTORE_MARKER_NAMES = [
  "RESTORE_REHEARSAL_PHASE",
  "RESTORE_REHEARSAL_BACKUP_ID",
  "RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256",
  "RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256",
  "RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID",
  "RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID",
  "RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID",
  "RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL",
  "RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID",
  "RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL",
  "RESTORE_REHEARSAL_BACKUP_SUPABASE_URL",
  "RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID",
  "RESTORE_REHEARSAL_REDIS_SERVICE_ID",
  "RESTORE_REHEARSAL_REDIS_SENTINEL",
  "RESTORE_REHEARSAL_ACCESS_USERNAME",
  "RESTORE_REHEARSAL_ACCESS_PASSWORD",
] as const;

function exactEnvironmentMatch(
  environment: NodeJS.ProcessEnv,
  actualName: string,
  expectedName: string,
): boolean {
  const expected = environment[expectedName]?.trim();
  return Boolean(expected) && environment[actualName]?.trim() === expected;
}

function exactHttpOriginMatch(actualValue: string | undefined, expectedValue: string | undefined): boolean {
  const expected = expectedValue?.trim();
  if (!actualValue?.trim() || !expected) return false;

  try {
    return new URL(actualValue).origin.toLowerCase() === new URL(expected).origin.toLowerCase();
  } catch {
    return false;
  }
}

function hasRestoreRehearsalMarkers(environment: NodeJS.ProcessEnv): boolean {
  if (
    exactEnvironmentMatch(
      environment,
      "RAILWAY_ENVIRONMENT_ID",
      "RESTORE_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID",
    ) ||
    exactEnvironmentMatch(
      environment,
      "RAILWAY_PROJECT_ID",
      "RESTORE_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID",
    ) ||
    exactEnvironmentMatch(
      environment,
      "RAILWAY_SERVICE_ID",
      "RESTORE_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID",
    ) ||
    exactEnvironmentMatch(
      environment,
      "RESTORE_REHEARSAL_REDIS_SERVICE_ID",
      "RESTORE_REHEARSAL_EXPECTED_REDIS_SERVICE_ID",
    ) ||
    exactHttpOriginMatch(
      environment.SUPABASE_URL,
      environment.RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL,
    )
  ) {
    return true;
  }

  // Any configured restore pin or marker keeps containment enabled even when
  // the current identity is missing or mismatched. The startup validator owns
  // the exact-match diagnostics; operator scripts must fail closed first.
  if (RESTORE_MARKER_NAMES.some((name) => Boolean(environment[name]?.trim()))) {
    return true;
  }
  if (environment.REDIS_KEY_NAMESPACE?.trim().startsWith("pint-path:restore:")) {
    return true;
  }
  return [environment.DATABASE_PATH, environment.SOURCE_EVIDENCE_STORAGE_DIR]
    .some((value) => /^\/app\/data\/(?:bootstrap|(?:incoming|restore)-pint-path-)/.test(value?.trim() ?? ""));
}

export function isRestoreRehearsalEnvironment(
  value = process.env.RESTORE_REHEARSAL_MODE,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (ENABLED_VALUES.has(normalized)) return true;
  if (normalized && !DISABLED_VALUES.has(normalized)) return true;

  // An explicit false/empty flag must not disable containment while the
  // immutable staging identity or any restore-shaped configuration remains.
  return hasRestoreRehearsalMarkers(environment);
}

export function assertOperatorMutationAllowed(operation: string): void {
  if (!isRestoreRehearsalEnvironment()) return;

  throw new Error(
    `${operation} is disabled while RESTORE_REHEARSAL_MODE is enabled. ` +
    "Use an ordinary non-restore environment for operator writes.",
  );
}
