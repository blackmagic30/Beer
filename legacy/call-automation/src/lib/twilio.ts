import type { Request, RequestHandler } from "express";
import twilio from "twilio";

import { AppError } from "./errors.js";
import { failure } from "./http.js";

function buildExternalRequestUrl(req: Request): string {
  const protocol = req.get("x-forwarded-proto") ?? req.protocol;
  const host = req.get("x-forwarded-host") ?? req.get("host");

  return `${protocol}://${host}${req.originalUrl}`;
}

export class TwilioService {
  private readonly client?: ReturnType<typeof twilio>;

  constructor(
    accountSid: string | undefined,
    authToken: string | undefined,
    private readonly fromNumber: string | undefined,
    private readonly callTimeLimitSeconds: number,
  ) {
    if (accountSid && authToken) {
      this.client = twilio(accountSid, authToken);
    }

    this.authToken = authToken;
  }

  private readonly authToken: string | undefined;

  isConfigured(): boolean {
    return Boolean(this.client && this.fromNumber);
  }

  async createOutboundCall(input: {
    toNumber: string;
    voiceWebhookUrl: string;
    statusWebhookUrl: string;
  }) {
    if (!this.client || !this.fromNumber) {
      throw new AppError("Twilio outbound calling is not configured", 503, {
        missing: {
          accountSid: !this.client,
          fromNumber: !this.fromNumber,
        },
      });
    }

    return this.client.calls.create({
      to: input.toNumber,
      from: this.fromNumber,
      url: input.voiceWebhookUrl,
      method: "POST",
      statusCallback: input.statusWebhookUrl,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      timeLimit: this.callTimeLimitSeconds,
    });
  }

  isValidRequest(req: Request, enabled: boolean): { isValid: boolean; reason?: string } {
    if (!enabled) {
      return { isValid: true };
    }

    if (!this.authToken) {
      return {
        isValid: false,
        reason: "Twilio auth token is not configured",
      };
    }

    const signature = req.get("x-twilio-signature");

    if (!signature) {
      return {
        isValid: false,
        reason: "Missing Twilio signature header",
      };
    }

    const isValid = twilio.validateRequest(
      this.authToken,
      signature,
      buildExternalRequestUrl(req),
      req.body as Record<string, string>,
    );

    return isValid
      ? { isValid: true }
      : { isValid: false, reason: "Invalid Twilio signature" };
  }

  buildFallbackVoiceResponse(message: string): string {
    const voiceResponse = new twilio.twiml.VoiceResponse();
    voiceResponse.say(
      {
        voice: "alice",
      },
      message,
    );
    voiceResponse.hangup();

    return voiceResponse.toString();
  }

  createSignatureValidator(enabled: boolean): RequestHandler {
    return (req, res, next) => {
      const validation = this.isValidRequest(req, enabled);

      if (validation.isValid) {
        next();
        return;
      }

      res.status(401).json(failure(validation.reason ?? "Invalid Twilio signature"));
    };
  }
}
