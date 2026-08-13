export type SupabaseNewKeyFormat = "publishable" | "secret";
export type SupabaseLegacyRole = "anon" | "service_role";
export type SupabaseServerApiKeyKind = "secret" | "legacy_service_role";

export const PRODUCTION_SUPABASE_AUTH_ORIGIN = "https://auth.pintpath.au";
export const PRODUCTION_SUPABASE_STORAGE_ORIGIN = "https://jxpubqlmqnnqwadmjgyk.supabase.co";
export const PERMANENT_STAGING_SUPABASE_ORIGIN = "https://bbfibbadwjxzrcdncavy.supabase.co";
export const OPERATIONAL_OFFSITE_SUPABASE_ORIGIN = "https://hfbmhdxrwtihukmixxta.supabase.co";
export const OPERATIONAL_OFFSITE_BACKUP_BUCKET = "pintpath-backups";

const NEW_KEY_PATTERNS: Readonly<Record<SupabaseNewKeyFormat, RegExp>> =
  Object.freeze({
    publishable: /^sb_publishable_[A-Za-z0-9_-]{20,220}$/,
    secret: /^sb_secret_[A-Za-z0-9_-]{20,220}$/,
  });
const LEGACY_JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{2,4096}$/;

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!LEGACY_JWT_SEGMENT_PATTERN.test(value) || value.length % 4 === 1) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.byteLength === 0 || decoded.toString("base64url") !== value) {
      decoded.fill(0);
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function isExactSupabaseNewKey(
  value: string,
  format: SupabaseNewKeyFormat,
): boolean {
  return NEW_KEY_PATTERNS[format].test(value);
}

export function hasExactLegacySupabaseRoleJwt(
  value: string,
  expectedRole: SupabaseLegacyRole,
): boolean {
  const segments = value.split(".");
  if (segments.length !== 3) return false;
  let headerBytes: Buffer | null = null;
  let payloadBytes: Buffer | null = null;
  let signatureBytes: Buffer | null = null;
  try {
    headerBytes = decodeCanonicalBase64Url(segments[0]!);
    payloadBytes = decodeCanonicalBase64Url(segments[1]!);
    signatureBytes = decodeCanonicalBase64Url(segments[2]!);
    if (!headerBytes || !payloadBytes || signatureBytes?.byteLength !== 32) {
      return false;
    }
    const header: unknown = JSON.parse(headerBytes.toString("utf8"));
    const payload: unknown = JSON.parse(payloadBytes.toString("utf8"));
    return isPlainJsonObject(header)
      && header.alg === "HS256"
      && header.typ === "JWT"
      && isPlainJsonObject(payload)
      && payload.role === expectedRole;
  } catch {
    return false;
  } finally {
    headerBytes?.fill(0);
    payloadBytes?.fill(0);
    signatureBytes?.fill(0);
  }
}

export function classifySupabaseServerApiKey(
  value: string,
): SupabaseServerApiKeyKind | null {
  if (isExactSupabaseNewKey(value, "secret")) return "secret";
  if (hasExactLegacySupabaseRoleJwt(value, "service_role")) {
    return "legacy_service_role";
  }
  return null;
}

export function assertSupabasePublicApiKey(
  value: string,
  fieldName = "Supabase public API key",
): "publishable" | "legacy_anon" {
  if (isExactSupabaseNewKey(value, "publishable")) return "publishable";
  if (hasExactLegacySupabaseRoleJwt(value, "anon")) return "legacy_anon";
  throw new Error(
    `${fieldName} must be an exact sb_publishable_ key or a structurally valid legacy JWT with role=anon; no key value is emitted.`,
  );
}

export function assertSupabaseServerApiKey(
  value: string,
  fieldName = "Supabase server API key",
): SupabaseServerApiKeyKind {
  const kind = classifySupabaseServerApiKey(value);
  if (kind) return kind;
  throw new Error(
    `${fieldName} must be an exact sb_secret_ key or a structurally valid legacy JWT with role=service_role; no key value is emitted.`,
  );
}

export function assertExactSupabaseOrigin(
  value: string,
  expectedOrigin: string,
  fieldName = "SUPABASE_URL",
): void {
  if (value === expectedOrigin) return;
  throw new Error(
    `${fieldName} must be the exact reviewed Supabase HTTPS origin; no configured value is emitted.`,
  );
}

export function resolveExactOperationalOffsiteBackupBucket(
  value: string | undefined,
  fieldName = "OFFSITE_BACKUP_BUCKET",
): typeof OPERATIONAL_OFFSITE_BACKUP_BUCKET {
  if (value === undefined || value === "") {
    return OPERATIONAL_OFFSITE_BACKUP_BUCKET;
  }
  if (value === OPERATIONAL_OFFSITE_BACKUP_BUCKET) {
    return OPERATIONAL_OFFSITE_BACKUP_BUCKET;
  }
  throw new Error(
    `${fieldName} must be the exact reviewed off-site backup bucket; no configured value is emitted.`,
  );
}
