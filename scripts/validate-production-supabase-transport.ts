import { pathToFileURL } from "node:url";

import {
  assertSupabaseServerApiKey,
  type SupabaseServerApiKeyKind,
} from "../src/lib/supabase-key-format.js";

export const PRODUCTION_SUPABASE_ORIGIN = "https://auth.pintpath.au";
export const PRODUCTION_SUPABASE_PROJECT_REF = "jxpubqlmqnnqwadmjgyk";

export function validateProductionSupabaseTransportEnvironment(
  environment: NodeJS.ProcessEnv,
): SupabaseServerApiKeyKind {
  if (
    environment.SUPABASE_URL !== PRODUCTION_SUPABASE_ORIGIN
    || environment.PINTPATH_EXPECTED_SUPABASE_PROJECT_REF
      !== PRODUCTION_SUPABASE_PROJECT_REF
  ) {
    throw new Error("Supabase production target mismatch.");
  }
  return assertSupabaseServerApiKey(
    environment.SUPABASE_SERVICE_ROLE_KEY ?? "",
    "SUPABASE_SERVICE_ROLE_KEY",
  );
}

function main(): void {
  try {
    const keyKind = validateProductionSupabaseTransportEnvironment(process.env);
    if (process.argv.includes("--print-key-kind")) {
      process.stdout.write(`${keyKind}\n`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Supabase transport validation failed.");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
