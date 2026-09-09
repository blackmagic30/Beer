import { fileURLToPath } from "node:url";

import { runProtectedPermanentStagingPostQDeploymentStop } from
  "./execute-protected-permanent-staging-post-q-deployment-stop.js";
import {
  postQDeploymentStopV3DeadlineExact,
  parsePostQDeploymentStopAuthorityV3,
  parsePostQDeploymentStopReviewedAuthorityV3,
  postQDeploymentStopV3ConfirmationExact,
} from "./lib/permanent-staging-post-q-deployment-stop-authority-v3.js";

export async function runProtectedPermanentStagingPostQDeploymentStopV3():
Promise<0 | 1> {
  return runProtectedPermanentStagingPostQDeploymentStop({
    authorizationDeadlineExact: postQDeploymentStopV3DeadlineExact,
    confirmationExact: postQDeploymentStopV3ConfirmationExact,
    parseQAuthority: parsePostQDeploymentStopAuthorityV3,
    parseReviewedAuthority: parsePostQDeploymentStopReviewedAuthorityV3,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedPermanentStagingPostQDeploymentStopV3();
}
