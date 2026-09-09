import { fileURLToPath } from "node:url";

import { runProtectedPermanentStagingPostQDeploymentStop } from
  "./execute-protected-permanent-staging-post-q-deployment-stop.js";
import {
  postQDeploymentStopV4DeadlineExact,
  parsePostQDeploymentStopAuthorityV4,
  parsePostQDeploymentStopReviewedAuthorityV4,
  postQDeploymentStopV4ConfirmationExact,
} from "./lib/permanent-staging-post-q-deployment-stop-authority-v4.js";

export async function runProtectedPermanentStagingPostQDeploymentStopV4():
Promise<0 | 1> {
  return runProtectedPermanentStagingPostQDeploymentStop({
    authorizationDeadlineExact: postQDeploymentStopV4DeadlineExact,
    confirmationExact: postQDeploymentStopV4ConfirmationExact,
    parseQAuthority: parsePostQDeploymentStopAuthorityV4,
    parseReviewedAuthority: parsePostQDeploymentStopReviewedAuthorityV4,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedPermanentStagingPostQDeploymentStopV4();
}
