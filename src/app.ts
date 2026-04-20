import path from "node:path";

import express from "express";
import cors from "cors";
import helmet from "helmet";

import { env } from "./config/env.js";
import { createDatabase } from "./db/database.js";
import { BeerPriceResultsRepository } from "./db/beer-price-results.repository.js";
import { CallRunsRepository } from "./db/call-runs.repository.js";
import { ElevenLabsService } from "./lib/elevenlabs.js";
import { success } from "./lib/http.js";
import { SupabaseResultsSyncService } from "./lib/supabase-results-sync.js";
import { TwilioService } from "./lib/twilio.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { captureRawBody } from "./middleware/raw-body.js";
import { createCallsRouter } from "./modules/calls/calls.routes.js";
import { CallsService } from "./modules/calls/calls.service.js";
import { createResultsRouter } from "./modules/results/results.routes.js";
import { ResultsService } from "./modules/results/results.service.js";
import { createWebhooksRouter } from "./modules/webhooks/webhooks.routes.js";
import { WebhooksService } from "./modules/webhooks/webhooks.service.js";

export function createApp() {
  const app = express();
  const viewerDirectory = path.resolve(process.cwd(), "viewer");
  const database = createDatabase();
  const callRunsRepository = new CallRunsRepository(database);
  const beerPriceResultsRepository = new BeerPriceResultsRepository(database);
  const twilioService = new TwilioService(
    env.TWILIO_ACCOUNT_SID,
    env.TWILIO_AUTH_TOKEN,
    env.TWILIO_PHONE_NUMBER,
    env.TWILIO_CALL_TIME_LIMIT_SECONDS,
  );
  const elevenLabsService = new ElevenLabsService(
    env.ELEVENLABS_API_KEY,
    env.ELEVENLABS_WEBHOOK_SECRET,
  );
  const callsService = new CallsService(
    callRunsRepository,
    beerPriceResultsRepository,
    twilioService,
    env.PUBLIC_BASE_URL,
    env.OUTBOUND_REPEAT_GUARD_SECONDS,
    env.PARSE_CONFIDENCE_THRESHOLD,
  );
  const resultsService = new ResultsService(
    callRunsRepository,
    beerPriceResultsRepository,
    env.PARSE_CONFIDENCE_THRESHOLD,
  );
  const supabaseResultsSyncService = new SupabaseResultsSyncService(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.SUPABASE_RESULTS_TABLE,
  );
  const webhooksService = new WebhooksService(
    callRunsRepository,
    beerPriceResultsRepository,
    elevenLabsService,
    supabaseResultsSyncService,
    env.ELEVENLABS_AGENT_ID,
    env.PARSE_CONFIDENCE_THRESHOLD,
  );

  app.set("trust proxy", env.TRUST_PROXY);
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, verify: captureRawBody }));

  app.get("/health", (_req, res) => {
    res.json(
      success({
        service: "melb-beer-bot",
        status: "ok",
      }),
    );
  });

  app.get("/config.js", (_req, res) => {
    const viewerConfig = {
      supabaseUrl: env.SUPABASE_URL ?? "",
      supabaseAnonKey: env.SUPABASE_ANON_KEY ?? "",
      googleMapsApiKey: env.GOOGLE_MAPS_API_KEY ?? "",
      googleMapsMapId: env.GOOGLE_MAPS_MAP_ID ?? "",
    };

    res.type("application/javascript").send(
      `window.MELB_BEER_BOT_VIEWER_CONFIG = ${JSON.stringify(viewerConfig, null, 2)};\n`,
    );
  });

  app.use("/api/calls", createCallsRouter(callsService));
  app.use("/api/results", createResultsRouter(resultsService));
  const webhooksRouter = createWebhooksRouter({
    webhooksService,
    twilioService,
    validateTwilioSignatures: env.TWILIO_VALIDATE_SIGNATURES,
  });

  app.use("/webhooks", webhooksRouter);
  app.use("/api", webhooksRouter);
  app.use(express.static(viewerDirectory));
  app.get("/", (_req, res) => {
    res.sendFile(path.join(viewerDirectory, "index.html"));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
