import path from "node:path";

import express from "express";
import helmet from "helmet";
import type { Request, RequestHandler, Response } from "express";

import { env } from "./config/env.js";
import { PREMIUM_PRICING } from "./config/business-rules.js";
import { AppError } from "./lib/errors.js";
import { success } from "./lib/http.js";
import { logger } from "./lib/logger.js";
import { redactSecrets } from "./lib/redact.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { captureRawBody } from "./middleware/raw-body.js";
import type { BusinessService } from "./modules/business/business.service.js";

type LazyRouters = {
  adminRouter: RequestHandler;
  businessRouter: RequestHandler;
  businessService: BusinessService;
};

let lazyRoutersPromise: Promise<LazyRouters> | undefined;

async function buildLazyRouters(): Promise<LazyRouters> {
  console.info("Initializing backend services...");

  const [
    { createDatabase },
    { AdminIngestionQueueRepository },
    { BeerCatalogRepository },
    { BusinessRepository },
    { createAdminRouter },
    { AdminService },
    { createBusinessRouter },
    { BusinessService },
  ] = await Promise.all([
    import("./db/database.js"),
    import("./db/admin-ingestion-queue.repository.js"),
    import("./db/beer-catalog.repository.js"),
    import("./db/business.repository.js"),
    import("./modules/admin/admin.routes.js"),
    import("./modules/admin/admin.service.js"),
    import("./modules/business/business.routes.js"),
    import("./modules/business/business.service.js"),
  ]);

  const database = createDatabase();
  const adminIngestionQueueRepository = new AdminIngestionQueueRepository(database);
  const beerCatalogRepository = new BeerCatalogRepository(database);
  const businessRepository = new BusinessRepository(database);
  const adminService = new AdminService(
    adminIngestionQueueRepository,
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.SUPABASE_MENU_CAPTURE_TABLE,
    env.OPENAI_API_KEY,
    env.GOOGLE_PLACES_API_KEY ?? env.GOOGLE_MAPS_API_KEY,
    database,
  );
  const businessService = new BusinessService(businessRepository, env, beerCatalogRepository);
  businessService.logStartupSummary();

  console.info("Backend services initialized.");

  return {
    adminRouter: createAdminRouter(adminService, businessService),
    businessRouter: createBusinessRouter(businessService),
    businessService,
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function absoluteUrl(pathname: string): string {
  return new URL(pathname, env.PUBLIC_BASE_URL).toString();
}

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function getStaticAssetCacheControl(filePath: string): string {
  if (env.NODE_ENV !== "production") {
    return "no-store";
  }

  const extension = path.extname(filePath).toLowerCase();
  const normalizedPath = filePath.replaceAll(path.sep, "/");

  if (extension === ".html") {
    return "no-store";
  }

  if ([".js", ".css", ".txt", ".xml", ".webmanifest"].includes(extension)) {
    return "public, max-age=300, stale-while-revalidate=3600";
  }

  if (normalizedPath.includes("/assets/") || [".ico", ".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(extension)) {
    return "public, max-age=86400, stale-while-revalidate=604800";
  }

  return "public, max-age=300, stale-while-revalidate=3600";
}

function setStaticAssetHeaders(res: Response, filePath: string): void {
  res.setHeader("Cache-Control", getStaticAssetCacheControl(filePath));
}

function renderPublicVenuePage(venue: Awaited<ReturnType<BusinessService["getPublicVenueById"]>>): string {
  if (!venue) {
    throw new AppError("Venue not found.", 404);
  }

  const title = `${venue.name} beer prices and happy hours | Pint Path`;
  const locationParts = [venue.address, venue.suburb, venue.state, venue.postcode].filter(Boolean);
  const location = locationParts.join(", ");
  const description = `View ${venue.name}${venue.suburb ? ` in ${venue.suburb}` : ""} on Pint Path for mapped beer data, happy-hour details, directions, and venue updates.`;
  const canonicalUrl = absoluteUrl(`/venues/${encodeURIComponent(venue.id)}`);
  const mapUrl = absoluteUrl(`/?venueId=${encodeURIComponent(venue.id)}&venueName=${encodeURIComponent(venue.name)}`);
  const portalUrl = absoluteUrl(`/venue-portal?venueId=${encodeURIComponent(venue.id)}`);
  const imageUrl = absoluteUrl("/assets/pint-path-logo.png");
  const tier = venue.membershipTier === "pro" ? "Pro" : "Free";
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "BarOrPub",
    name: venue.name,
    address: location
      ? {
          "@type": "PostalAddress",
          streetAddress: venue.address || undefined,
          addressLocality: venue.suburb || undefined,
          addressRegion: venue.state || undefined,
          postalCode: venue.postcode || undefined,
          addressCountry: "AU",
        }
      : undefined,
    url: canonicalUrl,
    image: imageUrl,
    geo: venue.latitude && venue.longitude
      ? {
          "@type": "GeoCoordinates",
          latitude: venue.latitude,
          longitude: venue.longitude,
        }
      : undefined,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <meta property="og:type" content="place" />
  <meta property="og:site_name" content="Pint Path" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta property="og:image" content="${escapeHtml(imageUrl)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
  <script type="application/ld+json">${safeJsonForHtml(structuredData)}</script>
  <style>
    :root { color-scheme: dark; --bg:#070a12; --panel:#121a2c; --text:#f8fafc; --muted:#cbd5e1; --cyan:#22d3ee; --gold:#f5c542; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 18% 0%, rgba(34,211,238,.14), transparent 30%), radial-gradient(circle at 90% 10%, rgba(139,92,246,.16), transparent 28%), var(--bg); color: var(--text); font-family: "Avenir Next", "Segoe UI", sans-serif; }
    main { width: min(920px, 100%); display: grid; gap: 18px; }
    .panel { border: 1px solid rgba(255,255,255,.12); border-radius: 26px; background: linear-gradient(145deg, rgba(255,255,255,.08), rgba(255,255,255,.025)), rgba(18,26,44,.88); box-shadow: 0 28px 76px rgba(0,0,0,.42); padding: clamp(22px, 4vw, 42px); }
    .eyebrow { color: var(--cyan); font-size: 12px; font-weight: 950; letter-spacing: .13em; text-transform: uppercase; }
    h1 { margin: 10px 0 12px; font-size: clamp(36px, 7vw, 72px); line-height: 1; letter-spacing: -.04em; }
    p { color: var(--muted); font-size: 17px; line-height: 1.6; margin: 0; }
    .meta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
    .pill { border: 1px solid rgba(255,255,255,.12); border-radius: 999px; background: rgba(255,255,255,.07); padding: 8px 12px; color: #e2e8f0; font-size: 13px; font-weight: 850; }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 28px; }
    a { min-height: 46px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; padding: 12px 16px; color: var(--text); text-decoration: none; font-weight: 950; }
    .primary { color: #06101f; background: linear-gradient(135deg, #38bdf8, #22d3ee, #8b5cf6); }
    .secondary { border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); }
    .note { font-size: 13px; color: #94a3b8; }
  </style>
</head>
<body>
  <main>
    <section class="panel">
      <div class="eyebrow">Pint Path venue</div>
      <h1>${escapeHtml(venue.name)}</h1>
      <p>${escapeHtml(location || "Mapped Melbourne venue")}</p>
      <div class="meta">
        <span class="pill">${escapeHtml(tier)} listing</span>
        ${venue.suburb ? `<span class="pill">${escapeHtml(venue.suburb)}</span>` : ""}
        <span class="pill">Beer data and happy-hour map</span>
      </div>
      <div class="actions">
        <a class="primary" href="${escapeHtml(mapUrl)}">Open on map</a>
        <a class="secondary" href="${escapeHtml(portalUrl)}">Manage this venue</a>
      </div>
    </section>
    <p class="note">Venue data may change. Check directly with the venue before ordering, travelling, or relying on special availability.</p>
  </main>
</body>
</html>`;
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
        path: req.path,
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

  app.get("/config.js", async (_req, res, next) => {
    try {
      const { businessService } = await getLazyRouters();
      const publicConfig = businessService.getPublicConfig();
      const viewerConfig = {
        // The public viewer uses server-gated API routes for venue and price data.
        // Supabase anon config is exposed only for OAuth login; exact price access stays server-gated.
        googleMapsApiKey: env.GOOGLE_MAPS_API_KEY ?? "",
        googleMapsMapId: env.GOOGLE_MAPS_MAP_ID ?? "",
        publicBaseUrl: env.PUBLIC_BASE_URL,
        supabaseUrl: env.SUPABASE_URL ?? "",
        supabaseAnonKey: env.SUPABASE_ANON_KEY ?? "",
        supabaseOauthProviders: env.SUPABASE_OAUTH_PROVIDERS.split(",").map((provider) => provider.trim()).filter(Boolean),
        trackedBeers: publicConfig.trackedBeers,
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
    } catch (error) {
      next(error);
    }
  });

  app.use("/api/business", createLazyMount((routers) => routers.businessRouter));
  app.use("/api/admin", createLazyMount((routers) => routers.adminRouter));
  app.get("/for-bars", (_req, res) => {
    res.redirect(302, "/venue-portal");
  });
  app.get("/for-bars.html", (_req, res) => {
    res.redirect(302, "/venue-portal");
  });
  app.get("/venues/:venueId", async (req, res, next) => {
    try {
      const { businessService } = await getLazyRouters();
      const venue = await businessService.getPublicVenueById(req.params.venueId);
      res
        .type("html")
        .setHeader("Cache-Control", env.NODE_ENV === "production" ? "public, max-age=300" : "no-store")
        .send(renderPublicVenuePage(venue));
    } catch (error) {
      next(error);
    }
  });
  app.get("/auth/callback", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(viewerDirectory, "auth", "callback.html"));
  });
  app.get(["/.well-known/security.txt", "/security.txt"], (_req, res) => {
    res
      .type("text/plain; charset=utf-8")
      .setHeader("Cache-Control", env.NODE_ENV === "production" ? "public, max-age=300" : "no-store")
      .sendFile(path.join(viewerDirectory, "security.txt"));
  });
  app.use(express.static(viewerDirectory, {
    setHeaders: setStaticAssetHeaders,
  }));
  app.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(viewerDirectory, "index.html"));
  });
  app.get("/venue-portal", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(viewerDirectory, "venue-portal.html"));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
