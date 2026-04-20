import { z } from "zod";

export const resultsQuerySchema = z.object({
  callSid: z.string().trim().min(1).optional(),
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
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type ResultsQuery = z.infer<typeof resultsQuerySchema>;
