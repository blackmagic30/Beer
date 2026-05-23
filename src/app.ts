import path from "node:path";

import express from "express";
import helmet from "helmet";
import type { Request, RequestHandler } from "express";

import { env } from "./config/env.js";
import { PREMIUM_PRICING } from "./config/business-rules.js";
import { VIEWER_TRACKED_BEERS } from "./constants/beers.js";
import { AppError } from "./lib/errors.js";
import { success } from "./lib/http.js";
import { logger } from "./lib/logger.js";
import { redactSecrets } from "./lib/redact.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { captureRawBody } from "./middleware/raw-body.js";

type LazyRouters = {
  adminRouter: RequestHandler;
  businessRouter: RequestHandler;
};

let lazyRoutersPromise: Promise<LazyRouters> | undefined;

async function buildLazyRouters(): Promise<LazyRouters> {
  console.info("Initializing backend services...");

  const [
    { createDatabase },
    { AdminIngestionQueueRepository },
    { BusinessRepository },
    { createAdminRouter },
    { AdminService },
    { createBusinessRouter },
    { BusinessService },
  ] = await Promise.all([
    import("./db/database.js"),
    import("./db/admin-ingestion-queue.repository.js"),
    import("./db/business.repository.js"),
    import("./modules/admin/admin.routes.js"),
    import("./modules/admin/admin.service.js"),
    import("./modules/business/business.routes.js"),
    import("./modules/business/business.service.js"),
  ]);

  const database = createDatabase();
  const adminIngestionQueueRepository = new AdminIngestionQueueRepository(database);
  const businessRepository = new BusinessRepository(database);
  const adminService = new AdminService(
    adminIngestionQueueRepository,
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.SUPABASE_MENU_CAPTURE_TABLE,
    env.OPENAI_API_KEY,
  );
  const businessService = new BusinessService(businessRepository, env);
  businessService.logStartupSummary();

  console.info("Backend services initialized.");

  return {
    adminRouter: createAdminRouter(adminService, businessService),
    businessRouter: createBusinessRouter(businessService),
  };
}

async function getLazyRouters(): Promise<LazyRouters> {
  if (!lazyRoutersPromise) {
    lazyRoutersPromise = buildLazyRouters().catch((error) => {
      lazyRoutersPromise = undefined;
      logger.error("Backend initialization failed", {
        error: error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error)),
      });
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

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();

  try {
    origins.add(new URL(env.PUBLIC_BASE_URL).origin);
  } catch {
    // Env validation should catch this; keep the helper fail-closed if reused in tests.
  }

  if (env.NODE_ENV !== "production") {
    [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:8080",
      "http://127.0.0.1:8080",
    ].forEach((origin) => origins.add(origin));
  }

  return origins;
}

function getRequestOrigin(req: Request): string | null {
  const host = req.get("host");
  if (!host) {
    return null;
  }

  return `${req.protocol}://${host}`;
}

function isTrustedOrigin(req: Request, origin: string | undefined, allowedOrigins: Set<string>): boolean {
  if (!origin) {
    return true;
  }

  if (allowedOrigins.has(origin)) {
    return true;
  }

  return origin === getRequestOrigin(req);
}

export function createApp() {
  const app = express();
  const viewerDirectory = path.resolve(process.cwd(), "viewer");
  const allowedOrigins = getAllowedOrigins();
  const cspConnectSources = [
    "'self'",
    "https://maps.googleapis.com",
    "https://*.googleapis.com",
    "https://*.google.com",
    "https://*.gstatic.com",
    "https://*.supabase.co",
    "https://*.supabase.com",
  ];

  if (env.SUPABASE_URL) {
    cspConnectSources.push(new URL(env.SUPABASE_URL).origin);
  }

  app.set("trust proxy", env.TRUST_PROXY);
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "base-uri": ["'self'"],
          "object-src": ["'none'"],
          "frame-ancestors": ["'self'"],
          "form-action": ["'self'", "https://checkout.stripe.com"],
          "script-src": [
            "'self'",
            "'unsafe-inline'",
            "https://maps.googleapis.com",
            "https://maps.gstatic.com",
            "https://cdn.jsdelivr.net",
          ],
          "script-src-elem": [
            "'self'",
            "'unsafe-inline'",
            "https://maps.googleapis.com",
            "https://maps.gstatic.com",
            "https://cdn.jsdelivr.net",
          ],
          "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          "img-src": [
            "'self'",
            "data:",
            "blob:",
            "https://maps.gstatic.com",
            "https://maps.googleapis.com",
            "https://*.googleapis.com",
            "https://*.google.com",
            "https://*.gstatic.com",
            "https://*.ggpht.com",
            "https://*.googleusercontent.com",
          ],
          "connect-src": cspConnectSources,
          "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
          // Safari upgrades localhost subresources when this directive is present,
          // which leaves external CSS/JS pages looking like raw HTML in local dev.
          "upgrade-insecure-requests": env.NODE_ENV === "production" ? [] : null,
        },
      },
      ...(env.NODE_ENV === "production" ? {} : { strictTransportSecurity: false }),
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", "camera=(self), geolocation=(self), microphone=(), payment=(self)");
    next();
  });
  app.use((req, res, next) => {
    const origin = req.get("origin");

    if (origin && isTrustedOrigin(req, origin, allowedOrigins)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Stripe-Signature,X-Requested-With");
    }

    if (req.method === "OPTIONS") {
      if (!origin || isTrustedOrigin(req, origin, allowedOrigins)) {
        res.sendStatus(204);
        return;
      }

      next(new AppError("CORS origin not allowed.", 403));
      return;
    }

    next();
  });
  app.use((req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      next();
      return;
    }

    if (!isTrustedOrigin(req, req.get("origin"), allowedOrigins)) {
      next(new AppError("Untrusted request origin.", 403));
      return;
    }

    next();
  });
  app.use((req, _res, next) => {
    if (req.path === "/health" || req.path === "/" || req.path === "/config.js") {
      logger.info("Inbound request", {
        method: req.method,
        path: req.originalUrl,
      });
    }
    next();
  });
  app.use(express.json({ limit: "12mb", verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, limit: "12mb", verify: captureRawBody }));

  app.get("/health", (_req, res) => {
    res.json(
      success({
        service: "pint-path",
        status: "ok",
      }),
    );
  });

  app.get("/ready", async (_req, res, next) => {
    try {
      await getLazyRouters();
      res.json(
        success({
          service: "pint-path",
          status: "ready",
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/config.js", (_req, res) => {
    const viewerConfig = {
      // The public viewer uses server-gated API routes for venue and price data.
      // Supabase anon config is exposed only for OAuth login; exact price access stays server-gated.
      googleMapsApiKey: env.GOOGLE_MAPS_API_KEY ?? "",
      googleMapsMapId: env.GOOGLE_MAPS_MAP_ID ?? "",
      publicBaseUrl: env.PUBLIC_BASE_URL,
      supabaseUrl: env.SUPABASE_URL ?? "",
      supabaseAnonKey: env.SUPABASE_ANON_KEY ?? "",
      supabaseOauthProviders: env.SUPABASE_OAUTH_PROVIDERS.split(",").map((provider) => provider.trim()).filter(Boolean),
      trackedBeers: VIEWER_TRACKED_BEERS,
      business: {
        freePriceRevealsPerDay: env.FREE_PRICE_REVEALS_PER_DAY,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        contributorUnlockPoints: env.CONTRIBUTOR_UNLOCK_POINTS,
        contributorUnlockDays: env.CONTRIBUTOR_UNLOCK_DAYS,
        demoBillingMode: env.DEMO_BILLING_MODE,
        fieldTestMode: env.FIELD_TEST_MODE,
        pricing: {
          monthly: PREMIUM_PRICING.monthlyLabel,
          yearly: PREMIUM_PRICING.yearlyLabel,
        },
      },
    };

    res
      .type("application/javascript")
      .setHeader("Cache-Control", "no-store")
      .send(
      `window.MELB_BEER_BOT_VIEWER_CONFIG = ${JSON.stringify(viewerConfig, null, 2)};\n`,
    );
  });

  app.use("/api/business", createLazyMount((routers) => routers.businessRouter));
  app.use("/api/admin", createLazyMount((routers) => routers.adminRouter));
  app.get("/for-bars", (_req, res) => {
    res.redirect(302, "/venue-portal");
  });
  app.get("/for-bars.html", (_req, res) => {
    res.redirect(302, "/venue-portal");
  });
  app.get("/auth/callback", (_req, res) => {
    res.sendFile(path.join(viewerDirectory, "auth", "callback.html"));
  });
  app.use(express.static(viewerDirectory));
  app.get("/", (_req, res) => {
    res.sendFile(path.join(viewerDirectory, "index.html"));
  });
  app.get("/venue-portal", (_req, res) => {
    res.sendFile(path.join(viewerDirectory, "venue-portal.html"));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
