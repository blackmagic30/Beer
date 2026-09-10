import { fileURLToPath } from "node:url";

import { runPermanentStagingAppDeploymentExecutor as runBarPilotStagingAppDeploymentExecutor } from
  "./lib/bar-pilot-staging-app-deployment-executor.js";

export { runBarPilotStagingAppDeploymentExecutor };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runBarPilotStagingAppDeploymentExecutor();
}
