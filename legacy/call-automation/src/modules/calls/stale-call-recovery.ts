import type { CallRunRecord, CallStatus } from "../../db/models.js";

export interface StaleCallRecoveryThresholds {
  activeMinutes: number;
  completedMinutes: number;
  terminalMinutes: number;
}

export interface StaleCallRecoveryPlan {
  nextCallStatus: CallStatus;
  parseStatus: "failed";
  parseConfidence: number;
  errorMessage: string;
  endedAt: string | null;
}

export interface StaleCallRecoveryRepository {
  list(filters: { limit: number }): CallRunRecord[];
  updateStatusById(
    id: string,
    input: {
      callStatus: CallStatus;
      endedAt?: string | null;
      errorMessage?: string | null;
      updatedAt: string;
    },
  ): void;
  saveTranscriptParseById(
    id: string,
    input: {
      conversationId?: string | null;
      rawTranscript: string | null;
      parseConfidence: number | null;
      parseStatus: "failed";
      errorMessage?: string | null;
      endedAt?: string | null;
      updatedAt: string;
    },
  ): void;
}

export interface RecoverStaleCallRunsOptions extends StaleCallRecoveryThresholds {
  nowIso: string;
  limit: number;
  dryRun?: boolean;
}

export interface RecoveredStaleCallRun {
  run: CallRunRecord;
  plan: StaleCallRecoveryPlan;
}

const ACTIVE_CALL_STATUSES = new Set<CallStatus>(["queued", "ringing", "in-progress"]);
const TERMINAL_CALL_STATUSES = new Set<CallStatus>(["busy", "no-answer", "failed", "canceled"]);

function minutesSince(timestamp: string | null | undefined, nowMs: number): number {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;

  if (Number.isNaN(parsed)) {
    return Number.POSITIVE_INFINITY;
  }

  return (nowMs - parsed) / 60_000;
}

export function buildStaleCallRecoveryPlan(
  run: CallRunRecord,
  nowIso: string,
  thresholds: StaleCallRecoveryThresholds,
): StaleCallRecoveryPlan | null {
  if (run.parseStatus !== "pending") {
    return null;
  }

  if (run.rawTranscript) {
    return null;
  }

  const nowMs = Date.parse(nowIso);
  const ageMinutes = minutesSince(run.updatedAt || run.createdAt || run.startedAt, nowMs);

  if (TERMINAL_CALL_STATUSES.has(run.callStatus)) {
    if (ageMinutes < thresholds.terminalMinutes) {
      return null;
    }

    return {
      nextCallStatus: run.callStatus,
      parseStatus: "failed",
      parseConfidence: 0,
      errorMessage: `Call ended with status ${run.callStatus}`,
      endedAt: run.endedAt ?? nowIso,
    };
  }

  if (run.callStatus === "completed") {
    if (ageMinutes < thresholds.completedMinutes) {
      return null;
    }

    return {
      nextCallStatus: "completed",
      parseStatus: "failed",
      parseConfidence: 0,
      errorMessage: "Transcript recovery timed out after completed call",
      endedAt: run.endedAt ?? nowIso,
    };
  }

  if (ACTIVE_CALL_STATUSES.has(run.callStatus)) {
    if (ageMinutes < thresholds.activeMinutes) {
      return null;
    }

    return {
      nextCallStatus: "failed",
      parseStatus: "failed",
      parseConfidence: 0,
      errorMessage: `Call stalled in status ${run.callStatus}`,
      endedAt: nowIso,
    };
  }

  return null;
}

export function recoverStaleCallRuns(
  repository: StaleCallRecoveryRepository,
  options: RecoverStaleCallRunsOptions,
): RecoveredStaleCallRun[] {
  const runs = repository
    .list({ limit: options.limit })
    .filter((run) => !run.isTest)
    .filter((run) => run.parseStatus === "pending");

  const recoveries = runs
    .map((run) => ({
      run,
      plan: buildStaleCallRecoveryPlan(run, options.nowIso, options),
    }))
    .filter((entry): entry is RecoveredStaleCallRun => entry.plan !== null);

  if (options.dryRun) {
    return recoveries;
  }

  for (const { run, plan } of recoveries) {
    repository.updateStatusById(run.id, {
      callStatus: plan.nextCallStatus,
      endedAt: plan.endedAt,
      errorMessage: plan.errorMessage,
      updatedAt: options.nowIso,
    });
    repository.saveTranscriptParseById(run.id, {
      conversationId: run.conversationId,
      rawTranscript: null,
      parseConfidence: plan.parseConfidence,
      parseStatus: plan.parseStatus,
      errorMessage: plan.errorMessage,
      endedAt: plan.endedAt,
      updatedAt: options.nowIso,
    });
  }

  return recoveries;
}
