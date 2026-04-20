import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const e164PhoneRegex = /^\+[1-9]\d{7,14}$/;

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();

    if (["1", "true", "yes", "on"].includes(normalised)) {
      return true;
    }

    if (["0", "false", "no", "off"].includes(normalised)) {
      return false;
    }
  }

  return value;
}, z.boolean());

const optionalStringFromEnv = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}, z.string().min(1).optional());

const clockTimeRegex = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_PATH: z.string().default("./data/melb-beer-bot.sqlite"),
  TRUST_PROXY: booleanFromEnv.default(true),
  OUTBOUND_CALLS_ENABLED: booleanFromEnv.default(true),
  OUTBOUND_CALL_TIMEZONE: z.string().min(1).default("Australia/Melbourne"),
  OUTBOUND_CALL_WINDOW_START: z.string().regex(clockTimeRegex).default("11:00"),
  OUTBOUND_CALL_WINDOW_END: z.string().regex(clockTimeRegex).default("20:30"),
  OUTBOUND_CALL_ALLOWED_DAYS: z.string().min(1).default("mon,tue,wed,thu,fri,sat,sun"),
  OUTBOUND_REPEAT_GUARD_SECONDS: z.coerce.number().int().min(0).default(300),
  PARSE_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
  BATCH_CALL_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().min(1).max(20).default(5),
  SUPABASE_URL: optionalStringFromEnv,
  SUPABASE_ANON_KEY: optionalStringFromEnv,
  SUPABASE_SERVICE_ROLE_KEY: optionalStringFromEnv,
  SUPABASE_RESULTS_TABLE: optionalStringFromEnv.default("call_results"),
  GOOGLE_MAPS_API_KEY: optionalStringFromEnv,
  GOOGLE_MAPS_MAP_ID: optionalStringFromEnv,
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_PHONE_NUMBER: z.string().regex(e164PhoneRegex, "TWILIO_PHONE_NUMBER must be in E.164 format"),
  TWILIO_CALL_TIME_LIMIT_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
  TWILIO_VALIDATE_SIGNATURES: booleanFromEnv.default(false),
  ELEVENLABS_API_KEY: optionalStringFromEnv,
  ELEVENLABS_AGENT_ID: optionalStringFromEnv,
  ELEVENLABS_WEBHOOK_SECRET: optionalStringFromEnv,
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  throw new Error(`Invalid environment configuration: ${JSON.stringify(parsedEnv.error.flatten(), null, 2)}`);
}

export const env = {
  ...parsedEnv.data,
  DATABASE_PATH: path.isAbsolute(parsedEnv.data.DATABASE_PATH)
    ? parsedEnv.data.DATABASE_PATH
    : path.resolve(process.cwd(), parsedEnv.data.DATABASE_PATH),
};

export type Env = typeof env;
