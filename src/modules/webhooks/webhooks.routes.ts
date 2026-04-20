import { Router, type Request, type Response } from "express";

import { failure, success } from "../../lib/http.js";
import { logger } from "../../lib/logger.js";

import {
  twilioStatusWebhookEnvelopeSchema,
  twilioVoiceWebhookRequestSchema,
} from "./webhooks.schemas.js";
import type { WebhooksService } from "./webhooks.service.js";

export function createWebhooksRouter(options: {
  webhooksService: WebhooksService;
  twilioService: import("../../lib/twilio.js").TwilioService;
  validateTwilioSignatures: boolean;
}): Router {
  const router = Router();
  const handleElevenLabsPostCall = async (req: Request, res: Response) => {
    logger.info("ElevenLabs post-call webhook hit", {
      path: req.originalUrl,
      rawBodyLength: req.rawBody?.length ?? 0,
      signaturePresent: Boolean(req.get("elevenlabs-signature")),
    });

    try {
      const result = await options.webhooksService.handleElevenLabsPostCallWebhook(
        req.rawBody ?? JSON.stringify(req.body),
        req.get("elevenlabs-signature") ?? undefined,
      );

      res.json(success(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown post-call webhook error";

      logger.error("ElevenLabs post-call webhook failed", {
        error: message,
      });
      res.json(failure("Failed to process ElevenLabs post-call webhook", { message }));
    }
  };

  router.post("/twilio/voice", async (req, res) => {
    logger.info("Twilio voice webhook hit", {
      path: req.originalUrl,
      runId: req.query.runId,
      callSid: typeof req.body?.CallSid === "string" ? req.body.CallSid : null,
      from: typeof req.body?.From === "string" ? req.body.From : null,
      to: typeof req.body?.To === "string" ? req.body.To : null,
    });

    const validation = options.twilioService.isValidRequest(req, options.validateTwilioSignatures);

    if (!validation.isValid) {
      logger.warn("Twilio voice webhook signature validation failed", {
        reason: validation.reason,
        path: req.originalUrl,
      });
      res
        .type("text/xml")
        .send(options.twilioService.buildFallbackVoiceResponse("Sorry, we couldn't connect the assistant right now."));
      return;
    }

    const parsed = twilioVoiceWebhookRequestSchema.safeParse({
      query: req.query,
      body: req.body,
    });

    if (!parsed.success) {
      logger.warn("Malformed Twilio voice webhook payload", {
        issues: parsed.error.flatten(),
      });
      res
        .type("text/xml")
        .send(options.twilioService.buildFallbackVoiceResponse("Sorry, there was a call setup problem."));
      return;
    }

    try {
      const twiml = await options.webhooksService.handleTwilioVoiceWebhook(parsed.data);
      res.type("text/xml").send(twiml);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Twilio voice webhook error";

      logger.error("Twilio voice webhook failed", {
        runId: parsed.data.query.runId,
        error: message,
      });
      options.webhooksService.handleVoiceWebhookFailure(parsed.data.query.runId, message);
      res
        .type("text/xml")
        .send(options.twilioService.buildFallbackVoiceResponse("Sorry, the voice assistant is unavailable right now."));
    }
  });

  router.post("/twilio/status", async (req, res) => {
    logger.info("Twilio status webhook hit", {
      path: req.originalUrl,
      runId: req.query.runId,
      callSid: typeof req.body?.CallSid === "string" ? req.body.CallSid : null,
      status: typeof req.body?.CallStatus === "string" ? req.body.CallStatus : null,
    });

    const validation = options.twilioService.isValidRequest(req, options.validateTwilioSignatures);

    if (!validation.isValid) {
      res.status(401).json(failure(validation.reason ?? "Invalid Twilio signature"));
      return;
    }

    const parsed = twilioStatusWebhookEnvelopeSchema.safeParse({
      query: req.query,
      body: req.body,
    });

    if (!parsed.success) {
      logger.warn("Malformed Twilio status webhook payload", {
        issues: parsed.error.flatten(),
      });
      res.json(failure("Invalid Twilio status webhook payload", parsed.error.flatten()));
      return;
    }

    try {
      const result = options.webhooksService.handleTwilioStatusWebhook(parsed.data);
      res.json(success(result));
    } catch (error) {
      logger.error("Twilio status webhook failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      res.json(failure("Failed to process Twilio status webhook"));
    }
  });

  router.post("/elevenlabs/post-call", handleElevenLabsPostCall);
  router.post("/elevenlabs-webhook", handleElevenLabsPostCall);

  return router;
}
