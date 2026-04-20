import { z } from "zod";

const e164PhoneRegex = /^\+[1-9]\d{7,14}$/;

export const outboundCallBodySchema = z.object({
  venueId: z.string().uuid("venueId must be a valid UUID"),
  venueName: z.string().trim().min(1).max(140),
  phoneNumber: z.string().trim().regex(e164PhoneRegex, "phoneNumber must be in E.164 format"),
  suburb: z.string().trim().min(1).max(120),
  testMode: z.boolean().optional().default(false),
});

export const callRunsQuerySchema = z.object({
  venueName: z.string().trim().min(1).optional(),
  suburb: z.string().trim().min(1).optional(),
  needsReview: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  testMode: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const callSidParamSchema = z.object({
  callSid: z.string().trim().min(1),
});

export type OutboundCallBody = z.infer<typeof outboundCallBodySchema>;
export type CallRunsQuery = z.infer<typeof callRunsQuerySchema>;
