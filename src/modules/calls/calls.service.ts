import { randomUUID } from "node:crypto";

import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { nowIso } from "../../lib/time.js";
import { env } from "../../config/env.js";
import { BeerPriceResultsRepository } from "../../db/beer-price-results.repository.js";
import { CallRunsRepository } from "../../db/call-runs.repository.js";
import { getCallingWindowStatus } from "../../lib/business-hours.js";
import { TwilioService } from "../../lib/twilio.js";
import { buildCallRunViews } from "./call-runs.presenter.js";

import type { CallRunsQuery, OutboundCallBody } from "./calls.schemas.js";

export class CallsService {
  constructor(
    private readonly callRunsRepository: CallRunsRepository,
    private readonly beerPriceResultsRepository: BeerPriceResultsRepository,
    private readonly twilioService: TwilioService,
    private readonly publicBaseUrl: string,
    private readonly outboundRepeatGuardSeconds: number,
    private readonly parseConfidenceThreshold: number,
  ) {}

  async createOutboundCall(input: OutboundCallBody) {
    if (!env.OUTBOUND_CALLS_ENABLED && !input.testMode) {
      throw new AppError("Outbound calling is currently paused.", 503, {
        paused: true,
      });
    }

    if (!input.testMode) {
      const windowStatus = getCallingWindowStatus(new Date(), {
        timezone: env.OUTBOUND_CALL_TIMEZONE,
        start: env.OUTBOUND_CALL_WINDOW_START,
        end: env.OUTBOUND_CALL_WINDOW_END,
        allowedDays: env.OUTBOUND_CALL_ALLOWED_DAYS,
      });

      if (!windowStatus.allowed) {
        throw new AppError("Outbound calling is outside the configured venue call window.", 503, {
          paused: true,
          reason: windowStatus.reason,
          localDay: windowStatus.localDay,
          localTime: windowStatus.localTime,
          callWindow: windowStatus.label,
        });
      }
    }

    const callRunId = randomUUID();
    const timestamp = nowIso();
    const voiceWebhookUrl = new URL("/webhooks/twilio/voice", this.publicBaseUrl);
    const statusWebhookUrl = new URL("/webhooks/twilio/status", this.publicBaseUrl);
    const guardStartedAfter = new Date(
      Date.now() - this.outboundRepeatGuardSeconds * 1000,
    ).toISOString();

    if (
      this.outboundRepeatGuardSeconds > 0 &&
      this.callRunsRepository.hasRecentAttempt(input.phoneNumber, guardStartedAfter)
    ) {
      throw new AppError(
        "That number was called recently. Please wait before dialing it again.",
        429,
        {
          phoneNumber: input.phoneNumber,
          retryAfterSeconds: this.outboundRepeatGuardSeconds,
        },
      );
    }

    voiceWebhookUrl.searchParams.set("runId", callRunId);
    statusWebhookUrl.searchParams.set("runId", callRunId);

    this.callRunsRepository.create({
      id: callRunId,
      venueId: input.venueId,
      venueName: input.venueName,
      phoneNumber: input.phoneNumber,
      suburb: input.suburb,
      startedAt: timestamp,
      callStatus: "queued",
      parseStatus: "pending",
      isTest: input.testMode,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    try {
      const call = await this.twilioService.createOutboundCall({
        toNumber: input.phoneNumber,
        voiceWebhookUrl: voiceWebhookUrl.toString(),
        statusWebhookUrl: statusWebhookUrl.toString(),
      });

      this.callRunsRepository.updateDialSuccess(
        callRunId,
        call.sid,
        normaliseTwilioCallStatus(call.status),
        nowIso(),
      );

      return {
        id: callRunId,
        callSid: call.sid,
        callStatus: normaliseTwilioCallStatus(call.status),
        venueId: input.venueId,
        venueName: input.venueName,
        suburb: input.suburb,
        phoneNumber: input.phoneNumber,
        testMode: input.testMode,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown outbound call error";
      this.callRunsRepository.markDialFailure(
        callRunId,
        message,
        nowIso(),
      );

      logger.error("Outbound call creation failed", {
        callRunId,
        phoneNumber: input.phoneNumber,
        testMode: input.testMode,
        error: message,
      });

      throw error;
    }
  }

  listCallRuns(query: CallRunsQuery) {
    const fetchLimit = query.needsReview ? Math.max(query.limit * 5, 100) : query.limit;
    const callRuns = this.callRunsRepository.list({
      venueName: query.venueName,
      suburb: query.suburb,
      testMode: query.testMode,
      limit: fetchLimit,
    });
    const resultRows = this.beerPriceResultsRepository.listByCallSids(
      callRuns
        .map((callRun) => callRun.callSid)
        .filter((callSid): callSid is string => Boolean(callSid)),
    );
    const views = buildCallRunViews(callRuns, resultRows, this.parseConfidenceThreshold).filter((view) =>
      query.needsReview === undefined ? true : view.needsReview === query.needsReview,
    );

    return views.slice(0, query.limit);
  }

  getCallRun(callSid: string) {
    const callRun = this.callRunsRepository.getByCallSid(callSid);

    if (!callRun) {
      throw new AppError("Call run not found", 404, {
        callSid,
      });
    }

    const resultRows = this.beerPriceResultsRepository.listByCallSids([callSid]);
    const view = buildCallRunViews([callRun], resultRows, this.parseConfidenceThreshold)[0];

    if (!view) {
      throw new AppError("Call run view could not be built", 500, {
        callSid,
      });
    }

    return view;
  }
}

function normaliseTwilioCallStatus(status?: string | null) {
  switch ((status ?? "").toLowerCase()) {
    case "ringing":
      return "ringing";
    case "in-progress":
    case "answered":
      return "in-progress";
    case "completed":
      return "completed";
    case "busy":
      return "busy";
    case "no-answer":
      return "no-answer";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "failed":
      return "failed";
    default:
      return "queued";
  }
}
