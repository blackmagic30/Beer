export {
  STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK,
  STAGING_POSTGRES_BUILD_CANARY_DEADLINES,
  STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_SCHEMA,
  STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_STATE,
  STAGING_POSTGRES_BUILD_CANARY_OPERATION,
  runStagingPostgresBuildCanaryExecutor,
  stagingPostgresBuildCanaryExecutorInternals,
  type StagingPostgresBuildCanaryBoundarySnapshot,
  type StagingPostgresBuildCanaryChildAuthority,
  type StagingPostgresBuildCanaryDurableArtifactEvidence,
  type StagingPostgresBuildCanaryExecutorDependencies,
  type StagingPostgresBuildCanaryExecutorReceipt,
  type StagingPostgresBuildCanaryLocalAuthority,
  type StagingPostgresBuildCanaryPostflight,
} from "./lib/staging-postgres-build-canary-executor.js";

import { fileURLToPath } from "node:url";

import { runStagingPostgresBuildCanaryExecutor } from
  "./lib/staging-postgres-build-canary-executor.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runStagingPostgresBuildCanaryExecutor();
}
