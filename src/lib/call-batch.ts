import type { CallStatus, ParseStatus } from "../db/models.js";

export interface CallRunOutcomeLike {
  callStatus: CallStatus;
  parseStatus: ParseStatus;
  errorMessage?: string | null;
}

export type BatchAttemptOutcome = "good" | "bad" | "pending";

const NON_RETRYABLE_FAILURE_PATTERNS = [
  /wrong business reached/i,
  /call challenged by staff/i,
] as const;

export function isRetryableVenueOutcome(outcome: CallRunOutcomeLike): boolean {
  if (["parsed", "partial", "needs_review"].includes(outcome.parseStatus)) {
    return false;
  }

  if (["queued", "ringing", "in-progress"].includes(outcome.callStatus) || outcome.parseStatus === "pending") {
    return true;
  }

  if (["busy", "no-answer"].includes(outcome.callStatus)) {
    return true;
  }

  if (outcome.callStatus === "canceled" || outcome.callStatus === "failed" || outcome.parseStatus === "failed") {
    return !NON_RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(outcome.errorMessage ?? ""));
  }

  return false;
}

export function classifyBatchAttemptOutcome(outcome: CallRunOutcomeLike | null | undefined): BatchAttemptOutcome {
  if (!outcome) {
    return "pending";
  }

  if (["parsed", "partial", "needs_review"].includes(outcome.parseStatus)) {
    return "good";
  }

  if (
    ["failed", "busy", "no-answer", "canceled"].includes(outcome.callStatus) ||
    outcome.parseStatus === "failed"
  ) {
    return "bad";
  }

  return "pending";
}
