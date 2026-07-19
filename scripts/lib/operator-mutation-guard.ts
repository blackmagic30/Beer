const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);
const RESTORE_RAILWAY_PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const RESTORE_RAILWAY_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const RESTORE_BEER_SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const RESTORE_REDIS_SERVICE_ID = "d6351cec-fe04-4a6f-8e05-1cc164ea1e73";
const RESTORE_SUPABASE_REF = "ibveugyfyzjptyvautlr";
const RESTORE_MARKER_NAMES = [
  "RESTORE_REHEARSAL_PHASE",
  "RESTORE_REHEARSAL_BACKUP_ID",
  "RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256",
  "RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256",
  "RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL",
  "RESTORE_REHEARSAL_BACKUP_SUPABASE_URL",
  "RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID",
  "RESTORE_REHEARSAL_REDIS_SERVICE_ID",
  "RESTORE_REHEARSAL_REDIS_SENTINEL",
  "RESTORE_REHEARSAL_ACCESS_USERNAME",
  "RESTORE_REHEARSAL_ACCESS_PASSWORD",
] as const;

function hasRestoreRehearsalMarkers(environment: NodeJS.ProcessEnv): boolean {
  if (
    environment.RAILWAY_ENVIRONMENT_ID?.trim() === RESTORE_RAILWAY_ENVIRONMENT_ID ||
    environment.RAILWAY_SERVICE_ID?.trim() === RESTORE_BEER_SERVICE_ID ||
    environment.RAILWAY_SERVICE_ID?.trim() === RESTORE_REDIS_SERVICE_ID ||
    (
      environment.RAILWAY_PROJECT_ID?.trim() === RESTORE_RAILWAY_PROJECT_ID &&
      environment.RAILWAY_ENVIRONMENT_NAME?.trim().toLowerCase() === "staging"
    )
  ) {
    return true;
  }
  if (RESTORE_MARKER_NAMES.some((name) => Boolean(environment[name]?.trim()))) {
    return true;
  }
  if (environment.REDIS_KEY_NAMESPACE?.trim().startsWith("pint-path:restore:")) {
    return true;
  }
  if (environment.SUPABASE_URL?.trim().toLowerCase().includes(`${RESTORE_SUPABASE_REF}.supabase.co`)) {
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
