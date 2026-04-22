import { randomUUID } from "node:crypto";

import { buildAgentFirstMessage, buildAgentPrompt } from "../../constants/agent-script.js";
import { getBeerByKey, normalizeTargetBeerKey } from "../../constants/beers.js";
import { BeerPriceResultsRepository } from "../../db/beer-price-results.repository.js";
import { CallRunsRepository } from "../../db/call-runs.repository.js";
import type { CallRunRecord, CallStatus } from "../../db/models.js";
import { AppError } from "../../lib/errors.js";
import { ElevenLabsService } from "../../lib/elevenlabs.js";
import { logger } from "../../lib/logger.js";
import { SupabaseResultsSyncService } from "../../lib/supabase-results-sync.js";
import { nowIso, unixSecondsToIso } from "../../lib/time.js";
import {
  extractBeerContextText,
  parseBeerPrices,
  summariseParseOutcome,
} from "../parsing/transcript-parser.js";
import {
  detectTranscriptFailureReason,
  shouldOverrideParsedOutcome,
} from "../parsing/transcript-failure-reason.js";

import type { TwilioStatusWebhookRequest, TwilioVoiceWebhookRequest } from "./webhooks.schemas.js";

interface TranscriptTurn {
  role: string | undefined;
  message: string | undefined;
  originalMessage: string | undefined;
}

interface NormalizedEventData {
  conversationId: string | null;
  status: string | null;
  userId: string | null;
  transcript: TranscriptTurn[];
  startTimeUnixSecs: number | undefined;
  callSid: string | null;
  externalNumber: string | null;
  dynamicVariables: Record<string, unknown>;
  failureReason: string | null;
}

interface NormalizedEvent {
  type: string;
  data: NormalizedEventData | undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getString(object: Record<string, unknown> | undefined, ...keys: string[]): string | null {
  if (!object) {
    return null;
  }

  for (const key of keys) {
    const value = object[key];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function getNumber(object: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  if (!object) {
    return undefined;
  }

  for (const key of keys) {
    const value = object[key];

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function getTurnMessage(turn: TranscriptTurn): string {
  return turn.message?.trim() || turn.originalMessage?.trim() || "";
}

function flattenTranscript(transcript: TranscriptTurn[]): string {
  return transcript
    .map((turn) => {
      const message = getTurnMessage(turn);

      if (!message) {
        return "";
      }

      return `${(turn.role ?? "unknown").toUpperCase()}: ${message}`;
    })
    .filter(Boolean)
    .join("\n");
}

function flattenRoleTranscript(transcript: TranscriptTurn[], role: string): string {
  return transcript
    .filter((turn) => turn.role?.toLowerCase() === role.toLowerCase())
    .map(getTurnMessage)
    .filter(Boolean)
    .join(". ");
}

function normalizeCallStatus(status?: string | null): CallStatus {
  switch ((status ?? "").toLowerCase()) {
    case "ringing":
      return "ringing";
    case "in-progress":
    case "answered":
      return "in-progress";
    case "completed":
    case "done":
      return "completed";
    case "busy":
      return "busy";
    case "no-answer":
    case "no answer":
      return "no-answer";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "failed":
    case "error":
      return "failed";
    default:
      return "queued";
  }
}

function normaliseFailureReason(reason: string | null): CallStatus {
  switch ((reason ?? "").toLowerCase()) {
    case "busy":
      return "busy";
    case "no-answer":
    case "no answer":
      return "no-answer";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "failed";
  }
}

function normalizeEvent(rawEvent: unknown): NormalizedEvent {
  const eventRecord = getRecord(rawEvent) ?? {};
  const rawData = getRecord(eventRecord.data);
  const metadata = getRecord(rawData?.metadata);
  const phoneCall =
    getRecord(metadata?.phoneCall) ??
    getRecord(metadata?.phone_call);
  const conversationInitiation =
    getRecord(rawData?.conversationInitiationClientData) ??
    getRecord(rawData?.conversation_initiation_client_data);
  const dynamicVariables =
    getRecord(conversationInitiation?.dynamicVariables) ??
    getRecord(conversationInitiation?.dynamic_variables) ??
    {};
  const transcriptRaw = rawData?.transcript;
  const transcript = Array.isArray(transcriptRaw)
    ? transcriptRaw.map((item) => {
        const turn = getRecord(item) ?? {};
        return {
          role: getString(turn, "role") ?? undefined,
          message: getString(turn, "message") ?? undefined,
          originalMessage: getString(turn, "originalMessage", "original_message") ?? undefined,
        };
      })
    : [];

  return {
    type: getString(eventRecord, "type") ?? "unknown",
    data: rawData
      ? {
          conversationId: getString(rawData, "conversationId", "conversation_id"),
          status: getString(rawData, "status"),
          userId: getString(rawData, "userId", "user_id"),
          transcript,
          startTimeUnixSecs: getNumber(metadata, "startTimeUnixSecs", "start_time_unix_secs"),
          callSid: getString(phoneCall, "callSid", "call_sid"),
          externalNumber: getString(phoneCall, "externalNumber", "external_number"),
          dynamicVariables,
          failureReason: getString(rawData, "failureReason", "failure_reason"),
        }
      : undefined,
  };
}

function extractConversationIdFromTwiml(twiml: string): string | null {
  const match = twiml.match(/<Parameter\s+name="conversation_id"\s+value="([^"]+)"/i);

  return match?.[1] ?? null;
}

export class WebhooksService {
  private readonly transcriptRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly callRunsRepository: CallRunsRepository,
    private readonly beerPriceResultsRepository: BeerPriceResultsRepository,
    private readonly elevenLabsService: ElevenLabsService,
    private readonly supabaseResultsSyncService: SupabaseResultsSyncService,
    private readonly elevenLabsAgentId: string | undefined,
    private readonly parseConfidenceThreshold: number,
  ) {}

  async handleTwilioVoiceWebhook(request: TwilioVoiceWebhookRequest): Promise<string> {
    const run = this.callRunsRepository.getById(request.query.runId);

    if (!run) {
      throw new AppError("Unknown call run", 404, {
        runId: request.query.runId,
      });
    }

    const callSid = request.body.CallSid;
    const fromNumber = request.body.From;
    const toNumber = request.body.To;

    if (!callSid || !fromNumber || !toNumber) {
      throw new AppError("Malformed Twilio voice webhook payload", 400, {
        runId: request.query.runId,
      });
    }

    this.callRunsRepository.updateDialSuccess(run.id, callSid, "in-progress", nowIso());

    if (!this.elevenLabsService.isConfigured(this.elevenLabsAgentId)) {
      throw new AppError("ElevenLabs is not configured for live calls", 503);
    }

    const twiml = await this.elevenLabsService.registerTwilioCall({
      agentId: this.elevenLabsAgentId!,
      fromNumber,
      toNumber,
      conversationInitiationClientData: this.buildConversationInitiationData(run),
    });
    const conversationId = extractConversationIdFromTwiml(twiml);

    if (conversationId) {
      this.callRunsRepository.setConversationId(run.id, conversationId, nowIso());
    }

    logger.info("Twilio voice webhook registered with ElevenLabs", {
      runId: run.id,
      callSid,
      conversationId,
      venueName: run.venueName,
      isTest: run.isTest,
    });

    return twiml;
  }

  handleVoiceWebhookFailure(runId: string | undefined, errorMessage: string): void {
    if (!runId) {
      return;
    }

    const run = this.callRunsRepository.getById(runId);

    if (!run) {
      return;
    }

    const timestamp = nowIso();

    this.callRunsRepository.updateStatusById(runId, {
      callStatus: "failed",
      endedAt: timestamp,
      errorMessage,
      updatedAt: timestamp,
    });
    this.callRunsRepository.saveTranscriptParseById(runId, {
      rawTranscript: null,
      parseConfidence: 0,
      parseStatus: "failed",
      errorMessage,
      endedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  handleTwilioStatusWebhook(request: TwilioStatusWebhookRequest) {
    const timestamp = nowIso();
    const callStatus = normalizeCallStatus(request.body.CallStatus);
    const durationSeconds = request.body.CallDuration
      ? Number.parseInt(request.body.CallDuration, 10)
      : null;
    const endedAt = ["completed", "busy", "no-answer", "failed", "canceled"].includes(callStatus)
      ? timestamp
      : null;

    let run = this.callRunsRepository.getByCallSid(request.body.CallSid);

    if (run) {
      this.callRunsRepository.updateStatusByCallSid(request.body.CallSid, {
        callStatus,
        endedAt,
        durationSeconds: Number.isNaN(durationSeconds ?? Number.NaN) ? null : durationSeconds,
        updatedAt: timestamp,
      });
    } else if (request.query.runId) {
      this.callRunsRepository.updateStatusById(request.query.runId, {
        callStatus,
        endedAt,
        durationSeconds: Number.isNaN(durationSeconds ?? Number.NaN) ? null : durationSeconds,
        updatedAt: timestamp,
      });
      run = this.callRunsRepository.getById(request.query.runId);
    } else {
      run = undefined;
    }

    if (
      run?.parseStatus === "pending" &&
      ["busy", "no-answer", "failed", "canceled"].includes(callStatus)
    ) {
      this.callRunsRepository.saveTranscriptParseById(run.id, {
        rawTranscript: null,
        parseConfidence: 0,
        parseStatus: "failed",
        errorMessage: `Call ended with status ${callStatus}`,
        endedAt: endedAt ?? timestamp,
        updatedAt: timestamp,
      });
      run = this.callRunsRepository.getById(run.id);
    }

    if (callStatus === "completed" && run?.conversationId && run.parseStatus === "pending") {
      this.scheduleTranscriptRecovery(run.id, run.conversationId);
    }

    return {
      acknowledged: true,
      callSid: request.body.CallSid,
      callStatus,
      durationSeconds,
      runId: request.query.runId ?? null,
    };
  }

  async handleElevenLabsPostCallWebhook(rawBody: string, signatureHeader?: string) {
    const rawEvent = await this.elevenLabsService.verifyAndParseWebhook(rawBody, signatureHeader);
    return this.processNormalizedEvent(normalizeEvent(rawEvent));
  }

  private handleCallInitiationFailure(data?: NormalizedEventData) {
    const timestamp = nowIso();
    const run = this.resolveCallRunFromEvent(data, timestamp);
    const failureReason = data?.failureReason ?? "call initiation failure";
    const callStatus = normaliseFailureReason(failureReason);

    this.callRunsRepository.updateStatusById(run.id, {
      callStatus,
      endedAt: timestamp,
      errorMessage: failureReason,
      updatedAt: timestamp,
    });
    this.callRunsRepository.saveTranscriptParseById(run.id, {
      conversationId: data?.conversationId ?? null,
      rawTranscript: null,
      parseConfidence: 0,
      parseStatus: "failed",
      errorMessage: failureReason,
      endedAt: timestamp,
      updatedAt: timestamp,
    });

    return {
      processed: true,
      type: "call_initiation_failure",
      callSid: run.callSid,
      callStatus,
      errorMessage: failureReason,
    };
  }

  private async processNormalizedEvent(event: NormalizedEvent) {
    if (event.type === "call_initiation_failure") {
      return this.handleCallInitiationFailure(event.data);
    }

    if (event.type !== "post_call_transcription" || !event.data) {
      return {
        processed: false,
        type: event.type,
      };
    }

    const timestamp = nowIso();
    const run = this.resolveCallRunFromEvent(event.data, timestamp);
    const transcript = event.data.transcript;
    const rawTranscript = flattenTranscript(transcript);

    this.clearTranscriptRecovery(run.id);
    this.callRunsRepository.updateStatusById(run.id, {
      callStatus: normalizeCallStatus(event.data.status ?? "completed"),
      endedAt: timestamp,
      updatedAt: timestamp,
    });

    if (!rawTranscript.trim()) {
      this.callRunsRepository.saveTranscriptParseById(run.id, {
        conversationId: event.data.conversationId,
        rawTranscript: null,
        parseConfidence: 0,
        parseStatus: "failed",
        errorMessage: "Transcript was empty",
        endedAt: timestamp,
        updatedAt: timestamp,
      });

      return {
        processed: true,
        type: event.type,
        callSid: run.callSid,
        parseStatus: "failed",
      };
    }

    try {
      const userTranscript = flattenRoleTranscript(transcript, "user");
      const targetBeerKey = run.requestedBeer ?? normalizeTargetBeerKey(
        this.getOptionalDynamicString(
          event.data.dynamicVariables.requested_beer,
          event.data.dynamicVariables.requestedBeer,
        ),
      );
      const targetBeer = getBeerByKey(targetBeerKey);
      const beerTranscript = extractBeerContextText(transcript, [targetBeer]);
      const parsedPrices = parseBeerPrices(beerTranscript || userTranscript || rawTranscript, {
        assumeBeerContext: Boolean(beerTranscript),
        targetBeers: [targetBeer],
      });
      const detectedFailureReason = detectTranscriptFailureReason(userTranscript, rawTranscript);
      const baseParseSummary = summariseParseOutcome(
        parsedPrices,
        null,
        this.parseConfidenceThreshold,
      );
      const overrideParsedOutcome = shouldOverrideParsedOutcome(detectedFailureReason);
      const parseSummary = overrideParsedOutcome
        ? {
            parseConfidence: 0.05,
            parseStatus: "failed" as const,
            needsReview: true,
          }
        : baseParseSummary;
      const failureReason =
        parseSummary.parseStatus === "failed"
          ? detectedFailureReason ?? "Parsing produced no useful data"
          : null;
      const resultTimestamp = unixSecondsToIso(event.data.startTimeUnixSecs);
      const callSid = event.data.callSid ?? run.callSid ?? `missing-${run.id}`;
      const persistedItemsSource = overrideParsedOutcome
        ? parsedPrices.map((item) => ({
            ...item,
            priceText: null,
            priceNumeric: null,
            confidence: 0.05,
            needsReview: true,
            availabilityStatus: "unknown" as const,
            availableOnTap: null,
            availablePackageOnly: false,
            unavailableReason: null,
          }))
        : parsedPrices;

      this.callRunsRepository.saveTranscriptParseById(run.id, {
        conversationId: event.data.conversationId,
        rawTranscript,
        parseConfidence: parseSummary.parseConfidence,
        parseStatus: parseSummary.parseStatus,
        errorMessage: failureReason,
        endedAt: timestamp,
        updatedAt: timestamp,
      });

      this.beerPriceResultsRepository.replaceForCall({
        venueId: run.venueId,
        venueName: run.venueName,
        phoneNumber: run.phoneNumber,
        suburb: run.suburb,
        timestamp: resultTimestamp,
        rawTranscript,
        callSid,
        conversationId: event.data.conversationId,
        items: persistedItemsSource.map(({ evidence: _evidence, isUnavailable: _isUnavailable, ...item }) => ({
          ...item,
          needsReview: item.needsReview || parseSummary.needsReview,
        })),
        happyHour: {
          happyHour: false,
          happyHourDays: null,
          happyHourStart: null,
          happyHourEnd: null,
          happyHourPrice: null,
          happyHourConfidence: 0,
        },
      });

      if (this.supabaseResultsSyncService.isConfigured()) {
        try {
          await this.supabaseResultsSyncService.saveCallResult({
            run,
            callSid,
            conversationId: event.data.conversationId,
            resultTimestamp,
            savedAt: timestamp,
            rawTranscript,
            parseConfidence: parseSummary.parseConfidence,
            parseStatus: parseSummary.parseStatus,
            needsReview: parseSummary.needsReview,
            items: persistedItemsSource.map(({ evidence: _evidence, isUnavailable: _isUnavailable, ...item }) => ({
              ...item,
              needsReview: item.needsReview || parseSummary.needsReview,
            })),
            happyHour: {
              happyHour: false,
              happyHourDays: null,
              happyHourStart: null,
              happyHourEnd: null,
              happyHourPrice: null,
              happyHourConfidence: 0,
            },
          });
        } catch (error) {
          logger.error("Supabase call result sync failed", {
            runId: run.id,
            callSid,
            error: error instanceof Error ? error.message : "Unknown Supabase sync error",
          });
        }
      }

      logger.info("ElevenLabs transcript processed", {
        runId: run.id,
        callSid,
        parseStatus: parseSummary.parseStatus,
        parseConfidence: parseSummary.parseConfidence,
        venueName: run.venueName,
      });

      return {
        processed: true,
        type: event.type,
        callSid,
        parseStatus: parseSummary.parseStatus,
        parseConfidence: parseSummary.parseConfidence,
        needsReview: parseSummary.needsReview,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown parse failure";

      this.callRunsRepository.saveTranscriptParseById(run.id, {
        conversationId: event.data.conversationId,
        rawTranscript,
        parseConfidence: 0,
        parseStatus: "failed",
        errorMessage: message,
        endedAt: timestamp,
        updatedAt: timestamp,
      });

      logger.error("Transcript parsing failed", {
        runId: run.id,
        callSid: run.callSid,
        error: message,
      });

      return {
        processed: true,
        type: event.type,
        callSid: run.callSid,
        parseStatus: "failed",
        errorMessage: message,
      };
    }
  }

  private scheduleTranscriptRecovery(runId: string, conversationId: string) {
    if (this.transcriptRecoveryTimers.has(runId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.transcriptRecoveryTimers.delete(runId);
      void this.recoverTranscriptFromConversation(runId, conversationId);
    }, 30_000);

    this.transcriptRecoveryTimers.set(runId, timer);
  }

  private clearTranscriptRecovery(runId: string) {
    const timer = this.transcriptRecoveryTimers.get(runId);

    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.transcriptRecoveryTimers.delete(runId);
  }

  private async recoverTranscriptFromConversation(runId: string, conversationId: string) {
    const run = this.callRunsRepository.getById(runId);

    if (!run || run.parseStatus !== "pending") {
      return;
    }

    try {
      const conversation = await this.elevenLabsService.fetchConversation(conversationId);
      const result = await this.processNormalizedEvent(
        normalizeEvent({
          type: "post_call_transcription",
          data: conversation,
        }),
      );

      logger.info("Recovered transcript from ElevenLabs conversation API", {
        runId,
        conversationId,
        result,
      });
    } catch (error) {
      logger.warn("Transcript recovery from ElevenLabs conversation API failed", {
        runId,
        conversationId,
        error: error instanceof Error ? error.message : "Unknown recovery error",
      });
    }
  }

  private resolveCallRunFromEvent(data: NormalizedEventData | undefined, timestamp: string): CallRunRecord {
    const byCallSid = data?.callSid ? this.callRunsRepository.getByCallSid(data.callSid) : undefined;

    if (byCallSid) {
      if (data?.conversationId) {
        this.callRunsRepository.setConversationId(byCallSid.id, data.conversationId, timestamp);
      }

      return byCallSid;
    }

    const byConversationId = data?.conversationId
      ? this.callRunsRepository.getByConversationId(data.conversationId)
      : undefined;

    if (byConversationId) {
      return byConversationId;
    }

    const byId = data?.userId ? this.callRunsRepository.getById(data.userId) : undefined;

    if (byId) {
      if (data?.callSid) {
        this.callRunsRepository.updateDialSuccess(
          byId.id,
          data.callSid,
          normalizeCallStatus(data.status ?? "completed"),
          timestamp,
        );
      }

      if (data?.conversationId) {
        this.callRunsRepository.setConversationId(byId.id, data.conversationId, timestamp);
      }

      return this.callRunsRepository.getById(byId.id)!;
    }

    const dynamicRunId = this.getOptionalDynamicString(
      data?.dynamicVariables.call_run_id,
      data?.dynamicVariables.callRunId,
    );
    const byDynamicRunId = dynamicRunId ? this.callRunsRepository.getById(dynamicRunId) : undefined;

    if (byDynamicRunId) {
      if (data?.callSid) {
        this.callRunsRepository.updateDialSuccess(
          byDynamicRunId.id,
          data.callSid,
          normalizeCallStatus(data.status ?? "completed"),
          timestamp,
        );
      }

      if (data?.conversationId) {
        this.callRunsRepository.setConversationId(byDynamicRunId.id, data.conversationId, timestamp);
      }

      return this.callRunsRepository.getById(byDynamicRunId.id)!;
    }

    const runId = data?.userId ?? randomUUID();
    const dynamicVariables = data?.dynamicVariables ?? {};
    const run = this.callRunsRepository.create({
      id: runId,
      venueId: this.getOptionalDynamicString(dynamicVariables.venue_id, dynamicVariables.venueId),
      requestedBeer: normalizeTargetBeerKey(
        this.getOptionalDynamicString(dynamicVariables.requested_beer, dynamicVariables.requestedBeer),
      ),
      venueName: this.getDynamicString(dynamicVariables.venue_name, "Unknown venue"),
      phoneNumber: this.getDynamicString(
        dynamicVariables.phone_number,
        data?.externalNumber ?? "unknown",
      ),
      suburb: this.getDynamicString(dynamicVariables.suburb, "Unknown"),
      startedAt: unixSecondsToIso(data?.startTimeUnixSecs),
      callStatus: normalizeCallStatus(data?.status ?? "completed"),
      parseStatus: "pending",
      isTest: this.getDynamicString(dynamicVariables.test_mode, "false") === "true",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    if (data?.callSid) {
      this.callRunsRepository.updateDialSuccess(
        run.id,
        data.callSid,
        normalizeCallStatus(data.status ?? "completed"),
        timestamp,
      );
    }

    if (data?.conversationId) {
      this.callRunsRepository.setConversationId(run.id, data.conversationId, timestamp);
    }

    return this.callRunsRepository.getById(run.id)!;
  }

  private buildConversationInitiationData(run: CallRunRecord): Record<string, unknown> {
    const targetBeer = getBeerByKey(run.requestedBeer ?? normalizeTargetBeerKey(undefined));
    const promptSuffix = run.isTest
      ? "\nThis is a test call to the owner's own number. Still ask the normal questions so the call flow can be verified."
      : "";

    return {
      user_id: run.id,
        dynamic_variables: {
        ...(run.venueId ? { venue_id: run.venueId } : {}),
        venue_name: run.venueName,
        suburb: run.suburb,
        phone_number: run.phoneNumber,
        requested_beer: targetBeer.key,
        requested_beers: targetBeer.name,
        test_mode: run.isTest ? "true" : "false",
        call_run_id: run.id,
      },
      conversation_config_override: {
        agent: {
          language: "en",
          first_message: buildAgentFirstMessage(targetBeer.name),
          prompt: {
            prompt: `${buildAgentPrompt(targetBeer.name)}\nVenue name: ${run.venueName}\nSuburb: ${run.suburb}${promptSuffix}`,
          },
        },
      },
    };
  }

  private getDynamicString(value: unknown, fallback: string): string {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  }

  private getOptionalDynamicString(...values: unknown[]): string | null {
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }

    return null;
  }
}
