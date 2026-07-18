export function isCanonicalProductionRuntime(input: {
  nodeEnv: string;
  railwayEnvironmentName?: string | undefined;
}): boolean {
  if (input.nodeEnv !== "production") return false;
  // Outside Railway, NODE_ENV=production remains the explicit production
  // signal. On Railway, only the environment actually named "production" may
  // run automatic jobs that write to the independent production backup store.
  if (input.railwayEnvironmentName === undefined) return true;
  return input.railwayEnvironmentName.trim().toLowerCase() === "production";
}

export interface AccountDeletionLedgerRuntimeConfig {
  sourceSupabaseUrl: string;
  destinationSupabaseUrl: string;
  destinationServiceRoleKey: string;
  bucketName: string;
}

export function resolveAccountDeletionLedgerRuntimeConfig(input: {
  nodeEnv: string;
  railwayEnvironmentName?: string | undefined;
  sourceSupabaseUrl?: string | undefined;
  destinationSupabaseUrl?: string | undefined;
  destinationServiceRoleKey?: string | undefined;
  bucketName: string;
}): AccountDeletionLedgerRuntimeConfig | null {
  if (!isCanonicalProductionRuntime(input)) return null;
  const sourceSupabaseUrl = input.sourceSupabaseUrl?.trim();
  const destinationSupabaseUrl = input.destinationSupabaseUrl?.trim();
  const destinationServiceRoleKey = input.destinationServiceRoleKey?.trim();
  const bucketName = input.bucketName.trim();
  if (!sourceSupabaseUrl || !destinationSupabaseUrl || !destinationServiceRoleKey || !bucketName) return null;
  let sourceOrigin: string;
  let destinationOrigin: string;
  try {
    sourceOrigin = new URL(sourceSupabaseUrl).origin.toLowerCase();
    destinationOrigin = new URL(destinationSupabaseUrl).origin.toLowerCase();
  } catch {
    return null;
  }
  if (sourceOrigin === destinationOrigin) return null;
  return {
    sourceSupabaseUrl,
    destinationSupabaseUrl,
    destinationServiceRoleKey,
    bucketName,
  };
}
