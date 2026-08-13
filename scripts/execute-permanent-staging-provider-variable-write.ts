export {
  PERMANENT_STAGING_PROVIDER_VARIABLE_NAMES,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_BLOCKED_RECEIPT,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_SCHEMA,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATION,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_POLICY_SCHEMA,
  parsePermanentStagingProviderVariableWritePolicy,
  runPermanentStagingProviderVariableWriteExecutor,
  type PermanentStagingProviderVariableName,
  type PermanentStagingProviderVariableWriteExecutorChecks,
  type PermanentStagingProviderVariableWriteExecutorReceipt,
  type PermanentStagingProviderVariableWritePolicy,
} from "./lib/permanent-staging-provider-variable-write-executor.js";

import { fileURLToPath } from "node:url";

import { runPermanentStagingProviderVariableWriteExecutor } from
  "./lib/permanent-staging-provider-variable-write-executor.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runPermanentStagingProviderVariableWriteExecutor();
}
