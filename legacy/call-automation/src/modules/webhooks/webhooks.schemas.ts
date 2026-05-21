import { z } from "zod";

export const twilioVoiceWebhookRequestSchema = z.object({
  query: z.object({
    runId: z.string().trim().min(1),
  }),
  body: z
    .object({
      CallSid: z.string().trim().min(1).optional(),
      From: z.string().trim().min(1).optional(),
      To: z.string().trim().min(1).optional(),
      Direction: z.string().trim().optional(),
    })
    .passthrough(),
});

export const twilioStatusWebhookEnvelopeSchema = z.object({
  query: z
    .object({
      runId: z.string().trim().min(1).optional(),
    })
    .passthrough(),
  body: z
    .object({
      CallSid: z.string().trim().min(1),
      CallStatus: z.string().trim().min(1),
      CallDuration: z.string().trim().optional(),
      AnsweredBy: z.string().trim().optional(),
      To: z.string().trim().optional(),
      From: z.string().trim().optional(),
    })
    .passthrough(),
});

export type TwilioVoiceWebhookRequest = z.infer<typeof twilioVoiceWebhookRequestSchema>;
export type TwilioStatusWebhookRequest = z.infer<typeof twilioStatusWebhookEnvelopeSchema>;
