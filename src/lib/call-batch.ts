import type { CallStatus, ParseStatus } from "../db/models.js";

export interface CallRunOutcomeLike {
  callStatus: CallStatus;
  parseStatus: ParseStatus;
  errorMessage?: string | null;
}

export interface PhoneOutcomeLike extends CallRunOutcomeLike {
  phoneNumber: string | null;
  isTest?: boolean | null;
}

export type BatchAttemptOutcome = "good" | "bad" | "soft" | "pending";

const NON_RETRYABLE_FAILURE_PATTERNS = [
  /wrong business reached/i,
  /call challenged by staff/i,
] as const;

const SOFT_FAILURE_PATTERNS = [
  /automated menu or ivr detected/i,
  /ivr detected/i,
  /voicemail detected/i,
  /out-of-hours recording detected/i,
  /no clear human response detected/i,
  /staff needed to check price but no answer returned/i,
  /parsing produced no useful data/i,
] as const;

const STRONGLY_SUPPRESSIBLE_FAILURE_PATTERNS = [
  /wrong business reached/i,
  /automated menu or ivr detected/i,
  /ivr detected/i,
  /automated recording detected/i,
  /voicemail detected/i,
  /out-of-hours recording detected/i,
] as const;

const AMBIGUOUS_LOW_SIGNAL_FAILURE_PATTERNS = [
  /no clear human response detected/i,
  /staff needed to check price but no answer returned/i,
  /parsing produced no useful data/i,
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

  if (["busy", "no-answer"].includes(outcome.callStatus)) {
    return "soft";
  }

  if (
    outcome.parseStatus === "failed" &&
    SOFT_FAILURE_PATTERNS.some((pattern) => pattern.test(outcome.errorMessage ?? ""))
  ) {
    return "soft";
  }

  if (["failed", "canceled"].includes(outcome.callStatus) || outcome.parseStatus === "failed") {
    return "bad";
  }

  return "pending";
}

export function shouldSuppressPhoneFromFutureDialing(outcomes: CallRunOutcomeLike[]): boolean {
  if (
    outcomes.some((outcome) =>
      ["parsed", "partial", "needs_review"].includes(outcome.parseStatus),
    )
  ) {
    return false;
  }

  if (
    outcomes.some((outcome) =>
      STRONGLY_SUPPRESSIBLE_FAILURE_PATTERNS.some((pattern) => pattern.test(outcome.errorMessage ?? "")),
    )
  ) {
    return true;
  }

  const ambiguousLowSignalCount = outcomes.filter((outcome) =>
    outcome.parseStatus === "failed" &&
    AMBIGUOUS_LOW_SIGNAL_FAILURE_PATTERNS.some((pattern) => pattern.test(outcome.errorMessage ?? "")),
  ).length;

  return ambiguousLowSignalCount >= 2;
}

export function buildSuppressedPhoneSet(outcomes: PhoneOutcomeLike[]): Set<string> {
  const grouped = new Map<string, CallRunOutcomeLike[]>();

  for (const outcome of outcomes) {
    const phoneNumber = outcome.phoneNumber?.trim();

    if (!phoneNumber || outcome.isTest) {
      continue;
    }

    const rows = grouped.get(phoneNumber) ?? [];
    rows.push(outcome);
    grouped.set(phoneNumber, rows);
  }

  const suppressed = new Set<string>();

  for (const [phoneNumber, rows] of grouped.entries()) {
    if (shouldSuppressPhoneFromFutureDialing(rows)) {
      suppressed.add(phoneNumber);
    }
  }

  return suppressed;
}
