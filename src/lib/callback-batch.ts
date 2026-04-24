export interface CallbackEligibleCallLike {
  callStatus: string;
  parseStatus: string;
  rawTranscript: string | null;
  errorMessage: string | null;
  isTest: boolean;
}

const NON_PICKUP_PATTERNS = [
  /automated menu or ivr detected/i,
  /ivr detected/i,
  /voicemail detected/i,
  /out-of-hours recording detected/i,
  /wrong business reached/i,
  /no clear human response detected/i,
  /parsing produced no useful data/i,
  /staff needed to check price but no answer returned/i,
] as const;

export function isEligibleForFollowUpBeer(call: CallbackEligibleCallLike): boolean {
  if (call.isTest) {
    return false;
  }

  if (call.callStatus !== "completed") {
    return false;
  }

  if (!call.rawTranscript || call.rawTranscript.trim().length === 0) {
    return false;
  }

  if (NON_PICKUP_PATTERNS.some((pattern) => pattern.test(call.errorMessage ?? ""))) {
    return false;
  }

  return ["parsed", "partial", "needs_review", "failed"].includes(call.parseStatus);
}

