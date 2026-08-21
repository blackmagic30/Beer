export {
  PERMANENT_STAGING_APP_DEPLOYMENT_BLOCKED_RECEIPT,
  PERMANENT_STAGING_APP_DEPLOYMENT_CANONICAL_POLICY_SOURCE,
  PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA,
  PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE,
  PERMANENT_STAGING_APP_DEPLOYMENT_FAILURE_CODES,
  PERMANENT_STAGING_APP_DEPLOYMENT_LOCK,
  PERMANENT_STAGING_APP_DEPLOYMENT_OPERATION,
  PERMANENT_STAGING_APP_DEPLOYMENT_POLICY_SCHEMA,
  parsePermanentStagingAppDeploymentPolicy,
  runPermanentStagingAppDeploymentExecutor,
  type PermanentStagingAppDeploymentExecutorChecks,
  type PermanentStagingAppDeploymentExecutorReceipt,
  type PermanentStagingAppDeploymentFailureCode,
  type PermanentStagingAppDeploymentPolicy,
} from "./lib/permanent-staging-app-deployment-executor.js";

import { fileURLToPath } from "node:url";

import { runPermanentStagingAppDeploymentExecutor } from
  "./lib/permanent-staging-app-deployment-executor.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runPermanentStagingAppDeploymentExecutor();
}
