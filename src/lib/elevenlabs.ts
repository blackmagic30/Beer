import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

import { AppError, ExternalServiceError } from "./errors.js";

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

export class ElevenLabsService {
  private readonly client?: ElevenLabsClient;

  constructor(
    private readonly apiKey?: string,
    private readonly webhookSecret?: string,
  ) {
    if (apiKey) {
      this.client = new ElevenLabsClient({
        apiKey,
      });
    }
  }

  isConfigured(agentId?: string): boolean {
    return Boolean(this.apiKey && agentId);
  }

  async registerTwilioCall(input: {
    agentId: string;
    fromNumber: string;
    toNumber: string;
    conversationInitiationClientData?: Record<string, unknown>;
  }): Promise<string> {
    if (!this.apiKey) {
      throw new AppError("ElevenLabs API key is not configured", 500);
    }

    const response = await fetch(`${ELEVENLABS_BASE_URL}/v1/convai/twilio/register-call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": this.apiKey,
      },
      body: JSON.stringify({
        agent_id: input.agentId,
        from_number: input.fromNumber,
        to_number: input.toNumber,
        direction: "outbound",
        // ElevenLabs connection payloads can vary by workspace configuration.
        // If your account locks prompt overrides or expects different dynamic variables,
        // adjust this object to match the agent setup in the ElevenLabs dashboard.
        conversation_initiation_client_data: input.conversationInitiationClientData,
      }),
    });

    const body = await response.text();

    if (!response.ok) {
      throw new ExternalServiceError("ElevenLabs register-call request failed", {
        status: response.status,
        body,
      });
    }

    return body;
  }

  async verifyAndParseWebhook(rawBody: string, signatureHeader?: string): Promise<any> {
    if (!this.webhookSecret) {
      return JSON.parse(rawBody);
    }

    if (!this.client) {
      throw new AppError("ElevenLabs webhook verification is not configured", 500);
    }

    if (!signatureHeader) {
      throw new AppError("Missing ElevenLabs signature header", 401);
    }

    return this.client.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
  }

  async fetchConversation(conversationId: string): Promise<unknown> {
    if (!this.apiKey) {
      throw new AppError("ElevenLabs API key is not configured", 500);
    }

    const response = await fetch(`${ELEVENLABS_BASE_URL}/v1/convai/conversations/${conversationId}`, {
      headers: {
        "xi-api-key": this.apiKey,
      },
    });

    const body = await response.text();

    if (!response.ok) {
      throw new ExternalServiceError("ElevenLabs fetch conversation request failed", {
        status: response.status,
        body,
      });
    }

    return JSON.parse(body);
  }
}
