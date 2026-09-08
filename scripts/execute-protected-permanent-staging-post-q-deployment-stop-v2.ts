import { fileURLToPath } from "node:url";

import { runProtectedPermanentStagingPostQDeploymentStop } from
  "./execute-protected-permanent-staging-post-q-deployment-stop.js";
import {
  postQDeploymentStopV2DeadlineExact,
  parsePostQDeploymentStopAuthorityV2,
  parsePostQDeploymentStopReviewedAuthorityV2,
  postQDeploymentStopV2ConfirmationExact,
} from "./lib/permanent-staging-post-q-deployment-stop-authority-v2.js";

export async function runProtectedPermanentStagingPostQDeploymentStopV2():
Promise<0 | 1> {
  return runProtectedPermanentStagingPostQDeploymentStop({
    authorizationDeadlineExact: postQDeploymentStopV2DeadlineExact,
    confirmationExact: postQDeploymentStopV2ConfirmationExact,
    parseQAuthority: parsePostQDeploymentStopAuthorityV2,
    parseReviewedAuthority: parsePostQDeploymentStopReviewedAuthorityV2,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedPermanentStagingPostQDeploymentStopV2();
}
