import path from "node:path";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import type { RequestHandler } from "express";

import { env } from "./config/env.js";
import { success } from "./lib/http.js";
import { logger } from "./lib/logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { captureRawBody } from "./middleware/raw-body.js";

type LazyRouters = {
  callsRouter: RequestHandler;
  resultsRouter: RequestHandler;
  webhooksRouter: RequestHandler;
};

let lazyRoutersPromise: Promise<LazyRouters> | undefined;

async function buildLazyRouters(): Promise<LazyRouters> {
  console.info("Initializing backend services...");

  const [
    { createDatabase },
    { BeerPriceResultsRepository },
    { CallRunsRepository },
    { ElevenLabsService },
    { SupabaseResultsSyncService },
    { TwilioService },
    { createCallsRouter },
    { CallsService },
    { createResultsRouter },
    { ResultsService },
    { createWebhooksRouter },
    { WebhooksService },
  ] = await Promise.all([
    import("./db/database.js"),
    import("./db/beer-price-results.repository.js"),
    import("./db/call-runs.repository.js"),
    import("./lib/elevenlabs.js"),
    import("./lib/supabase-results-sync.js"),
    import("./lib/twilio.js"),
    import("./modules/calls/calls.routes.js"),
    import("./modules/calls/calls.service.js"),
    import("./modules/results/results.routes.js"),
    import("./modules/results/results.service.js"),
    import("./modules/webhooks/webhooks.routes.js"),
    import("./modules/webhooks/webhooks.service.js"),
  ]);

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

  console.info("Backend services initialized.");

  return {
    callsRouter: createCallsRouter(callsService),
    resultsRouter: createResultsRouter(resultsService),
    webhooksRouter: createWebhooksRouter({
      webhooksService,
      twilioService,
      validateTwilioSignatures: env.TWILIO_VALIDATE_SIGNATURES,
    }),
  };
}

async function getLazyRouters(): Promise<LazyRouters> {
  if (!lazyRoutersPromise) {
    lazyRoutersPromise = buildLazyRouters().catch((error) => {
      lazyRoutersPromise = undefined;
      console.error("Backend initialization failed", error);
      throw error;
    });
  }

  return lazyRoutersPromise;
}

function createLazyMount(selector: (routers: LazyRouters) => RequestHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      const routers = await getLazyRouters();
      return selector(routers)(req, res, next);
    } catch (error) {
      return next(error);
    }
  };
}

export function createApp() {
  const app = express();
  const viewerDirectory = path.resolve(process.cwd(), "viewer");

  app.set("trust proxy", env.TRUST_PROXY);
  // The hosted viewer loads Google Maps, Supabase, and inline bootstrap code in the browser.
  // Helmet's default CSP blocks those resources, which leaves the page stuck on "Starting viewer...".
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );
  app.use(cors());
  app.use((req, _res, next) => {
    if (req.path === "/health" || req.path === "/" || req.path === "/config.js") {
      logger.info("Inbound request", {
        method: req.method,
        path: req.originalUrl,
      });
    }
    next();
  });
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

  app.use("/api/calls", createLazyMount((routers) => routers.callsRouter));
  app.use("/api/results", createLazyMount((routers) => routers.resultsRouter));
  app.use("/webhooks", createLazyMount((routers) => routers.webhooksRouter));
  app.use("/api", createLazyMount((routers) => routers.webhooksRouter));
  app.use(express.static(viewerDirectory));
  app.get("/", (_req, res) => {
    res.sendFile(path.join(viewerDirectory, "index.html"));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
