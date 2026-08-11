import { fileURLToPath } from "node:url";

import {
  PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY_SHA256,
  PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_STATE,
} from "./lib/permanent-staging-supabase-key-replacement.js";
import {
  canonicalJson,
  freezeExact,
} from "./lib/permanent-staging-supabase-containment-primitives.js";

export const PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_CLI_SCHEMA =
  "pintpath-permanent-staging-supabase-key-replacement-cli/v1" as const;

export const PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_CLI_BLOCKED_RECEIPT =
  freezeExact({
    schemaVersion: PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_CLI_SCHEMA,
    operation: "permanent-staging-supabase-three-key-replacement",
    activationState: PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_STATE,
    outcome: "blocked",
    policySha256: PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY_SHA256,
    providerCapableTransportPresent: false,
    inputRead: false,
    mutationAttempted: false,
    retryAllowed: false,
  } as const);

export function runPermanentStagingSupabaseKeyReplacementCli(): 1 {
  REFLECT_APPLY_EXACT(
    STDOUT_WRITE_EXACT,
    STDOUT_EXACT,
    [`${canonicalJson(
      PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_CLI_BLOCKED_RECEIPT,
    )}\n`],
  );
  return 1;
}

const REFLECT_APPLY_EXACT = Reflect.apply;
const STDOUT_EXACT = process.stdout;
const STDOUT_WRITE_EXACT = process.stdout.write;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runPermanentStagingSupabaseKeyReplacementCli();
}
