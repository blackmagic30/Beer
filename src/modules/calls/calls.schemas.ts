import { z } from "zod";
import { SUPPORTED_BEER_KEYS } from "../../constants/beers.js";
import { HAPPY_HOUR_SCRIPT_VARIANT_KEYS } from "../../constants/agent-script.js";

const e164PhoneRegex = /^\+[1-9]\d{7,14}$/;

export const outboundCallBodySchema = z.object({
  venueId: z.string().uuid("venueId must be a valid UUID"),
  venueName: z.string().trim().min(1).max(140),
  phoneNumber: z.string().trim().regex(e164PhoneRegex, "phoneNumber must be in E.164 format"),
  suburb: z.string().trim().min(1).max(120),
  requestedBeer: z.enum(SUPPORTED_BEER_KEYS).optional(),
  scriptVariant: z.enum(HAPPY_HOUR_SCRIPT_VARIANT_KEYS).optional(),
  testMode: z.boolean().optional().default(false),
});

export const callRunsQuerySchema = z.object({
  venueName: z.string().trim().min(1).optional(),
  suburb: z.string().trim().min(1).optional(),
  requestedBeer: z.enum(SUPPORTED_BEER_KEYS).optional(),
  scriptVariant: z.string().trim().min(1).optional(),
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
