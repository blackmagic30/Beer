import crypto from "node:crypto";
import path from "node:path";

import compression from "compression";
import express from "express";
import helmet from "helmet";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { env } from "./config/env.js";
import { PREMIUM_PRICING } from "./config/business-rules.js";
import { AppError } from "./lib/errors.js";
import { getRateLimitIdentity } from "./lib/client-ip.js";
import {
  isCanonicalProductionRuntime,
  resolveAccountDeletionLedgerRuntimeConfig,
} from "./lib/deployment-environment.js";
import { success } from "./lib/http.js";
import { logger } from "./lib/logger.js";
import { redactSecrets } from "./lib/redact.js";
import { getSessionAuthorization } from "./lib/session-cookie.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { createRateLimiter } from "./middleware/rate-limit.js";
import { captureRawBody } from "./middleware/raw-body.js";
import type { BusinessService } from "./modules/business/business.service.js";
import type { VerifiedRestoreRuntimeAttestation } from "./lib/restore-rehearsal.js";

type LazyRouters = {
  adminRouter: RequestHandler;
  businessRouter: RequestHandler;
  businessService: BusinessService;
  getOffsiteBackupLastSuccess: () => string | null;
  shutdown: () => Promise<void>;
};

let lazyRoutersPromise: Promise<LazyRouters> | undefined;
let verifiedRestoreRuntime: VerifiedRestoreRuntimeAttestation | undefined;

export const LARGE_JSON_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
const LARGE_JSON_UPLOAD_PATHS = new Set([
  "/api/business/submissions",
  "/api/admin/captures/menu-photo-ocr",
  "/api/admin/ingestions/queue",
]);
const RESTORE_REHEARSAL_ACCESS_COOKIE = "__Host-pint_path_restore_access";
const RESTORE_REHEARSAL_ACCESS_TTL_SECONDS = 8 * 60 * 60;
const RESTORE_REHEARSAL_ALLOWED_API_READS = new Set([
  "/api/business/config",
  "/api/business/access",
  "/api/business/venues",
  "/api/business/price-records",
]);

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftDigest = crypto.createHash("sha256").update(left).digest();
  const rightDigest = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

type RestoreRehearsalAccessConfig = {
  RESTORE_REHEARSAL_MODE: boolean;
  RESTORE_REHEARSAL_ACCESS_USERNAME?: string | undefined;
  RESTORE_REHEARSAL_ACCESS_PASSWORD?: string | undefined;
};

function getRestoreAccessCookieToken(config: RestoreRehearsalAccessConfig, expiresAtSeconds: number): string {
  const payload = `v1.${expiresAtSeconds}`;
  const signature = crypto
    .createHmac("sha256", config.RESTORE_REHEARSAL_ACCESS_PASSWORD!)
    .update(`pint-path-restore-access:${config.RESTORE_REHEARSAL_ACCESS_USERNAME}:${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function getCookieValue(req: Request, name: string): string | null {
  const cookieHeader = req.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function hasValidRestoreBasicAuthorization(req: Request, config: RestoreRehearsalAccessConfig): boolean {
  const authorization = req.get("authorization");
  if (!authorization?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    return timingSafeStringEqual(decoded.slice(0, separator), config.RESTORE_REHEARSAL_ACCESS_USERNAME!) &&
      timingSafeStringEqual(decoded.slice(separator + 1), config.RESTORE_REHEARSAL_ACCESS_PASSWORD!);
  } catch {
    return false;
  }
}

function hasValidRestoreAccessCookie(req: Request, config: RestoreRehearsalAccessConfig, now = Date.now()): boolean {
  const providedCookie = getCookieValue(req, RESTORE_REHEARSAL_ACCESS_COOKIE);
  if (!providedCookie) return false;
  const match = providedCookie.match(/^v1\.(\d{10})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return false;
  const expiresAtSeconds = Number(match[1]);
  if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds * 1000 <= now) return false;
  const expectedCookie = getRestoreAccessCookieToken(config, expiresAtSeconds);
  return timingSafeStringEqual(providedCookie, expectedCookie);
}

export function createRestoreRehearsalAccessGate(config: RestoreRehearsalAccessConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.RESTORE_REHEARSAL_MODE || ["/health", "/ready"].includes(req.path)) {
      next();
      return;
    }

    if (hasValidRestoreAccessCookie(req, config)) {
      next();
      return;
    }

    if (hasValidRestoreBasicAuthorization(req, config)) {
      const expiresAtSeconds = Math.floor(Date.now() / 1000) + RESTORE_REHEARSAL_ACCESS_TTL_SECONDS;
      const accessCookie = getRestoreAccessCookieToken(config, expiresAtSeconds);
      res.append(
        "Set-Cookie",
        `${RESTORE_REHEARSAL_ACCESS_COOKIE}=${accessCookie}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${RESTORE_REHEARSAL_ACCESS_TTL_SECONDS}`,
      );
      next();
      return;
    }

    res.setHeader("WWW-Authenticate", 'Basic realm="Pint Path restore rehearsal", charset="UTF-8"');
    res.status(401).type("text/plain; charset=utf-8").send("Restore rehearsal access required.");
  };
}

export function isRestoreRehearsalMutationAllowed(method: string, requestPath: string): boolean {
  const normalizedPath = requestPath.toLowerCase();
  if (normalizedPath === "/api" || normalizedPath.startsWith("/api/")) {
    if (requestPath !== "/api" && !requestPath.startsWith("/api/")) {
      return false;
    }
    return method === "GET" && RESTORE_REHEARSAL_ALLOWED_API_READS.has(requestPath);
  }
  return method === "GET" || method === "HEAD";
}

export function getPublicRestoreRuntimeReadiness(verified: boolean) {
  if (!verified) return { status: "not_verified" } as const;
  return {
    status: "verified",
    immutableBindingsVerified: true,
    databaseIntegrityVerified: true,
    evidenceIntegrityVerified: true,
    readOnly: true,
  } as const;
}

function acceptsLargeJsonPayload(req: Request): boolean {
  return ["POST", "PUT", "PATCH"].includes(req.method) && LARGE_JSON_UPLOAD_PATHS.has(req.path);
}

export function shouldRunAutomaticMaintenance(
  nodeEnv = env.NODE_ENV,
  restoreRehearsalMode = env.RESTORE_REHEARSAL_MODE,
): boolean {
  return nodeEnv !== "test" && !restoreRehearsalMode;
}

function hasSyntacticallyValidSession(req: Request): boolean {
  const authorization = getSessionAuthorization(req);
  return Boolean(authorization && /^Bearer\s+\S{20,}$/i.test(authorization));
}

function deploymentMetadata() {
  const rawCommit = process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";
  const rawVersion = process.env.PINT_PATH_VERSION ?? process.env.npm_package_version ?? "0.1.0";
  return {
    version: /^[a-z0-9._-]{1,80}$/i.test(rawVersion) ? rawVersion : "unknown",
    commitSha: /^[a-f0-9]{7,64}$/i.test(rawCommit) ? rawCommit : "unknown",
    environment: env.NODE_ENV,
  };
}

async function buildLazyRouters(): Promise<LazyRouters> {
  console.info("Initializing backend services...");

  if (env.RESTORE_REHEARSAL_MODE) {
    if (env.RESTORE_REHEARSAL_PHASE !== "active") {
      throw new Error("Restore backend services may initialize only in active phase.");
    }
    const { verifyRestoreRuntimeAttestation } = await import("./lib/restore-rehearsal.js");
    verifiedRestoreRuntime = await verifyRestoreRuntimeAttestation({
      restoreRoot: path.dirname(env.DATABASE_PATH),
      expectedAttestationSha256: env.RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256!,
      expectedBackupId: env.RESTORE_REHEARSAL_BACKUP_ID!,
      expectedSourceManifestSha256: env.RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256!,
    });
    if (
      verifiedRestoreRuntime.databasePath !== env.DATABASE_PATH ||
      verifiedRestoreRuntime.evidencePath !== env.SOURCE_EVIDENCE_STORAGE_DIR
    ) {
      throw new Error("Verified restore runtime paths do not match the configured active paths.");
    }
  }

  const [
    { createDatabase, openReadOnlyDatabase },
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

  const database = env.RESTORE_REHEARSAL_MODE
    ? openReadOnlyDatabase()
    : createDatabase();
  const adminIngestionQueueRepository = env.RESTORE_REHEARSAL_MODE
    ? undefined
    : new AdminIngestionQueueRepository(database);
  const beerCatalogRepository = new BeerCatalogRepository(database);
  const businessRepository = new BusinessRepository(database);
  const adminService = new AdminService(
    adminIngestionQueueRepository,
    env.RESTORE_REHEARSAL_MODE ? undefined : env.SUPABASE_URL,
    env.RESTORE_REHEARSAL_MODE ? undefined : env.SUPABASE_SERVICE_ROLE_KEY,
    env.SUPABASE_MENU_CAPTURE_TABLE,
    env.RESTORE_REHEARSAL_MODE ? undefined : env.OPENAI_API_KEY,
    env.RESTORE_REHEARSAL_MODE ? undefined : env.GOOGLE_PLACES_API_KEY ?? env.GOOGLE_MAPS_API_KEY,
    env.RESTORE_REHEARSAL_MODE ? undefined : database,
  );
  const canonicalProductionRuntime = isCanonicalProductionRuntime({
    nodeEnv: env.NODE_ENV,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
  });
  const businessRuntimeEnv = env.RESTORE_REHEARSAL_MODE
    ? {
        ...env,
        GOOGLE_MAPS_API_KEY: undefined,
        GOOGLE_PLACES_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        REPORT_DELIVERY_SCHEDULE_ENABLED: false,
      }
    : canonicalProductionRuntime
      ? env
      : { ...env, REPORT_DELIVERY_SCHEDULE_ENABLED: false };
  const deletionLedgerRuntimeConfig = resolveAccountDeletionLedgerRuntimeConfig({
    nodeEnv: env.NODE_ENV,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
    sourceSupabaseUrl: env.SUPABASE_URL,
    destinationSupabaseUrl: env.OFFSITE_BACKUP_SUPABASE_URL,
    destinationServiceRoleKey: env.OFFSITE_BACKUP_SERVICE_ROLE_KEY,
    bucketName: env.OFFSITE_BACKUP_BUCKET,
  });
  const deletionTombstoneWriter = deletionLedgerRuntimeConfig
    ? async (tombstone: { requestId: string; userId: string; completedAt: string }) => {
        const { appendAccountDeletionTombstone } = await import("./lib/offsite-backup.js");
        await appendAccountDeletionTombstone({
          sourceSupabaseUrl: deletionLedgerRuntimeConfig.sourceSupabaseUrl,
          destinationSupabaseUrl: deletionLedgerRuntimeConfig.destinationSupabaseUrl,
          destinationServiceRoleKey: deletionLedgerRuntimeConfig.destinationServiceRoleKey,
          bucketName: deletionLedgerRuntimeConfig.bucketName,
        }, tombstone);
      }
    : undefined;
  const businessService = new BusinessService(
    businessRepository,
    businessRuntimeEnv,
    beerCatalogRepository,
    env.RESTORE_REHEARSAL_MODE ? undefined : { extract: (input) => adminService.ocrMenuPhotos(input) },
    undefined,
    deletionTombstoneWriter,
  );
  const schedulerStops: Array<() => Promise<void>> = [];
  const schedulerOwner = `${process.pid}:${crypto.randomUUID()}`;
  const backgroundTasks = new Set<Promise<unknown>>();
  const trackBackgroundTask = (task: Promise<unknown>) => {
    backgroundTasks.add(task);
    void task.finally(() => backgroundTasks.delete(task));
  };
  businessService.logStartupSummary();
  const recordOperationalState = (key: string, value: Record<string, unknown>) => {
    const recordedAt = new Date().toISOString();
    businessRepository.setSystemState(`job:${key}`, { ...value, recordedAt }, recordedAt);
  };
  const runEvidenceRetention = async () => {
    const now = new Date();
    const leaseKey = "lease:evidence_retention";
    const acquired = businessRepository.acquireSystemLease({
      key: leaseKey,
      owner: schedulerOwner,
      now: now.toISOString(),
      leaseUntil: new Date(now.getTime() + 55 * 60 * 1000).toISOString(),
    });
    if (!acquired) return { skipped: true, reason: "lease_held_by_another_instance" };
    try {
      const evidence = await businessService.purgeExpiredSourceEvidence(100);
      const ingestionImages = adminService.purgeQueuedIngestionImages(now.toISOString());
      const privacyRetention = businessService.runPrivacyRetention();
      return { ...evidence, ingestionImages, privacyRetention };
    } finally {
      businessRepository.releaseSystemLease({ key: leaseKey, owner: schedulerOwner, now: new Date().toISOString() });
    }
  };
  if (env.NODE_ENV === "test") {
    trackBackgroundTask(runEvidenceRetention().then((result) => {
      recordOperationalState("evidence_retention", {
        state: "succeeded",
        trigger: "startup",
        completedAt: new Date().toISOString(),
        ...result,
      });
    }).catch((error) => {
      recordOperationalState("evidence_retention", {
        state: "failed",
        trigger: "startup",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? redactSecrets(error.message).slice(0, 300) : "Evidence retention failed",
      });
    }));
  }
  if (shouldRunAutomaticMaintenance()) {
    const { scheduleMissionMaintenance } = await import("./lib/mission-maintenance.js");
    const evidenceScheduler = scheduleMissionMaintenance({
      run: runEvidenceRetention,
      intervalMinutes: 60,
      onStatus: (status) => recordOperationalState("evidence_retention", status.state === "succeeded"
        ? { ...status, ...status.result }
        : status),
    });
    schedulerStops.push(evidenceScheduler.stop);
    const scheduler = scheduleMissionMaintenance({
      run: async () => {
        const now = new Date();
        const leaseKey = "lease:mission_maintenance";
        const acquired = businessRepository.acquireSystemLease({
          key: leaseKey,
          owner: schedulerOwner,
          now: now.toISOString(),
          leaseUntil: new Date(now.getTime() + 25 * 60 * 1000).toISOString(),
        });
        if (!acquired) return { skipped: true, reason: "lease_held_by_another_instance" };
        try {
          return businessService.runMissionMaintenance();
        } finally {
          businessRepository.releaseSystemLease({ key: leaseKey, owner: schedulerOwner, now: new Date().toISOString() });
        }
      },
      intervalMinutes: 30,
      onStatus: (status) => recordOperationalState("mission_maintenance", { ...status }),
    });
    schedulerStops.push(scheduler.stop);
  }
  if (
    canonicalProductionRuntime &&
    env.SUPABASE_URL &&
    env.SUPABASE_SERVICE_ROLE_KEY &&
    env.OFFSITE_BACKUP_SUPABASE_URL &&
    env.OFFSITE_BACKUP_SERVICE_ROLE_KEY
  ) {
    const { scheduleOffsiteBackups } = await import("./lib/offsite-backup.js");
    const scheduler = scheduleOffsiteBackups({
      databasePath: env.DATABASE_PATH,
      evidencePath: env.SOURCE_EVIDENCE_STORAGE_DIR,
      sourceSupabaseUrl: env.SUPABASE_URL,
      sourceServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      destinationSupabaseUrl: env.OFFSITE_BACKUP_SUPABASE_URL,
      destinationServiceRoleKey: env.OFFSITE_BACKUP_SERVICE_ROLE_KEY,
      bucketName: env.OFFSITE_BACKUP_BUCKET,
      intervalHours: env.OFFSITE_BACKUP_INTERVAL_HOURS,
      retentionDays: env.OFFSITE_BACKUP_RETENTION_DAYS,
      acquireLease: () => {
        const now = new Date();
        return businessRepository.acquireSystemLease({
          key: "lease:offsite_backup",
          owner: schedulerOwner,
          now: now.toISOString(),
          leaseUntil: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        });
      },
      releaseLease: () => {
        businessRepository.releaseSystemLease({
          key: "lease:offsite_backup",
          owner: schedulerOwner,
          now: new Date().toISOString(),
        });
      },
      onStatus: (status) => {
        recordOperationalState("offsite_backup", status);
        if (status.state === "succeeded") recordOperationalState("offsite_backup_success", status);
      },
    });
    schedulerStops.push(scheduler.stop);
  }
  if (canonicalProductionRuntime && env.REPORT_DELIVERY_SCHEDULE_ENABLED) {
    const {
      createResendReportEmailProvider,
      scheduleMonthlyReportDelivery,
    } = await import("./lib/monthly-report-delivery.js");
    if (env.REPORT_EMAIL_MODE !== "resend" || !env.RESEND_API_KEY || !env.REPORT_EMAIL_FROM) {
      throw new Error("Monthly report scheduling requires Resend delivery configuration.");
    }
    const scheduler = scheduleMonthlyReportDelivery({
      generator: businessService,
      repository: businessRepository,
      provider: createResendReportEmailProvider({ apiKey: env.RESEND_API_KEY }),
      publicBaseUrl: env.PUBLIC_BASE_URL,
      from: env.REPORT_EMAIL_FROM,
      ...(env.REPORT_EMAIL_REPLY_TO ? { replyTo: env.REPORT_EMAIL_REPLY_TO } : {}),
      timezone: env.REPORT_TIMEZONE,
      scheduleDay: env.REPORT_DELIVERY_DAY,
      scheduleHour: env.REPORT_DELIVERY_HOUR,
      checkIntervalMinutes: env.REPORT_DELIVERY_CHECK_INTERVAL_MINUTES,
      onStatus: (status) => recordOperationalState("monthly_report_delivery", status),
    });
    schedulerStops.push(scheduler.stop);
  }

  console.info("Backend services initialized.");

  return {
    adminRouter: createAdminRouter(adminService, businessService),
    businessRouter: createBusinessRouter(businessService),
    businessService,
    getOffsiteBackupLastSuccess: () => {
      const state = businessRepository.getSystemState<{ completedAt?: unknown }>("job:offsite_backup_success");
      return typeof state?.value.completedAt === "string" ? state.value.completedAt : null;
    },
    shutdown: async () => {
      await Promise.allSettled(schedulerStops.splice(0).map((stop) => stop()));
      if (backgroundTasks.size > 0) {
        await Promise.allSettled([...backgroundTasks]);
      }
      const { shutdownRateLimitRedis } = await import("./middleware/rate-limit.js");
      await shutdownRateLimitRedis();
      database.close();
    },
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

export function getStaticAssetCacheControl(
  filePath: string,
  nodeEnv = env.NODE_ENV,
  restoreRehearsalMode = env.RESTORE_REHEARSAL_MODE,
): string {
  if (nodeEnv !== "production" || restoreRehearsalMode) {
    return "no-store";
  }

  const extension = path.extname(filePath).toLowerCase();
  const normalizedPath = filePath.replaceAll(path.sep, "/");

  if (extension === ".html") {
    return "no-store";
  }

  if ([".js", ".css"].includes(extension)) {
    // These files are deliberately unversioned in viewer HTML. Revalidate on
    // every navigation so a deploy cannot pair new markup with hour-stale code.
    return "public, max-age=0, must-revalidate";
  }

  if ([".txt", ".xml", ".webmanifest"].includes(extension)) {
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

function renderPublicVenuePage(
  venue: Awaited<ReturnType<BusinessService["getPublicVenueById"]>>,
  nonce: string,
): string {
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
  <script nonce="${escapeHtml(nonce)}" type="application/ld+json">${safeJsonForHtml(structuredData)}</script>
  <style nonce="${escapeHtml(nonce)}">
    :root { color-scheme: dark; --bg:#070a12; --panel:#121a2c; --text:#f8fafc; --muted:#cbd5e1; --cyan:#22d3ee; --gold:#f5c542; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 18% 0%, rgba(34,211,238,.14), transparent 30%), radial-gradient(circle at 90% 10%, rgba(139,92,246,.16), transparent 28%), var(--bg); color: var(--text); font-family: "Avenir Next", "Segoe UI", sans-serif; }
    main { width: min(920px, 100%); display: grid; gap: 18px; }
    .skip { position: fixed; top: 10px; left: 10px; z-index: 2; transform: translateY(-180%); background: #f8fafc; color: #06101f; }
    .skip:focus { transform: translateY(0); }
    .siteNav, .siteFooter, .footerLinks, .footerIdentity { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 18px; }
    .siteNav { border: 1px solid rgba(255,255,255,.1); border-radius: 22px; background: rgba(7,10,18,.74); padding: 10px 12px; }
    .brand { font-size: 18px; letter-spacing: -.02em; }
    .navLinks, .footerLinks { display: flex; flex-wrap: wrap; gap: 6px; }
    .siteNav a, .siteFooter a { min-height: 44px; padding: 10px 12px; }
    .panel { border: 1px solid rgba(255,255,255,.12); border-radius: 26px; background: linear-gradient(145deg, rgba(255,255,255,.08), rgba(255,255,255,.025)), rgba(18,26,44,.88); box-shadow: 0 28px 76px rgba(0,0,0,.42); padding: clamp(22px, 4vw, 42px); }
    .eyebrow { color: var(--cyan); font-size: 12px; font-weight: 950; letter-spacing: .13em; text-transform: uppercase; }
    h1 { margin: 10px 0 12px; font-size: clamp(36px, 7vw, 72px); line-height: 1; letter-spacing: -.04em; }
    p { color: var(--muted); font-size: 17px; line-height: 1.6; margin: 0; }
    .meta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
    .pill { border: 1px solid rgba(255,255,255,.12); border-radius: 999px; background: rgba(255,255,255,.07); padding: 8px 12px; color: #e2e8f0; font-size: 13px; font-weight: 850; }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 28px; }
    a { min-height: 46px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; padding: 12px 16px; color: var(--text); text-decoration: none; font-weight: 950; }
    a:focus-visible { outline: 3px solid rgba(56,189,248,.82); outline-offset: 3px; }
    .primary { color: #06101f; background: linear-gradient(135deg, #38bdf8, #22d3ee, #9b76f9); }
    .secondary { border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); }
    .note { font-size: 13px; color: #94a3b8; }
    .siteFooter { border-top: 1px solid rgba(255,255,255,.1); padding-top: 12px; }
    @media (max-width: 640px) {
      body { padding: 12px; }
      .siteNav, .siteFooter { align-items: stretch; }
      .navLinks, .footerLinks { width: 100%; overflow-x: auto; flex-wrap: nowrap; }
      .actions { display: grid; }
    }
  </style>
</head>
<body>
  <a class="skip" href="#mainContent">Skip to venue details</a>
  <main>
    <nav class="siteNav" aria-label="Primary">
      <a class="brand" href="/" aria-label="Pint Path home">Pint Path</a>
      <div class="navLinks">
        <a href="/">Map</a>
        <a href="/pricing.html">Pricing</a>
        <a href="/trust.html">FAQ</a>
        <a href="/account.html">Account</a>
        <a href="/feedback.html">Contact us</a>
      </div>
    </nav>
    <section id="mainContent" class="panel" tabindex="-1">
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
    <footer class="siteFooter" role="contentinfo" aria-label="Legal, privacy, and help">
      <div class="footerLinks">
        <a href="/terms.html">Terms</a>
        <a href="/privacy.html">Privacy</a>
        <a href="/security.html">Security</a>
        <a href="/status.html">Service status</a>
      </div>
      <div class="footerIdentity">
        <span>Pint Path · ABN 80 319 578 329</span>
        <a href="mailto:admin@pintpath.au">admin@pintpath.au</a>
        <a href="/feedback.html">Get help</a>
      </div>
    </footer>
  </main>
</body>
</html>`;
}

async function getLazyRouters(): Promise<LazyRouters> {
  if (env.RESTORE_REHEARSAL_MODE && env.RESTORE_REHEARSAL_PHASE === "bootstrap") {
    throw new AppError("Restore rehearsal is in bootstrap phase; application data routes are unavailable.", 503);
  }
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

export async function initializeAppServices(): Promise<void> {
  if (env.RESTORE_REHEARSAL_MODE && env.RESTORE_REHEARSAL_PHASE === "bootstrap") {
    logger.info("Restore rehearsal bootstrap phase ready; backend services and restored database remain unopened.");
    return;
  }
  await getLazyRouters();
}

export async function shutdownAppServices(): Promise<void> {
  const active = lazyRoutersPromise;
  lazyRoutersPromise = undefined;
  verifiedRestoreRuntime = undefined;
  if (!active) return;
  const routers = await active.catch(() => null);
  await routers?.shutdown();
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
  const restoreAccessAttemptLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 20,
    keyPrefix: "restore:access-attempt",
    keyGenerator: getRateLimitIdentity,
  });
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

  app.set("trust proxy", env.TRUST_PROXY_HOPS);
  app.set("case sensitive routing", true);
  app.use((_req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(18).toString("base64");
    next();
  });
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      xFrameOptions: { action: "deny" },
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "base-uri": ["'self'"],
          "object-src": ["'none'"],
          "frame-ancestors": ["'none'"],
          "form-action": ["'self'", "https://checkout.stripe.com"],
          "script-src": [
            "'self'",
            (_req, res) => `'nonce-${String((res as Response).locals.cspNonce)}'`,
            "https://maps.googleapis.com",
            "https://maps.gstatic.com",
            "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.103.0/dist/umd/supabase.min.js",
            "https://cdn.jsdelivr.net/npm/@googlemaps/markerclusterer@2.6.2/dist/index.min.js",
          ],
          "script-src-elem": [
            "'self'",
            (_req, res) => `'nonce-${String((res as Response).locals.cspNonce)}'`,
            "https://maps.googleapis.com",
            "https://maps.gstatic.com",
            "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.103.0/dist/umd/supabase.min.js",
            "https://cdn.jsdelivr.net/npm/@googlemaps/markerclusterer@2.6.2/dist/index.min.js",
          ],
          "script-src-attr": ["'none'"],
          "style-src": ["'self'", (_req, res) => `'nonce-${String((res as Response).locals.cspNonce)}'`, "https://fonts.googleapis.com"],
          "style-src-attr": ["'unsafe-inline'"],
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
  app.use(compression({
    threshold: 1024,
    filter: (req, res) => !req.path.startsWith("/api/") && compression.filter(req, res),
  }));
  app.use((_req, res, next) => {
    res.setHeader(
      "Permissions-Policy",
      env.RESTORE_REHEARSAL_MODE
        ? "camera=(), geolocation=(self), microphone=(), payment=()"
        : "camera=(self), geolocation=(self), microphone=(), payment=(self)",
    );
    if (env.RESTORE_REHEARSAL_MODE) {
      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });
  app.use((req, _res, next) => {
    if (
      !env.RESTORE_REHEARSAL_MODE ||
      env.RESTORE_REHEARSAL_PHASE !== "bootstrap" ||
      ["/health", "/ready"].includes(req.path)
    ) {
      next();
      return;
    }
    next(new AppError("Restore rehearsal bootstrap is ready for verified file transfer; application routes are offline.", 503));
  });
  app.use((req, res, next) => {
    if (
      !env.RESTORE_REHEARSAL_MODE ||
      ["/health", "/ready"].includes(req.path) ||
      hasValidRestoreAccessCookie(req, env)
    ) {
      next();
      return;
    }
    restoreAccessAttemptLimiter(req, res, next);
  });
  app.use(createRestoreRehearsalAccessGate(env));
  app.use((req, _res, next) => {
    if (
      !env.RESTORE_REHEARSAL_MODE ||
      isRestoreRehearsalMutationAllowed(req.method, req.path)
    ) {
      next();
      return;
    }

    next(new AppError("Writes are disabled during the isolated restore rehearsal.", 503));
  });
  app.use((req, res, next) => {
    const origin = req.get("origin");

    if (origin && isTrustedOrigin(req, origin, allowedOrigins)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Methods",
        env.RESTORE_REHEARSAL_MODE ? "GET" : "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,Stripe-Signature,X-Requested-With,X-Pint-Path-Reauth-Token,X-Pint-Path-Current-Password",
      );
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
  const largePayloadPreparseLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 12,
    keyPrefix: "preparse:large-json",
    keyGenerator: getRateLimitIdentity,
  });
  app.use((req, res, next) => {
    if (!acceptsLargeJsonPayload(req)) {
      next();
      return;
    }

    const rawContentLength = req.get("content-length");
    const contentLength = rawContentLength == null ? null : Number(rawContentLength);
    if (
      contentLength != null &&
      (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > LARGE_JSON_BODY_LIMIT_BYTES)
    ) {
      next(new AppError("Request body is too large.", 413));
      return;
    }

    // Reject anonymous and obviously malformed credentials before buffering a
    // multi-megabyte base64 envelope. Full session and role validation remains
    // in the mounted route after parsing.
    if (!hasSyntacticallyValidSession(req)) {
      next(new AppError("Authentication required.", 401));
      return;
    }

    largePayloadPreparseLimiter(req, res, next);
  });
  const standardJsonParser = express.json({ limit: "1mb", verify: captureRawBody });
  const imageJsonParser = express.json({ limit: LARGE_JSON_BODY_LIMIT_BYTES, verify: captureRawBody });
  app.use((req, res, next) => {
    (acceptsLargeJsonPayload(req) ? imageJsonParser : standardJsonParser)(req, res, next);
  });
  app.use(express.urlencoded({ extended: true, limit: "1mb", verify: captureRawBody }));

  app.get("/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(
      success({
        service: "pint-path",
        status: "ok",
        deployment: deploymentMetadata(),
        ...(env.RESTORE_REHEARSAL_MODE
          ? { restoreRehearsal: { phase: env.RESTORE_REHEARSAL_PHASE } }
          : {}),
      }),
    );
  });

  app.get("/ready", async (_req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      if (env.RESTORE_REHEARSAL_MODE && env.RESTORE_REHEARSAL_PHASE === "bootstrap") {
        const fs = await import("node:fs/promises");
        let volumeReady = false;
        try {
          const [stat, realPath] = await Promise.all([
            fs.lstat("/app/data"),
            fs.realpath("/app/data"),
          ]);
          volumeReady = stat.isDirectory() && !stat.isSymbolicLink() && realPath === "/app/data";
        } catch {
          volumeReady = false;
        }
        res.status(volumeReady ? 200 : 503).json(success({
          service: "pint-path",
          status: volumeReady ? "bootstrap_ready" : "bootstrap_not_ready",
          deployment: deploymentMetadata(),
          restoreRehearsal: {
            phase: "bootstrap",
            backendServicesInitialized: false,
            databaseOpened: false,
            volumeMount: volumeReady ? "verified" : "missing_or_invalid",
          },
        }));
        return;
      }
      const { businessService, getOffsiteBackupLastSuccess } = await getLazyRouters();
      const [readiness, rateLimiterRedis, offsiteBackup] = await Promise.all([
        businessService.getOperationalReadiness(),
        import("./middleware/rate-limit.js").then(({ probeRateLimitRedis }) => probeRateLimitRedis()),
        import("./lib/offsite-backup.js").then(({ probeOffsiteBackupReadiness }) => (
          probeOffsiteBackupReadiness({
            sourceSupabaseUrl: env.SUPABASE_URL,
            destinationSupabaseUrl: env.OFFSITE_BACKUP_SUPABASE_URL,
            destinationServiceRoleKey: env.OFFSITE_BACKUP_SERVICE_ROLE_KEY,
            bucketName: env.OFFSITE_BACKUP_BUCKET,
            lastSuccessfulAt: getOffsiteBackupLastSuccess(),
            maxFreshnessHours: env.OFFSITE_BACKUP_INTERVAL_HOURS + 2,
            required: isCanonicalProductionRuntime({
              nodeEnv: env.NODE_ENV,
              railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
            }),
            // A recent successful scheduled backup is the serving-readiness
            // signal. Privileged write/list/download/delete canaries belong in
            // provider/release checks, not in a public GET or deploy gate.
            probeCapabilities: false,
          })
        )),
      ]);
      const restoreRuntimeReady = !env.RESTORE_REHEARSAL_MODE || Boolean(verifiedRestoreRuntime);
      const ready = readiness.ready && rateLimiterRedis.ready && offsiteBackup.status === "ok" && restoreRuntimeReady;
      if (!ready) {
        const safeDependencyFields = [
          "status",
          "required",
          "ready",
          "liveProbe",
          "error",
          "foreignKeyViolations",
          "lastSuccessfulAt",
          "ageHours",
        ];
        const dependencies = {
          ...readiness.dependencies,
          rateLimiterRedis,
          offsiteBackup,
        };
        logger.warn("Operational readiness check failed", {
          dependencies: Object.fromEntries(Object.entries(dependencies).map(([name, value]) => [
            name,
            Object.fromEntries(safeDependencyFields.flatMap((field) => (
              Object.prototype.hasOwnProperty.call(value, field)
                ? [[field, (value as Record<string, unknown>)[field]]]
                : []
            ))),
          ])),
          restoreRuntimeReady,
        });
      }
      res.status(ready ? 200 : 503).json(
        success({
          service: "pint-path",
          status: ready ? "ready" : "not_ready",
          deployment: deploymentMetadata(),
          dependencies: {
            ...readiness.dependencies,
            rateLimiterRedis,
            offsiteBackup,
            ...(env.RESTORE_REHEARSAL_MODE
              ? {
                  restoreRuntime: getPublicRestoreRuntimeReadiness(Boolean(verifiedRestoreRuntime)),
                }
              : {}),
          },
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
        // Restore rehearsals keep browser authentication fully disconnected.
        // The server-only readiness probe still verifies the dedicated staging project.
        supabaseUrl: env.RESTORE_REHEARSAL_MODE ? "" : env.SUPABASE_URL ?? "",
        supabaseAnonKey: env.RESTORE_REHEARSAL_MODE ? "" : env.SUPABASE_ANON_KEY ?? "",
        supabaseOauthProviders: env.RESTORE_REHEARSAL_MODE
          ? []
          : env.SUPABASE_OAUTH_PROVIDERS.split(",").map((provider) => provider.trim()).filter(Boolean),
        trackedBeers: publicConfig.trackedBeers,
        business: {
          publicBaseUrl: env.PUBLIC_BASE_URL,
          contributorUnlockPoints: env.CONTRIBUTOR_UNLOCK_POINTS,
          contributorUnlockDays: env.CONTRIBUTOR_UNLOCK_DAYS,
          demoBillingMode: env.DEMO_BILLING_MODE,
          fieldTestMode: env.FIELD_TEST_MODE || env.RESTORE_REHEARSAL_MODE,
          restoreRehearsalMode: env.RESTORE_REHEARSAL_MODE,
          legalPolicyVersion: publicConfig.legalPolicyVersion,
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
        .setHeader(
          "Cache-Control",
          env.NODE_ENV === "production" && !env.RESTORE_REHEARSAL_MODE ? "public, max-age=300" : "no-store",
        )
        .send(renderPublicVenuePage(venue, String(res.locals.cspNonce)));
    } catch (error) {
      next(error);
    }
  });
  app.use(async (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      next();
      return;
    }

    const relativePath = req.path === "/"
      ? "index.html"
      : req.path === "/venue-portal"
        ? "venue-portal.html"
        : req.path === "/auth/callback"
          ? "auth/callback.html"
          : req.path.endsWith(".html")
            ? req.path.slice(1)
            : null;
    if (!relativePath) {
      next();
      return;
    }

    const filePath = path.resolve(viewerDirectory, relativePath);
    if (!filePath.startsWith(`${viewerDirectory}${path.sep}`)) {
      next();
      return;
    }

    try {
      const nonce = String(res.locals.cspNonce);
      const html = (await import("node:fs/promises")).readFile(filePath, "utf8");
      const rendered = (await html).replace(
        /<(script|style)(?![^>]*\bnonce=)/gi,
        `<$1 nonce="${escapeHtml(nonce)}"`,
      );
      setStaticAssetHeaders(res, filePath);
      res.type("html").send(req.method === "HEAD" ? "" : rendered);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        next();
        return;
      }
      next(error);
    }
  });
  app.get(["/.well-known/security.txt", "/security.txt"], (_req, res) => {
    res
      .type("text/plain; charset=utf-8")
      .setHeader(
        "Cache-Control",
        env.NODE_ENV === "production" && !env.RESTORE_REHEARSAL_MODE ? "public, max-age=300" : "no-store",
      )
      .sendFile(path.join(viewerDirectory, "security.txt"));
  });
  app.use(express.static(viewerDirectory, {
    index: false,
    setHeaders: setStaticAssetHeaders,
  }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
