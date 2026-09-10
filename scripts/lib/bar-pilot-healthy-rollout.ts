import { spawnSync } from "node:child_process";

import { BAR_PILOT_STOPPED_DEPLOYMENT_ID } from "./bar-pilot-staging-contract.js";
import { barPilotFailedStartupRecoveryRequested } from "./bar-pilot-failed-startup-recovery.js";

type Environment = Readonly<Record<string, string | undefined>>;
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Omission preserves the existing same-candidate configuration refresh. */
export function barPilotPreviousCandidateSha(env: Environment, candidateSha: string): string {
  const previous = env.PINTPATH_BAR_PILOT_PREVIOUS_CANDIDATE_SHA ?? "";
  const currentId = env.PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID ?? "";
  const failedRecovery = barPilotFailedStartupRecoveryRequested(env);
  if (!SHA.test(candidateSha) || (currentId && (!UUID.test(currentId)
    || currentId === BAR_PILOT_STOPPED_DEPLOYMENT_ID))
    || (previous && (!SHA.test(previous) || !currentId || failedRecovery))) {
    throw new Error("target_preflight_failed");
  }
  return previous || candidateSha;
}

/** The caller also proves candidateSha is exact current main before writes. */
export function assertBarPilotPreviousCandidateAncestor(
  cwd: string,
  previousSha: string,
  candidateSha: string,
): void {
  if (!SHA.test(previousSha) || !SHA.test(candidateSha)) throw new Error("source_authority_failed");
  if (previousSha === candidateSha) return;
  const commit = spawnSync("git", ["rev-parse", "--verify", `${previousSha}^{commit}`], {
    cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 4096,
  });
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", previousSha, candidateSha], {
    cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 4096,
  });
  if (commit.status !== 0 || commit.stdout.trim() !== previousSha || ancestor.status !== 0) {
    throw new Error("source_authority_failed");
  }
}
