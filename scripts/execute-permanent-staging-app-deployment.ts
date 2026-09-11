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
import path from "node:path";

import { runPermanentStagingAppDeploymentExecutor } from
  "./lib/permanent-staging-app-deployment-executor.js";
import { runPermanentStagingAppDeploymentExecutor as runArchiveDeployment } from
  "./lib/bar-pilot-staging-app-deployment-executor.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const policyIndex = args.indexOf("--policy");
  const productionPolicy = policyIndex !== -1 && args[policyIndex + 1] !== undefined
    && path.resolve(args[policyIndex + 1]!)
      === path.resolve("ops/railway/production-app-deployment-policy.json");
  process.exitCode = await (productionPolicy
    ? runArchiveDeployment(args) : runPermanentStagingAppDeploymentExecutor(args));
}
