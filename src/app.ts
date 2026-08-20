import crypto from "node:crypto";
import { ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";

import compression from "compression";
import express from "express";
import helmet from "helmet";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { env } from "./config/env.js";
import { PREMIUM_PRICING } from "./config/business-rules.js";
import {
  inspectPostgresApplicationPoolMetrics,
  POSTGRES_CONNECTION_BUDGET,
} from "./db/postgres-connection-budget.js";
import { AppError } from "./lib/errors.js";
import { getRateLimitIdentity } from "./lib/client-ip.js";
import {
  resolveCanonicalHostRequest,
  shouldEnforceCanonicalProductionHost,
} from "./lib/canonical-redirect.js";
import {
  isCanonicalProductionRuntime,
  resolveAccountDeletionLedgerRuntimeConfig,
} from "./lib/deployment-environment.js";
import { railwayDeploymentIdentityHashes } from "./lib/railway-deployment-identity.js";
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
  probeOffsiteBackupReadiness: () => Promise<{
    status: "ok" | "failed" | "required_unconfigured";
    required: boolean;
    liveProbe: boolean;
    lastSuccessfulAt: string | null;
    ageHours: number | null;
    error?: string | undefined;
  }>;
  shutdown: () => Promise<void>;
};

let lazyRoutersPromise: Promise<LazyRouters> | undefined;
let initializingServicesCleanup: (() => Promise<void>) | undefined;
let verifiedRestoreRuntime: VerifiedRestoreRuntimeAttestation | undefined;

export const LARGE_JSON_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
const FORM_FALLBACK_MAX_DECLARED_BODY_BYTES = 64 * 1024;
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
const TIMING_SAFE_COMPARISON_MAX_BYTES = 1024;
const APP_ARRAY_IS_ARRAY = Array.isArray;
const APP_BUFFER_CONSTRUCTOR = Buffer;
const APP_BUFFER_BYTE_LENGTH = APP_BUFFER_CONSTRUCTOR.byteLength;
const APP_JSON_OBJECT = JSON;
const APP_JSON_STRINGIFY = APP_JSON_OBJECT.stringify;
const APP_NUMBER_CONSTRUCTOR = Number;
const APP_NUMBER_IS_FINITE = APP_NUMBER_CONSTRUCTOR.isFinite;
const APP_OBJECT_CONSTRUCTOR = Object;
const APP_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  APP_OBJECT_CONSTRUCTOR.getOwnPropertyDescriptor;
const APP_OBJECT_GET_PROTOTYPE_OF = APP_OBJECT_CONSTRUCTOR.getPrototypeOf;
const APP_OBJECT_HAS_OWN = APP_OBJECT_CONSTRUCTOR.hasOwn;
const APP_OBJECT_KEYS = APP_OBJECT_CONSTRUCTOR.keys;
const APP_OBJECT_PROTOTYPE = APP_OBJECT_CONSTRUCTOR.prototype;
const APP_REFLECT_OBJECT = Reflect;
const APP_REFLECT_APPLY = APP_REFLECT_OBJECT.apply;
const APP_REFLECT_DEFINE_PROPERTY = APP_REFLECT_OBJECT.defineProperty;
const APP_REGEXP_EXEC = RegExp.prototype.exec;
const APP_RESPONSE_END = ServerResponse.prototype.end;
const APP_RESPONSE_SET_HEADER = ServerResponse.prototype.setHeader;
const APP_SET_CONSTRUCTOR = Set;
const APP_SET_ADD = APP_SET_CONSTRUCTOR.prototype.add;
const APP_SET_DELETE = APP_SET_CONSTRUCTOR.prototype.delete;
const APP_SET_HAS = APP_SET_CONSTRUCTOR.prototype.has;
const APP_PROCESS_ENV = process.env;
const APP_UTIL_IS_PROXY = utilTypes.isProxy;
const APP_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/i;
const APP_VERSION_PATTERN = /^[a-z0-9._-]{1,80}$/i;
const APP_PROBE_MAX_JSON_BYTES = 1_048_576;
const APP_PROBE_MAX_JSON_DEPTH = 32;
const APP_PROBE_MAX_JSON_NODES = 20_000;

function ownProcessEnvironmentString(name: string): string | undefined {
  if (APP_REFLECT_APPLY(APP_UTIL_IS_PROXY, utilTypes, [APP_PROCESS_ENV]) === true) {
    return undefined;
  }
  const descriptor = APP_REFLECT_APPLY(
    APP_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    APP_OBJECT_CONSTRUCTOR,
    [APP_PROCESS_ENV, name],
  ) as PropertyDescriptor | undefined;
  if (
    descriptor === undefined
    || descriptor.enumerable !== true
    || APP_REFLECT_APPLY(
      APP_OBJECT_HAS_OWN,
      APP_OBJECT_CONSTRUCTOR,
      [descriptor, "value"],
    )
      !== true
    || typeof descriptor.value !== "string"
  ) return undefined;
  return descriptor.value;
}

function secureProbeJson(value: unknown): string {
  const ancestors = new APP_SET_CONSTRUCTOR<object>();
  let nodes = 0;

  const encode = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > APP_PROBE_MAX_JSON_NODES || depth > APP_PROBE_MAX_JSON_DEPTH) {
      throw new Error("probe_json_invalid");
    }
    if (candidate === null) return "null";
    if (typeof candidate === "string") {
      const encoded = APP_REFLECT_APPLY(
        APP_JSON_STRINGIFY,
        APP_JSON_OBJECT,
        [candidate],
      ) as unknown;
      if (typeof encoded !== "string") throw new Error("probe_json_invalid");
      return encoded;
    }
    if (typeof candidate === "boolean") return candidate ? "true" : "false";
    if (typeof candidate === "number") {
      if (APP_REFLECT_APPLY(
        APP_NUMBER_IS_FINITE,
        APP_NUMBER_CONSTRUCTOR,
        [candidate],
      ) !== true) return "null";
      const encoded = APP_REFLECT_APPLY(
        APP_JSON_STRINGIFY,
        APP_JSON_OBJECT,
        [candidate],
      ) as unknown;
      if (typeof encoded !== "string") throw new Error("probe_json_invalid");
      return encoded;
    }
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error("probe_json_invalid");
    }
    if (APP_REFLECT_APPLY(APP_UTIL_IS_PROXY, utilTypes, [candidate]) === true) {
      throw new Error("probe_json_invalid");
    }
    if (APP_REFLECT_APPLY(APP_SET_HAS, ancestors, [candidate]) === true) {
      throw new Error("probe_json_invalid");
    }
    APP_REFLECT_APPLY(APP_SET_ADD, ancestors, [candidate]);
    try {
      if (APP_ARRAY_IS_ARRAY(candidate)) {
        let result = "[";
        for (let index = 0; index < candidate.length; index += 1) {
          if (index > 0) result += ",";
          const descriptor = APP_REFLECT_APPLY(
            APP_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
            APP_OBJECT_CONSTRUCTOR,
            [candidate, `${index}`],
          ) as PropertyDescriptor | undefined;
          if (
            descriptor === undefined
            || descriptor.enumerable !== true
            || APP_REFLECT_APPLY(
              APP_OBJECT_HAS_OWN,
              APP_OBJECT_CONSTRUCTOR,
              [descriptor, "value"],
            ) !== true
          ) throw new Error("probe_json_invalid");
          result += encode(descriptor.value, depth + 1);
        }
        return `${result}]`;
      }
      const prototype = APP_REFLECT_APPLY(
        APP_OBJECT_GET_PROTOTYPE_OF,
        APP_OBJECT_CONSTRUCTOR,
        [candidate],
      );
      if (prototype !== APP_OBJECT_PROTOTYPE && prototype !== null) {
        throw new Error("probe_json_invalid");
      }
      const keys = APP_REFLECT_APPLY(
        APP_OBJECT_KEYS,
        APP_OBJECT_CONSTRUCTOR,
        [candidate],
      ) as string[];
      let result = "{";
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        if (typeof key !== "string") throw new Error("probe_json_invalid");
        const descriptor = APP_REFLECT_APPLY(
          APP_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
          APP_OBJECT_CONSTRUCTOR,
          [candidate, key],
        ) as PropertyDescriptor | undefined;
        if (
          descriptor === undefined
          || descriptor.enumerable !== true
          || APP_REFLECT_APPLY(
            APP_OBJECT_HAS_OWN,
            APP_OBJECT_CONSTRUCTOR,
            [descriptor, "value"],
          ) !== true
        ) throw new Error("probe_json_invalid");
        if (index > 0) result += ",";
        result += `${encode(key, depth + 1)}:${encode(descriptor.value, depth + 1)}`;
      }
      return `${result}}`;
    } finally {
      APP_REFLECT_APPLY(APP_SET_DELETE, ancestors, [candidate]);
    }
  };

  const result = encode(value, 0);
  const byteLength = APP_REFLECT_APPLY(
    APP_BUFFER_BYTE_LENGTH,
    APP_BUFFER_CONSTRUCTOR,
    [result, "utf8"],
  ) as number;
  if (byteLength < 1 || byteLength > APP_PROBE_MAX_JSON_BYTES) {
    throw new Error("probe_json_invalid");
  }
  return result;
}

function sendSecureProbeJson(
  response: Response,
  statusCode: number,
  value: unknown,
): void {
  const body = secureProbeJson(value);
  const byteLength = APP_REFLECT_APPLY(
    APP_BUFFER_BYTE_LENGTH,
    APP_BUFFER_CONSTRUCTOR,
    [body, "utf8"],
  ) as number;
  const statusDefined = APP_REFLECT_APPLY(
    APP_REFLECT_DEFINE_PROPERTY,
    APP_REFLECT_OBJECT,
    [response, "statusCode", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: statusCode,
    }],
  );
  if (statusDefined !== true || response.statusCode !== statusCode) {
    throw new Error("probe_response_invalid");
  }
  APP_REFLECT_APPLY(APP_RESPONSE_SET_HEADER, response, [
    "Cache-Control",
    "no-store",
  ]);
  APP_REFLECT_APPLY(APP_RESPONSE_SET_HEADER, response, [
    "Content-Type",
    "application/json; charset=utf-8",
  ]);
  APP_REFLECT_APPLY(APP_RESPONSE_SET_HEADER, response, [
    "Content-Length",
    `${byteLength}`,
  ]);
  const endDescriptor = APP_REFLECT_APPLY(
    APP_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    APP_OBJECT_CONSTRUCTOR,
    [response, "end"],
  ) as PropertyDescriptor | undefined;
  const end = endDescriptor !== undefined
    && APP_REFLECT_APPLY(
      APP_OBJECT_HAS_OWN,
      APP_OBJECT_CONSTRUCTOR,
      [endDescriptor, "value"],
    ) === true
    && typeof endDescriptor.value === "function"
    ? endDescriptor.value as typeof APP_RESPONSE_END
    : APP_RESPONSE_END;
  APP_REFLECT_APPLY(end, response, [body]);
}

function createReadinessProbeSingleFlight<T>(): (
  load: () => Promise<T>,
) => Promise<T> {
  let active: Promise<T> | undefined;
  let activeMarker: object | undefined;
  return (load) => {
    if (active) return active;

    const marker = {};
    const operation = (async () => {
      // Publish the shared promise before a synchronously throwing loader can
      // enter the cleanup path.
      await 0;
      try {
        return await load();
      } finally {
        if (activeMarker === marker) {
          active = undefined;
          activeMarker = undefined;
        }
      }
    })();
    activeMarker = marker;
    active = operation;
    return operation;
  };
}

async function awaitReadinessDependencies<A, B, C>(
  operational: Promise<A>,
  redis: Promise<B>,
  offsite: Promise<C>,
): Promise<readonly [A, B, C]> {
  const [operationalResult, redisResult, offsiteResult] = await Promise.allSettled([
    operational,
    redis,
    offsite,
  ]);
  if (operationalResult.status === "rejected") throw operationalResult.reason;
  if (redisResult.status === "rejected") throw redisResult.reason;
  if (offsiteResult.status === "rejected") throw offsiteResult.reason;
  return [operationalResult.value, redisResult.value, offsiteResult.value];
}

type OffsiteBackupReadiness = Awaited<
  ReturnType<LazyRouters["probeOffsiteBackupReadiness"]>
>;

async function resolveOffsiteBackupReadinessForRuntime(
  canonicalProductionRuntime: boolean,
  probeProductionBoundary: () => Promise<OffsiteBackupReadiness>,
): Promise<OffsiteBackupReadiness> {
  if (!canonicalProductionRuntime) {
    return {
      status: "ok",
      required: false,
      liveProbe: false,
      lastSuccessfulAt: null,
      ageHours: null,
    };
  }
  return probeProductionBoundary();
}

export const appDeploymentMetadataInternals = APP_OBJECT_CONSTRUCTOR.freeze({
  awaitReadinessDependencies,
  createReadinessProbeSingleFlight,
  resolveOffsiteBackupReadinessForRuntime,
  secureProbeJson,
});

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const leftPadded = Buffer.alloc(TIMING_SAFE_COMPARISON_MAX_BYTES);
  const rightPadded = Buffer.alloc(TIMING_SAFE_COMPARISON_MAX_BYTES);
  leftBytes.copy(leftPadded, 0, 0, TIMING_SAFE_COMPARISON_MAX_BYTES);
  rightBytes.copy(rightPadded, 0, 0, TIMING_SAFE_COMPARISON_MAX_BYTES);
  const equalContents = crypto.timingSafeEqual(leftPadded, rightPadded);
  return leftBytes.length <= TIMING_SAFE_COMPARISON_MAX_BYTES &&
    rightBytes.length <= TIMING_SAFE_COMPARISON_MAX_BYTES &&
    leftBytes.length === rightBytes.length &&
    equalContents;
}

type RestoreRehearsalAccessConfig = {
  RESTORE_REHEARSAL_MODE: boolean;
  RESTORE_REHEARSAL_ACCESS_USERNAME?: string | undefined;
  RESTORE_REHEARSAL_ACCESS_PASSWORD?: string | undefined;
};

function getRestoreAccessCookieToken(config: RestoreRehearsalAccessConfig, expiresAtSeconds: number): string {
  const payload = `v1.${expiresAtSeconds}`;
  const signingKey = crypto.hkdfSync(
    "sha256",
    Buffer.from(config.RESTORE_REHEARSAL_ACCESS_PASSWORD!, "utf8"),
    Buffer.from(`pint-path:restore-access:${config.RESTORE_REHEARSAL_ACCESS_USERNAME}`, "utf8"),
    Buffer.from("pint-path:restore-access-cookie:v1", "utf8"),
    32,
  );
  const signature = crypto
    .createHmac("sha256", Buffer.from(signingKey))
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

const POSTGRES_RECOVERY_ALLOWED_MUTATIONS = new Set([
  "/api/business/auth/supabase-session",
  "/api/business/auth/logout",
]);

export function isPostgresRecoveryRehearsalMutationAllowed(
  method: string,
  requestPath: string,
): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  return method === "POST" && POSTGRES_RECOVERY_ALLOWED_MUTATIONS.has(requestPath);
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

function postgresRecoveryRehearsalMetadata() {
  if (!env.POSTGRES_RECOVERY_REHEARSAL_MODE) return {};
  return {
    postgresRecoveryRehearsal: {
      enabled: true,
      candidateSha: env.POSTGRES_RECOVERY_CANDIDATE_SHA,
      loopbackOnly: true,
      postgresRuntime: true,
      automaticMaintenanceEnabled: false,
      externalWritesAllowed: false,
      providerSchedulersEnabled: false,
    },
  } as const;
}

function acceptsLargeJsonPayload(req: Request): boolean {
  return ["POST", "PUT", "PATCH"].includes(req.method) && LARGE_JSON_UPLOAD_PATHS.has(req.path);
}

export function shouldRunAutomaticMaintenance(
  nodeEnv = env.NODE_ENV,
  restoreRehearsalMode = env.RESTORE_REHEARSAL_MODE,
  postgresRecoveryRehearsalMode = env.POSTGRES_RECOVERY_REHEARSAL_MODE,
  automaticMaintenanceEnabled = env.PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED,
  configuredCandidateSha = env.PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA,
  deployedCandidateSha = ownProcessEnvironmentString("RAILWAY_GIT_COMMIT_SHA"),
): boolean {
  const candidateBound = nodeEnv !== "production" || (
    typeof configuredCandidateSha === "string"
    && APP_REFLECT_APPLY(APP_REGEXP_EXEC, APP_COMMIT_PATTERN, [configuredCandidateSha])
      !== null
    && configuredCandidateSha === deployedCandidateSha
  );
  return automaticMaintenanceEnabled
    && candidateBound
    && nodeEnv !== "test"
    && !restoreRehearsalMode
    && !postgresRecoveryRehearsalMode;
}

function automaticMaintenanceMetadata() {
  const configuredCandidateSha = env.PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA;
  const deployedCandidateSha = ownProcessEnvironmentString("RAILWAY_GIT_COMMIT_SHA");
  return {
    automaticMaintenance: {
      enabled: shouldRunAutomaticMaintenance(),
      candidateBound: env.NODE_ENV !== "production" || (
        typeof configuredCandidateSha === "string"
        && APP_REFLECT_APPLY(APP_REGEXP_EXEC, APP_COMMIT_PATTERN, [configuredCandidateSha])
          !== null
        && configuredCandidateSha === deployedCandidateSha
      ),
    },
  } as const;
}

function hasSyntacticallyValidSession(req: Request): boolean {
  const authorization = getSessionAuthorization(req);
  return Boolean(authorization && /^Bearer\s+\S{20,}$/i.test(authorization));
}

export { replicaIdSha256 } from "./lib/railway-deployment-identity.js";

function deploymentMetadata() {
  const rawCommit = ownProcessEnvironmentString("RAILWAY_GIT_COMMIT_SHA")
    ?? ownProcessEnvironmentString("GITHUB_SHA")
    ?? ownProcessEnvironmentString("VERCEL_GIT_COMMIT_SHA")
    ?? "unknown";
  const rawVersion = ownProcessEnvironmentString("PINT_PATH_VERSION")
    ?? ownProcessEnvironmentString("npm_package_version")
    ?? "0.1.0";
  return {
    version: APP_REFLECT_APPLY(APP_REGEXP_EXEC, APP_VERSION_PATTERN, [rawVersion])
      !== null ? rawVersion : "unknown",
    commitSha: APP_REFLECT_APPLY(APP_REGEXP_EXEC, APP_COMMIT_PATTERN, [rawCommit])
      !== null ? rawCommit : "unknown",
    environment: env.NODE_ENV,
    ...railwayDeploymentIdentityHashes(APP_PROCESS_ENV),
  };
}

async function buildLazyRouters(): Promise<LazyRouters> {
  console.info("Initializing backend services...");

  const canonicalProductionRuntime = isCanonicalProductionRuntime({
    nodeEnv: env.NODE_ENV,
    railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
  }) && !env.POSTGRES_RECOVERY_REHEARSAL_MODE;
  const externalWriteRehearsal =
    env.RESTORE_REHEARSAL_MODE || env.POSTGRES_RECOVERY_REHEARSAL_MODE;
  const automaticMaintenanceEnabled = shouldRunAutomaticMaintenance();

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
    { createRuntimePersistence, shouldUsePostgresRuntime },
    { AdminIngestionQueueRepository },
    { AccountSessionRepository },
    { AccountProfilePreferencesRepository },
    { AccountDeletionQueueRepository },
    { AccountPrivacyRepository },
    { PrivacyRetentionRepository },
    { CommunitySubmissionRepository },
    { VenueManagerInternalSubmissionRepository },
    { SourceEvidenceObjectRepository },
    { SourceEvidenceRetentionRepository },
    { VenuePendingChangeRepository },
    { VenueDataReadRepository },
    { BeerCatalogRepository },
    { PublicPriceRepository },
    { PublicVenueDirectoryRepository },
    { SystemStateRepository },
    { ActivityAuditRepository },
    { SupportFeedbackRepository },
    { VenueInventoryRepository },
    { VenueIdentityRepository },
    { BillingCheckoutRepository },
    { VenueAccessRepository },
    { MissionLifecycleRepository },
    { MissionDiscoveryAutomationRepository },
    { StripeSubscriptionRepository },
    { VenueRequestRepository },
    { VenuePartnerRepository },
    { AdminAnalyticsRepository },
    { VenueManagerInsightsRepository },
    { AdminAccountRepository },
    { checkPostgresRuntimeReadiness },
    { checkPostgresMaintenanceRuntimeReadiness },
    { createPostgresDatabase },
    { createAdminRouter },
    { AdminService },
    { createBusinessRouter },
    { BusinessService },
  ] = await Promise.all([
    import("./db/runtime-persistence.js"),
    import("./db/admin-ingestion-queue.repository.js"),
    import("./db/account-session.repository.js"),
    import("./db/account-profile-preferences.repository.js"),
    import("./db/account-deletion-queue.repository.js"),
    import("./db/account-privacy.repository.js"),
    import("./db/privacy-retention.repository.js"),
    import("./db/community-submission.repository.js"),
    import("./db/venue-manager-internal-submission.repository.js"),
    import("./db/source-evidence-object.repository.js"),
    import("./db/source-evidence-retention.repository.js"),
    import("./db/venue-pending-change.repository.js"),
    import("./db/venue-data-read.repository.js"),
    import("./db/beer-catalog.repository.js"),
    import("./db/public-price.repository.js"),
    import("./db/public-venue-directory.repository.js"),
    import("./db/system-state.repository.js"),
    import("./db/activity-audit.repository.js"),
    import("./db/support-feedback.repository.js"),
    import("./db/venue-inventory.repository.js"),
    import("./db/venue-identity.repository.js"),
    import("./db/billing-checkout.repository.js"),
    import("./db/venue-access.repository.js"),
    import("./db/mission-lifecycle.repository.js"),
    import("./db/mission-discovery-automation.repository.js"),
    import("./db/stripe-subscription.repository.js"),
    import("./db/venue-request.repository.js"),
    import("./db/venue-partner.repository.js"),
    import("./db/admin-analytics.repository.js"),
    import("./db/venue-manager-insights.repository.js"),
    import("./db/admin-account.repository.js"),
    import("./db/postgres-runtime.js"),
    import("./db/postgres-maintenance-runtime.js"),
    import("./db/sql-database.js"),
    import("./modules/admin/admin.routes.js"),
    import("./modules/admin/admin.service.js"),
    import("./modules/business/business.routes.js"),
    import("./modules/business/business.service.js"),
  ]);

  const postgresRuntime = shouldUsePostgresRuntime({
    nodeEnv: env.NODE_ENV,
    restoreRehearsalMode: env.RESTORE_REHEARSAL_MODE,
    postgresRecoveryRehearsalMode: env.POSTGRES_RECOVERY_REHEARSAL_MODE,
    databaseUrl: env.DATABASE_URL,
  });
  const persistence = await createRuntimePersistence({
    postgresRuntime,
    restoreRehearsalMode: env.RESTORE_REHEARSAL_MODE,
    databaseUrl: env.DATABASE_URL,
    postgresRootCaPem: env.PINTPATH_POSTGRES_ROOT_CA_PEM,
    expectedPostgresRootCaDerSha256:
      env.PINTPATH_POSTGRES_ROOT_CA_DER_SHA256,
  });
  const {
    sqlDatabase,
    businessRepository,
    performAccountDeletionSecretPhysicalCheckpoint,
  } = persistence;
  let maintenanceDatabase = sqlDatabase;
  let maintenanceReadinessDatabase = sqlDatabase;
  let postgresAuthoritiesClosed = false;
  const closePostgresAuthorities = async (): Promise<void> => {
    if (postgresAuthoritiesClosed) return;
    postgresAuthoritiesClosed = true;
    const closeFailures: unknown[] = [];
    for (const database of new Set([
      maintenanceReadinessDatabase,
      maintenanceDatabase,
    ])) {
      if (database === sqlDatabase) continue;
      try {
        await database.close();
      } catch (error) {
        closeFailures.push(error);
      }
    }
    try {
      await persistence.close();
    } catch (error) {
      closeFailures.push(error);
    }
    if (closeFailures.length > 0) {
      throw new AggregateError(
        closeFailures,
        "PostgreSQL runtime authorities failed to close exactly.",
      );
    }
  };
  initializingServicesCleanup = closePostgresAuthorities;
  try {
    if (persistence.mode === "postgres") {
      if (!persistence.postgresTransport) {
        throw new Error(
          "Canonical PostgreSQL runtime transport authority is unavailable.",
        );
      }
      await persistence.assertPostgresTransportExact();
    }
    if (persistence.mode === "postgres" && env.DATABASE_MAINTENANCE_URL) {
      maintenanceDatabase = createPostgresDatabase({
        connectionString: env.DATABASE_MAINTENANCE_URL,
        activeRole: "pintpath_maintenance",
        railwayStockLocalhostCaConnection:
          persistence.postgresTransport!.nodeConnection,
        applicationName: "pintpath-privacy-maintenance",
        maxConnections:
          POSTGRES_CONNECTION_BUDGET.maintenanceWorkPoolMaxConnectionsPerProcess,
        idleTimeoutMs: 30_000,
        connectionTimeoutMs: 10_000,
        statementTimeoutMs: 60_000,
        idleInTransactionTimeoutMs: 60_000,
      });
      maintenanceReadinessDatabase = createPostgresDatabase({
        connectionString: env.DATABASE_MAINTENANCE_URL,
        activeRole: "pintpath_maintenance",
        railwayStockLocalhostCaConnection:
          persistence.postgresTransport!.nodeConnection,
        applicationName: "pintpath-privacy-maintenance-readiness",
        maxConnections:
          POSTGRES_CONNECTION_BUDGET.maintenanceReadinessPoolMaxConnectionsPerProcess,
        idleTimeoutMs: 30_000,
        connectionTimeoutMs: 10_000,
        statementTimeoutMs: 60_000,
        idleInTransactionTimeoutMs: 60_000,
      });
    }
    if (maintenanceReadinessDatabase !== sqlDatabase) {
      await persistence.assertPostgresTransportExact();
      let maintenanceReadiness;
      try {
        maintenanceReadiness = await checkPostgresMaintenanceRuntimeReadiness(
          maintenanceReadinessDatabase,
          {
            allowLegacyTwoConnectionLimitDuringRollout:
              !automaticMaintenanceEnabled,
          },
        );
      } finally {
        await persistence.assertPostgresTransportExact();
      }
      if (!maintenanceReadiness.ready) {
        throw new Error(
          `Postgres privacy-maintenance authority failed: ${maintenanceReadiness.failures.join(",") || "unknown"}.`,
        );
      }
    }
  } catch (error) {
    let cleanupError: unknown;
    try {
      await closePostgresAuthorities();
    } catch (cause) {
      cleanupError = cause;
    }
    initializingServicesCleanup = undefined;
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "PostgreSQL startup and authority cleanup failed.",
      );
    }
    throw error;
  }
  const adminIngestionQueueRepository = !externalWriteRehearsal
    ? new AdminIngestionQueueRepository(sqlDatabase)
    : undefined;
  const beerCatalogRepository = new BeerCatalogRepository(sqlDatabase);
  const publicPriceRepository = new PublicPriceRepository(sqlDatabase);
  const publicVenueDirectoryRepository = new PublicVenueDirectoryRepository(sqlDatabase);
  const systemStateRepository = new SystemStateRepository(sqlDatabase);
  const activityAuditRepository = new ActivityAuditRepository(sqlDatabase);
  const supportFeedbackRepository = new SupportFeedbackRepository(sqlDatabase);
  const accountSessionRepository = new AccountSessionRepository(sqlDatabase);
  const accountProfilePreferencesRepository = new AccountProfilePreferencesRepository(sqlDatabase);
  const venueInventoryRepository = new VenueInventoryRepository(sqlDatabase);
  const venueIdentityRepository = new VenueIdentityRepository(sqlDatabase);
  const billingCheckoutRepository = new BillingCheckoutRepository(sqlDatabase);
  const venueAccessRepository = new VenueAccessRepository(sqlDatabase);
  const missionLifecycleRepository = new MissionLifecycleRepository(sqlDatabase);
  const missionDiscoveryAutomationRepository = new MissionDiscoveryAutomationRepository(sqlDatabase);
  const stripeSubscriptionRepository = new StripeSubscriptionRepository(sqlDatabase);
  const venueRequestRepository = new VenueRequestRepository(sqlDatabase);
  const venuePartnerRepository = new VenuePartnerRepository(sqlDatabase);
  const adminAnalyticsRepository = new AdminAnalyticsRepository(sqlDatabase);
  const venueManagerInsightsRepository = new VenueManagerInsightsRepository(sqlDatabase);
  const adminAccountRepository = new AdminAccountRepository(sqlDatabase);
  const accountDeletionQueueRepository = new AccountDeletionQueueRepository(sqlDatabase);
  const accountPrivacyRepository = new AccountPrivacyRepository(maintenanceDatabase);
  const privacyRetentionRepository = new PrivacyRetentionRepository(maintenanceDatabase);
  const communitySubmissionRepository = new CommunitySubmissionRepository(sqlDatabase);
  const venueManagerInternalSubmissionRepository = new VenueManagerInternalSubmissionRepository(sqlDatabase);
  const sourceEvidenceObjectRepository = new SourceEvidenceObjectRepository(sqlDatabase);
  const sourceEvidenceRetentionRepository = new SourceEvidenceRetentionRepository(sqlDatabase);
  const venuePendingChangeRepository = new VenuePendingChangeRepository(sqlDatabase);
  const venueDataReadRepository = new VenueDataReadRepository(sqlDatabase);
  const adminService = new AdminService(
    adminIngestionQueueRepository,
    externalWriteRehearsal ? undefined : env.SUPABASE_URL,
    externalWriteRehearsal ? undefined : env.SUPABASE_SERVICE_ROLE_KEY,
    env.SUPABASE_MENU_CAPTURE_TABLE,
    externalWriteRehearsal ? undefined : env.OPENAI_API_KEY,
    externalWriteRehearsal ? undefined : env.GOOGLE_PLACES_API_KEY ?? env.GOOGLE_MAPS_API_KEY,
    externalWriteRehearsal ? undefined : sqlDatabase,
  );
  await adminService.initializeIngestionQueue();
  const canonicalBusinessRuntimeEnv: Omit<typeof env, "DATABASE_PATH"> &
    Partial<Pick<typeof env, "DATABASE_PATH">> = { ...env };
  delete canonicalBusinessRuntimeEnv.DATABASE_PATH;
  const businessRuntimeEnv = env.RESTORE_REHEARSAL_MODE
    ? {
        ...env,
        GOOGLE_MAPS_API_KEY: undefined,
        GOOGLE_PLACES_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        REPORT_DELIVERY_SCHEDULE_ENABLED: false,
        // A restore URL plus a matching expected URL from the same runtime
        // environment is not independent destination authority. Keep every
        // Supabase credential out of the service/client boundary until a real
        // disposable project is registered in reviewed release authority.
        SUPABASE_URL: undefined,
        SUPABASE_ANON_KEY: undefined,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
      }
    : env.POSTGRES_RECOVERY_REHEARSAL_MODE
      ? {
          ...canonicalBusinessRuntimeEnv,
          GOOGLE_MAPS_API_KEY: undefined,
          GOOGLE_PLACES_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          REPORT_DELIVERY_SCHEDULE_ENABLED: false,
          SUPABASE_SERVICE_ROLE_KEY: undefined,
          OFFSITE_BACKUP_SUPABASE_URL: undefined,
          OFFSITE_BACKUP_SERVICE_ROLE_KEY: undefined,
          STRIPE_SECRET_KEY: undefined,
          STRIPE_WEBHOOK_SECRET: undefined,
          STRIPE_PRICE_MONTHLY: undefined,
          STRIPE_PRICE_YEARLY: undefined,
          STRIPE_PRO_PRICE_ID: undefined,
          POS_WEBHOOK_SIGNING_SECRET: undefined,
          ADMIN_EMAILS: undefined,
        }
    : persistence.mode === "postgres"
      ? canonicalBusinessRuntimeEnv
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
  let deletionNotificationCoordinator:
    | import("./lib/account-deletion-notification-worker.js").AccountDeletionNotificationCoordinator
    | undefined;
  if (!externalWriteRehearsal && env.ACCOUNT_DELETION_NOTICE_MODE !== "disabled") {
    const [notificationModule, workerModule] = await Promise.all([
      import("./lib/account-deletion-notification.js"),
      import("./lib/account-deletion-notification-worker.js"),
    ]);
    const keyring = workerModule.parseAccountDeletionNotificationKeyring({
      activeKeyId: env.ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID!,
      keyringJson: env.ACCOUNT_DELETION_NOTICE_KEYRING_JSON!,
    });
    const missingReferencedKeys = (await accountDeletionQueueRepository
      .listReferencedAccountDeletionNoticeKeyIds())
      .filter((keyId) => !keyring.keys.has(keyId));
    if (missingReferencedKeys.length > 0) {
      throw new Error(
        `Account deletion notification keyring is missing ${missingReferencedKeys.length} key(s) still referenced by encrypted recipients.`,
      );
    }
    const provider = env.ACCOUNT_DELETION_NOTICE_MODE === "mock"
      ? notificationModule.createMockAccountDeletionNotificationProvider()
      : notificationModule.createResendAccountDeletionNotificationProvider({
          apiKey: env.RESEND_TRANSACTIONAL_API_KEY!,
        });
    deletionNotificationCoordinator = new workerModule.AccountDeletionNotificationCoordinator(
      accountDeletionQueueRepository,
      {
        provider,
        keyring,
        performRecipientSecretPhysicalCheckpoint: performAccountDeletionSecretPhysicalCheckpoint,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        from: env.ACCOUNT_DELETION_NOTICE_FROM ?? "account@mock.pintpath.local",
        ...(env.ACCOUNT_DELETION_NOTICE_REPLY_TO
          ? { replyTo: env.ACCOUNT_DELETION_NOTICE_REPLY_TO }
          : {}),
        supportEmail: env.ACCOUNT_DELETION_NOTICE_REPLY_TO ?? "admin@pintpath.au",
      },
    );
  }
  const businessService = new BusinessService(
    businessRepository,
    businessRuntimeEnv,
    publicVenueDirectoryRepository,
    publicPriceRepository,
    systemStateRepository,
    activityAuditRepository,
    supportFeedbackRepository,
    accountSessionRepository,
    accountProfilePreferencesRepository,
    venueInventoryRepository,
    venueIdentityRepository,
    billingCheckoutRepository,
    venueAccessRepository,
    missionLifecycleRepository,
    missionDiscoveryAutomationRepository,
    stripeSubscriptionRepository,
    venueRequestRepository,
    venuePartnerRepository,
    adminAnalyticsRepository,
    venueManagerInsightsRepository,
    adminAccountRepository,
    accountDeletionQueueRepository,
    accountPrivacyRepository,
    privacyRetentionRepository,
    communitySubmissionRepository,
    venueManagerInternalSubmissionRepository,
    sourceEvidenceObjectRepository,
    sourceEvidenceRetentionRepository,
    venuePendingChangeRepository,
    venueDataReadRepository,
    performAccountDeletionSecretPhysicalCheckpoint,
    beerCatalogRepository,
    externalWriteRehearsal ? undefined : { extract: (input) => adminService.ocrMenuPhotos(input) },
    undefined,
    deletionTombstoneWriter,
    deletionNotificationCoordinator,
    sqlDatabase.dialect === "postgres"
      ? async () => {
          await persistence.assertPostgresTransportExact();
          let readiness;
          let maintenanceReadiness;
          try {
            [readiness, maintenanceReadiness] = await Promise.all([
              checkPostgresRuntimeReadiness(sqlDatabase),
              checkPostgresMaintenanceRuntimeReadiness(maintenanceReadinessDatabase, {
                allowLegacyTwoConnectionLimitDuringRollout:
                  !automaticMaintenanceEnabled,
              }),
            ]);
          } finally {
            await persistence.assertPostgresTransportExact();
          }
          return {
            ok: readiness.ready && maintenanceReadiness.ready,
            foreignKeyViolations: 0,
            poolMetrics: [
              inspectPostgresApplicationPoolMetrics(
                sqlDatabase,
                "runtime",
                POSTGRES_CONNECTION_BUDGET.runtimePoolMaxConnectionsPerProcess,
              ),
              inspectPostgresApplicationPoolMetrics(
                maintenanceDatabase,
                "maintenance_work",
                POSTGRES_CONNECTION_BUDGET.maintenanceWorkPoolMaxConnectionsPerProcess,
              ),
              inspectPostgresApplicationPoolMetrics(
                maintenanceReadinessDatabase,
                "maintenance_readiness",
                POSTGRES_CONNECTION_BUDGET.maintenanceReadinessPoolMaxConnectionsPerProcess,
              ),
            ],
          };
        }
      : async () => businessRepository.checkDatabaseHealth(),
  );
  const schedulerStops: Array<() => Promise<void>> = [];
  const schedulerOwner = `${process.pid}:${crypto.randomUUID()}`;
  const backgroundTasks = new Set<Promise<unknown>>();
  const trackBackgroundTask = (task: Promise<unknown>) => {
    backgroundTasks.add(task);
    void task.finally(() => backgroundTasks.delete(task));
  };
  businessService.logStartupSummary();
  const recordOperationalState = async (key: string, value: Record<string, unknown>) => {
    const recordedAt = new Date().toISOString();
    await systemStateRepository.set(`job:${key}`, { ...value, recordedAt }, recordedAt);
  };
  const withSystemLease = async <T>(input: {
    key: string;
    durationMs: number;
    run: () => T | Promise<T>;
  }): Promise<T | { skipped: true; reason: "lease_held_by_another_instance" }> => {
    const now = new Date();
    const leaseToken = crypto.randomUUID();
    const acquired = await systemStateRepository.acquireLease({
      key: input.key,
      owner: schedulerOwner,
      leaseToken,
      now: now.toISOString(),
      leaseUntil: new Date(now.getTime() + input.durationMs).toISOString(),
    });
    if (!acquired) return { skipped: true, reason: "lease_held_by_another_instance" };
    let renewalInFlight: Promise<void> | null = null;
    let renewalFailure: Error | null = null;
    const renewalIntervalMs = Math.max(1_000, Math.floor(input.durationMs / 3));
    const renew = (): void => {
      if (renewalInFlight || renewalFailure) return;
      renewalInFlight = (async () => {
        const renewedAt = new Date();
        const renewed = await systemStateRepository.renewLease({
          key: input.key,
          owner: schedulerOwner,
          leaseToken,
          now: renewedAt.toISOString(),
          leaseUntil: new Date(
            renewedAt.getTime() + input.durationMs,
          ).toISOString(),
        });
        if (!renewed) {
          throw new Error("automatic_maintenance_lease_renewal_lost");
        }
      })().catch((error: unknown) => {
        renewalFailure = error instanceof Error
          ? error
          : new Error("automatic_maintenance_lease_renewal_failed");
      }).finally(() => {
        renewalInFlight = null;
      });
    };
    const renewalTimer = setInterval(renew, renewalIntervalMs);
    renewalTimer.unref();
    try {
      const result = await input.run();
      if (renewalInFlight) await renewalInFlight;
      if (renewalFailure) throw renewalFailure;
      return result;
    } finally {
      clearInterval(renewalTimer);
      if (renewalInFlight) await renewalInFlight;
      await systemStateRepository.releaseLease({
        key: input.key,
        owner: schedulerOwner,
        leaseToken,
        now: new Date().toISOString(),
      });
    }
  };
  const runEvidenceRetention = async () => {
    return withSystemLease({
      key: "lease:evidence_retention",
      durationMs: 55 * 60 * 1_000,
      run: async () => {
        const now = new Date();
      const evidence = await businessService.purgeExpiredSourceEvidence(100);
      const ingestionImages = await adminService.purgeQueuedIngestionImages(now.toISOString());
      const privacyRetention = await businessService.runPrivacyRetention();
      return { ...evidence, ingestionImages, privacyRetention };
      },
    });
  };
  if (env.NODE_ENV === "test") {
    trackBackgroundTask(runEvidenceRetention().then(async (result) => {
      await recordOperationalState("evidence_retention", {
        state: "succeeded",
        trigger: "startup",
        completedAt: new Date().toISOString(),
        ...result,
      });
    }).catch(async (error) => {
      await recordOperationalState("evidence_retention", {
        state: "failed",
        trigger: "startup",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? redactSecrets(error.message).slice(0, 300) : "Evidence retention failed",
      });
    }));
  }
  if (automaticMaintenanceEnabled) {
    const { scheduleMissionMaintenance } = await import("./lib/mission-maintenance.js");
    const evidenceScheduler = scheduleMissionMaintenance({
      run: () => withSystemLease({
        key: "lease:evidence_retention",
        durationMs: 25 * 60 * 1_000,
        run: runEvidenceRetention,
      }),
      intervalMinutes: 60,
      onStatus: (status) => recordOperationalState("evidence_retention", status.state === "succeeded"
        ? { ...status, ...status.result }
        : status),
    });
    schedulerStops.push(evidenceScheduler.stop);
    const scheduler = scheduleMissionMaintenance({
      run: () => withSystemLease({
        key: "lease:mission_maintenance",
        durationMs: 25 * 60 * 1_000,
        run: () => businessService.runMissionMaintenance(),
      }),
      intervalMinutes: 30,
      onStatus: (status) => recordOperationalState("mission_maintenance", { ...status }),
    });
    schedulerStops.push(scheduler.stop);
  }
  if (
    automaticMaintenanceEnabled
    && canonicalProductionRuntime
    && env.REPORT_DELIVERY_SCHEDULE_ENABLED
  ) {
    const {
      createResendReportEmailProvider,
      scheduleMonthlyReportDelivery,
    } = await import("./lib/monthly-report-delivery.js");
    if (env.REPORT_EMAIL_MODE !== "resend" || !env.RESEND_API_KEY || !env.REPORT_EMAIL_FROM) {
      throw new Error("Monthly report scheduling requires Resend delivery configuration.");
    }
    const scheduler = scheduleMonthlyReportDelivery({
      generator: businessService,
      repository: venueAccessRepository,
      accountRepository: accountSessionRepository,
      stateRepository: systemStateRepository,
      provider: createResendReportEmailProvider({ apiKey: env.RESEND_API_KEY }),
      publicBaseUrl: env.PUBLIC_BASE_URL,
      from: env.REPORT_EMAIL_FROM,
      ...(env.REPORT_EMAIL_REPLY_TO ? { replyTo: env.REPORT_EMAIL_REPLY_TO } : {}),
      timezone: env.REPORT_TIMEZONE,
      scheduleDay: env.REPORT_DELIVERY_DAY,
      scheduleHour: env.REPORT_DELIVERY_HOUR,
      checkIntervalMinutes: env.REPORT_DELIVERY_CHECK_INTERVAL_MINUTES,
      leaseKey: "lease:monthly_report_delivery",
      leaseOwner: schedulerOwner,
      leaseDurationMs: 55 * 60 * 1_000,
      onStatus: (status) => recordOperationalState("monthly_report_delivery", status),
    });
    schedulerStops.push(scheduler.stop);
  }
  if (
    automaticMaintenanceEnabled
    && (canonicalProductionRuntime || env.ACCOUNT_DELETION_REHEARSAL_ENABLED)
    && deletionNotificationCoordinator
  ) {
    const { scheduleMissionMaintenance } = await import("./lib/mission-maintenance.js");
    const scheduler = scheduleMissionMaintenance({
      run: () => withSystemLease({
        key: "lease:account_deletion_notifications",
        durationMs: 4 * 60 * 1_000,
        run: () => businessService.processAccountDeletionCompletionNotifications(20),
      }),
      intervalMinutes: env.ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES,
      onStatus: (status) => recordOperationalState("account_deletion_notifications", {
        ...status,
        intervalMinutes: env.ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES,
      }),
    });
    schedulerStops.push(scheduler.stop);
  }

  console.info("Backend services initialized.");

  return {
    adminRouter: createAdminRouter(adminService, businessService),
    businessRouter: createBusinessRouter(businessService),
    businessService,
    probeOffsiteBackupReadiness: () =>
      resolveOffsiteBackupReadinessForRuntime(
        canonicalProductionRuntime,
        async () => {
          if (
            persistence.mode === "postgres" &&
            !env.ACCOUNT_DELETION_REHEARSAL_ENABLED
          ) {
            const state = await systemStateRepository.get<Record<string, unknown>>(
              "job:postgres_logical_backup_success",
            );
            const {
              inspectPostgresLogicalRuntimeDatabaseIdentity,
              probePostgresLogicalOffsiteReadiness,
            } = await import("./lib/postgres-logical-offsite.js");
            let runtimeDatabaseIdentitySha256 = "";
            try {
              runtimeDatabaseIdentitySha256 =
                await inspectPostgresLogicalRuntimeDatabaseIdentity(sqlDatabase);
            } catch {
              // The strict probe maps an unavailable/invalid identity to a safe
              // binding failure without exposing database identity material.
            }
            return probePostgresLogicalOffsiteReadiness({
              stateValue: state?.value,
              runtimeDatabaseIdentitySha256,
              sourceSupabaseUrl: env.SUPABASE_URL,
              destinationSupabaseUrl: env.OFFSITE_BACKUP_SUPABASE_URL,
              destinationServiceRoleKey: env.OFFSITE_BACKUP_SERVICE_ROLE_KEY,
              bucketName: env.OFFSITE_BACKUP_BUCKET,
              maxFreshnessHours: env.OFFSITE_BACKUP_INTERVAL_HOURS + 2,
              requestTimeoutMs: 10_000,
            });
          }
          const state = await systemStateRepository.get<{ completedAt?: unknown }>(
            "job:offsite_backup_success",
          );
          const { probeOffsiteBackupReadiness } = await import(
            "./lib/offsite-backup.js"
          );
          return probeOffsiteBackupReadiness({
            sourceSupabaseUrl: env.SUPABASE_URL,
            destinationSupabaseUrl: env.OFFSITE_BACKUP_SUPABASE_URL,
            destinationServiceRoleKey: env.OFFSITE_BACKUP_SERVICE_ROLE_KEY,
            bucketName: env.OFFSITE_BACKUP_BUCKET,
            lastSuccessfulAt:
              typeof state?.value.completedAt === "string"
                ? state.value.completedAt
                : null,
            maxFreshnessHours: env.OFFSITE_BACKUP_INTERVAL_HOURS + 2,
            required: false,
            probeCapabilities: false,
          });
        },
      ),
    shutdown: async () => {
      await Promise.allSettled(schedulerStops.splice(0).map((stop) => stop()));
      if (backgroundTasks.size > 0) {
        await Promise.allSettled([...backgroundTasks]);
      }
      const { shutdownRateLimitRedis } = await import("./middleware/rate-limit.js");
      await shutdownRateLimitRedis();
      await closePostgresAuthorities();
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
  postgresRecoveryRehearsalMode = env.POSTGRES_RECOVERY_REHEARSAL_MODE,
): string {
  if (nodeEnv !== "production" || restoreRehearsalMode || postgresRecoveryRehearsalMode) {
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

export function createPublicVenuePageHandler(
  getBusinessService: () => Promise<Pick<BusinessService, "getPublicVenueById">>,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const businessService = await getBusinessService();
      const venueId = req.params.venueId;
      if (typeof venueId !== "string") {
        throw new AppError("Venue not found.", 404);
      }
      const venue = await businessService.getPublicVenueById(venueId);
      res
        .type("html")
        .setHeader(
          "Cache-Control",
          env.NODE_ENV === "production"
            && !env.RESTORE_REHEARSAL_MODE
            && !env.POSTGRES_RECOVERY_REHEARSAL_MODE
            ? "public, max-age=300"
            : "no-store",
        )
        .send(renderPublicVenuePage(venue, String(res.locals["cspNonce"])));
    } catch (error) {
      next(error);
    }
  };
}

async function getLazyRouters(): Promise<LazyRouters> {
  if (env.RESTORE_REHEARSAL_MODE && env.RESTORE_REHEARSAL_PHASE === "bootstrap") {
    throw new AppError("Restore rehearsal is in bootstrap phase; application data routes are unavailable.", 503);
  }
  if (!lazyRoutersPromise) {
    lazyRoutersPromise = buildLazyRouters()
      .then((routers) => {
        initializingServicesCleanup = undefined;
        return routers;
      })
      .catch(async (error) => {
        const cleanup = initializingServicesCleanup;
        initializingServicesCleanup = undefined;
        let cleanupError: unknown;
        try {
          await cleanup?.();
        } catch (cause) {
          cleanupError = cause;
        }
        lazyRoutersPromise = undefined;
        logger.error("Backend initialization failed", {
          error: error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error)),
        });
        if (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Backend initialization and PostgreSQL authority cleanup failed.",
          );
        }
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

export function createCanonicalProductionHostGuard(config: {
  enabled: boolean;
  canonicalOrigin: string;
}): RequestHandler {
  return (req, res, next) => {
    let requestHostname = "";
    try {
      requestHostname = req.hostname;
    } catch {
      // A malformed Host/X-Forwarded-Host value is rejected below without
      // reflecting it into a response or redirect target.
    }

    const resolution = resolveCanonicalHostRequest({
      enabled: config.enabled,
      canonicalOrigin: config.canonicalOrigin,
      requestHostname,
      requestMethod: req.method,
      requestPath: req.path,
      requestTarget: req.originalUrl,
    });
    if (resolution.action === "redirect") {
      res.redirect(308, resolution.location);
      return;
    }
    if (resolution.action === "reject") {
      res.status(421).set("Cache-Control", "no-store").type("text/plain").send(
        "Misdirected Request",
      );
      return;
    }
    next();
  };
}

export function createApp() {
  const app = express();
  // Keep the static application inside the deployable artifact. In source the
  // module lives at src/app.ts and resolves ../viewer; after compilation it
  // lives at dist/src/app.js and resolves dist/viewer. This deliberately does
  // not depend on the process working directory or on a source checkout being
  // present beside dist/.
  const viewerDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../viewer",
  );
  const allowedOrigins = getAllowedOrigins();
  const restoreAccessAttemptLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 20,
    keyPrefix: "restore:access-attempt",
    keyGenerator: getRateLimitIdentity,
  });
  const readinessProbeLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 300,
    keyPrefix: "public:readiness-probe",
    // Railway requests without its trusted client-IP header share one strict
    // bucket instead of making the public platform probe unavailable.
    keyGenerator: (req) => getRateLimitIdentity(req) ?? "unresolved-readiness-client",
  });
  const formSubmissionFallbackLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 30,
    keyPrefix: "public:form-submission-unavailable",
    keyGenerator: getRateLimitIdentity,
  });
  const resolveNormalReadinessProbe = createReadinessProbeSingleFlight<{
    readonly statusCode: 200 | 503;
    readonly payload: unknown;
  }>();
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
  // Express resolves req.hostname through the configured proxy boundary above.
  // The guard accepts only fixed reviewed aliases and always constructs the
  // Location from PUBLIC_BASE_URL, so forwarded input can never choose a
  // redirect origin.
  app.use(createCanonicalProductionHostGuard({
    enabled: shouldEnforceCanonicalProductionHost({
      nodeEnv: env.NODE_ENV,
      railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
      restoreRehearsalMode: env.RESTORE_REHEARSAL_MODE,
      postgresRecoveryRehearsalMode: env.POSTGRES_RECOVERY_REHEARSAL_MODE,
      accountDeletionRehearsalEnabled: env.ACCOUNT_DELETION_REHEARSAL_ENABLED,
    }),
    canonicalOrigin: env.PUBLIC_BASE_URL,
  }));
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
            "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.3/dist/umd/supabase.min.js",
            "https://cdn.jsdelivr.net/npm/@googlemaps/markerclusterer@2.6.2/dist/index.min.js",
          ],
          "script-src-elem": [
            "'self'",
            (_req, res) => `'nonce-${String((res as Response).locals.cspNonce)}'`,
            "https://maps.googleapis.com",
            "https://maps.gstatic.com",
            "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.3/dist/umd/supabase.min.js",
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
          "upgrade-insecure-requests":
            env.NODE_ENV === "production" && !env.POSTGRES_RECOVERY_REHEARSAL_MODE
              ? []
              : null,
        },
      },
      ...(env.NODE_ENV === "production" ? {} : { strictTransportSecurity: false }),
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use(compression({
    threshold: 1024,
    filter: (req, res) => !req.path.startsWith("/api/") && compression.filter(req, res),
  }));
  app.use((_req, res, next) => {
    res.setHeader(
      "Permissions-Policy",
      env.RESTORE_REHEARSAL_MODE || env.POSTGRES_RECOVERY_REHEARSAL_MODE
        ? "camera=(), geolocation=(self), microphone=(), payment=()"
        : "camera=(self), geolocation=(self), microphone=(), payment=(self)",
    );
    if (env.RESTORE_REHEARSAL_MODE || env.POSTGRES_RECOVERY_REHEARSAL_MODE) {
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
  app.use((req, _res, next) => {
    if (
      !env.POSTGRES_RECOVERY_REHEARSAL_MODE
      || isPostgresRecoveryRehearsalMutationAllowed(req.method, req.path)
    ) {
      next();
      return;
    }

    next(new AppError(
      "Writes are disabled during the isolated PostgreSQL recovery rehearsal.",
      503,
    ));
  });
  app.use((req, res, next) => {
    const origin = req.get("origin");

    if (origin && isTrustedOrigin(req, origin, allowedOrigins)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Methods",
          env.RESTORE_REHEARSAL_MODE
            ? "GET"
            : env.POSTGRES_RECOVERY_REHEARSAL_MODE
              ? "GET,POST,OPTIONS"
              : "GET,POST,PUT,PATCH,DELETE,OPTIONS",
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
  // Sensitive browser forms use this same-origin POST target when their
  // JavaScript submit path is unavailable. Keep it ahead of every body parser:
  // the fallback must never parse, persist, log, reflect, or redirect form data.
  app.post(
    "/form-submission-unavailable",
    (req, res, next) => {
      const rawContentLength = req.get("content-length");
      if (rawContentLength != null) {
        const contentLength = Number(rawContentLength);
        if (
          !Number.isSafeInteger(contentLength)
          || contentLength < 0
          || contentLength > FORM_FALLBACK_MAX_DECLARED_BODY_BYTES
        ) {
          res
            .status(413)
            .set({
              "Cache-Control": "no-store, max-age=0",
              Pragma: "no-cache",
              "X-Robots-Tag": "noindex, nofollow, noarchive",
            })
            .type("text/plain")
            .send("Form submission is too large.");
          return;
        }
      }
      next();
    },
    formSubmissionFallbackLimiter,
    (_req, res) => {
      res
        .status(409)
        .set({
          "Cache-Control": "no-store, max-age=0",
          Pragma: "no-cache",
          "X-Robots-Tag": "noindex, nofollow, noarchive",
        })
        .type("html")
        .send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Form not submitted | Pint Path</title>
  <link rel="stylesheet" href="/business.css" />
</head>
<body>
  <main class="pageShell">
    <section class="panel" role="alert" aria-labelledby="formUnavailableTitle">
      <div class="eyebrow">Nothing was saved</div>
      <h1 id="formUnavailableTitle">This secure form needs JavaScript.</h1>
      <p>Your information was not processed or saved. Return to the form, reload the page, and try again.</p>
      <div class="actionRow">
        <a class="button button--primary" href="/">Return to Pint Path</a>
        <a class="button" href="/feedback.html">Contact Pint Path</a>
      </div>
    </section>
  </main>
</body>
</html>`);
    },
  );
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

  app.get("/health", (_req, res, next) => {
    try {
      sendSecureProbeJson(res, 200, success({
        service: "pint-path",
        status: "ok",
        deployment: deploymentMetadata(),
        ...automaticMaintenanceMetadata(),
        ...(env.RESTORE_REHEARSAL_MODE
          ? { restoreRehearsal: { phase: env.RESTORE_REHEARSAL_PHASE } }
          : {}),
        ...postgresRecoveryRehearsalMetadata(),
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/startup", async (_req, res, next) => {
    try {
      const { businessService } = await getLazyRouters();
      const startup = await businessService.getLocalStartupReadiness();
      sendSecureProbeJson(res, startup.ready ? 200 : 503, success({
        service: "pint-path",
        status: startup.ready ? "startup_ready" : "startup_not_ready",
        deployment: deploymentMetadata(),
        ...automaticMaintenanceMetadata(),
        dependencies: startup.dependencies,
        ...postgresRecoveryRehearsalMetadata(),
      }));
    } catch (error) {
      next(error);
    }
  });

  // readinessProbeLimiter is the first route-specific handler and uses the
  // shared, production-fail-closed Redis rate-limit authority.
  // codeql[js/missing-rate-limiting]
  app.get("/ready", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    readinessProbeLimiter(req, res, next);
  }, async (_req, res, next) => { // lgtm[js/missing-rate-limiting]
    try {
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
        sendSecureProbeJson(res, volumeReady ? 200 : 503, success({
          service: "pint-path",
          status: volumeReady ? "bootstrap_ready" : "bootstrap_not_ready",
          deployment: deploymentMetadata(),
          ...automaticMaintenanceMetadata(),
          restoreRehearsal: {
            phase: "bootstrap",
            backendServicesInitialized: false,
            databaseOpened: false,
            volumeMount: volumeReady ? "verified" : "missing_or_invalid",
          },
        }));
        return;
      }
      const result = await resolveNormalReadinessProbe(async () => {
        const { businessService, probeOffsiteBackupReadiness } = await getLazyRouters();
        const [readiness, rateLimiterRedis, offsiteBackup] = await awaitReadinessDependencies(
          businessService.getOperationalReadiness(),
          import("./middleware/rate-limit.js").then(({ probeRateLimitRedis }) => probeRateLimitRedis()),
          probeOffsiteBackupReadiness(),
        );
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
        return {
          statusCode: ready ? 200 as const : 503 as const,
          payload: success({
            service: "pint-path",
            status: ready ? "ready" : "not_ready",
            deployment: deploymentMetadata(),
            ...automaticMaintenanceMetadata(),
            ...postgresRecoveryRehearsalMetadata(),
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
        };
      });
      sendSecureProbeJson(res, result.statusCode, result.payload);
    } catch (error) {
      next(error);
    }
  });

  app.get("/config.js", async (_req, res, next) => {
    try {
      const { businessService } = await getLazyRouters();
      const publicConfig = await businessService.getPublicConfig();
      const viewerConfig = {
        // The public viewer uses server-gated API routes for venue and price data.
        // Supabase anon config is exposed only for OAuth login; exact price access stays server-gated.
        googleMapsApiKey: env.GOOGLE_MAPS_API_KEY ?? "",
        googleMapsMapId: env.GOOGLE_MAPS_MAP_ID ?? "",
        publicBaseUrl: env.PUBLIC_BASE_URL,
        // Restore rehearsals keep browser and server Supabase access fully
        // disconnected until candidate-bound destination authority exists.
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
          commercialLaunchEnabled: publicConfig.commercialLaunchEnabled,
          consumerPaidEnrollmentEnabled: publicConfig.consumerPaidEnrollmentEnabled,
          fieldTestMode: env.FIELD_TEST_MODE || env.RESTORE_REHEARSAL_MODE,
          restoreRehearsalMode: env.RESTORE_REHEARSAL_MODE,
          pintPointsRewardsEnabled: publicConfig.pintPointsRewardsEnabled,
          alcoholGamificationEnabled: publicConfig.alcoholGamificationEnabled,
          happyHourDiscoveryEnabled: publicConfig.happyHourDiscoveryEnabled,
          happyHourContributionsEnabled: publicConfig.happyHourContributionsEnabled,
          venueProTrialDays: publicConfig.venueProTrialDays,
          venueProTrialRequiresPaymentMethod: publicConfig.venueProTrialRequiresPaymentMethod,
          legalPolicyVersion: publicConfig.legalPolicyVersion,
          pricing: publicConfig.pricing
            ? {
                monthly: PREMIUM_PRICING.monthlyLabel,
                yearly: PREMIUM_PRICING.yearlyLabel,
              }
            : null,
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
  app.get(
    "/venues/:venueId",
    createPublicVenuePageHandler(async () => (await getLazyRouters()).businessService),
  );
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
        env.NODE_ENV === "production"
          && !env.RESTORE_REHEARSAL_MODE
          && !env.POSTGRES_RECOVERY_REHEARSAL_MODE
          ? "public, max-age=300"
          : "no-store",
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
