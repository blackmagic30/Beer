import { describe, expect, it } from "vitest";

import type { CallRunRecord } from "../src/db/models.js";
import { buildStaleCallRecoveryPlan } from "../src/modules/calls/stale-call-recovery.js";

function createRun(overrides: Partial<CallRunRecord>): CallRunRecord {
  return {
    id: "run-1",
    callSid: "CA-test",
    conversationId: null,
    venueId: "venue-1",
    venueName: "Test Venue",
    phoneNumber: "+61399998888",
    suburb: "Melbourne",
    startedAt: "2026-04-20T00:00:00.000Z",
    endedAt: null,
    durationSeconds: null,
    callStatus: "queued",
    rawTranscript: null,
    parseConfidence: null,
    parseStatus: "pending",
    errorMessage: null,
    isTest: false,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  };
}

const thresholds = {
  activeMinutes: 20,
  completedMinutes: 15,
  terminalMinutes: 5,
};

describe("buildStaleCallRecoveryPlan", () => {
  it("recovers stale active calls as failed", () => {
    const plan = buildStaleCallRecoveryPlan(
      createRun({
        callStatus: "in-progress",
        updatedAt: "2026-04-20T00:00:00.000Z",
      }),
      "2026-04-20T00:25:00.000Z",
      thresholds,
    );

    expect(plan).toEqual({
      nextCallStatus: "failed",
      parseStatus: "failed",
      parseConfidence: 0,
      errorMessage: "Call stalled in status in-progress",
      endedAt: "2026-04-20T00:25:00.000Z",
    });
  });

  it("recovers completed calls whose transcript timed out", () => {
    const plan = buildStaleCallRecoveryPlan(
      createRun({
        callStatus: "completed",
        endedAt: "2026-04-20T00:03:00.000Z",
        updatedAt: "2026-04-20T00:03:00.000Z",
      }),
      "2026-04-20T00:25:00.000Z",
      thresholds,
    );

    expect(plan).toEqual({
      nextCallStatus: "completed",
      parseStatus: "failed",
      parseConfidence: 0,
      errorMessage: "Transcript recovery timed out after completed call",
      endedAt: "2026-04-20T00:03:00.000Z",
    });
  });

  it("recovers ended busy calls that still have pending parse status", () => {
    const plan = buildStaleCallRecoveryPlan(
      createRun({
        callStatus: "busy",
        endedAt: "2026-04-20T00:01:00.000Z",
        updatedAt: "2026-04-20T00:01:00.000Z",
      }),
      "2026-04-20T00:10:00.000Z",
      thresholds,
    );

    expect(plan).toEqual({
      nextCallStatus: "busy",
      parseStatus: "failed",
      parseConfidence: 0,
      errorMessage: "Call ended with status busy",
      endedAt: "2026-04-20T00:01:00.000Z",
    });
  });

  it("does not recover fresh active calls", () => {
    const plan = buildStaleCallRecoveryPlan(
      createRun({
        callStatus: "ringing",
        updatedAt: "2026-04-20T00:18:00.000Z",
      }),
      "2026-04-20T00:25:00.000Z",
      thresholds,
    );

    expect(plan).toBeNull();
  });

  it("does not recover rows that already have transcripts", () => {
    const plan = buildStaleCallRecoveryPlan(
      createRun({
        callStatus: "completed",
        rawTranscript: "USER: Guinness is 15",
      }),
      "2026-04-20T00:25:00.000Z",
      thresholds,
    );

    expect(plan).toBeNull();
  });
});
