import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  holdPrivateDirectoryIdentity,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

export const STAGING_SUPABASE_PROFILES_PREREQUISITE_SCHEMA =
  "pintpath-permanent-staging-supabase-profiles-prerequisite/v1" as const;
export const STAGING_SUPABASE_PROFILES_PREREQUISITE_FILENAME =
  "supabase-profiles-prerequisite.json" as const;
export const STAGING_SUPABASE_PROFILES_LOCK = Object.freeze({
  repository: "blackmagic30/Beer",
  projectRef: "bbfibbadwjxzrcdncavy",
  origin: "https://bbfibbadwjxzrcdncavy.supabase.co",
  publishableEndpoint: "/auth/v1/settings",
  endpoint: "/rest/v1/profiles?select=id&limit=1",
  githubEnvironment: "permanent-staging-provider-mutation",
} as const);

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9_-]{20,220}$/;
const SECRET_KEY_PATTERN = /^sb_secret_[A-Za-z0-9_-]{20,220}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAXIMUM_RESPONSE_BYTES = 64 * 1024;

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl: typeof fetch;
  readonly writeEvidence: (filename: string, source: string) => void;
  readonly writeOutput: (source: string) => void;
}

interface ParsedArguments {
  readonly candidateSha: string;
  readonly output: string;
}

export interface PermanentStagingSupabasePairCanaryEvidence {
  readonly origin: typeof STAGING_SUPABASE_PROFILES_LOCK.origin;
  readonly publishableEndpoint:
    typeof STAGING_SUPABASE_PROFILES_LOCK.publishableEndpoint;
  readonly secretEndpoint: typeof STAGING_SUPABASE_PROFILES_LOCK.endpoint;
  readonly publishableHttpStatus: number | null;
  readonly secretHttpStatus: number | null;
  readonly checks: {
    readonly replacementKeyShapesExact: boolean;
    readonly replacementKeysDistinct: boolean;
    readonly publishableAuthSettingsExact: boolean;
    readonly secretProfilesRelationExact: boolean;
    readonly exactInputPairUsed: true;
    readonly evidenceSecretFreeExact: true;
  };
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function parsePermanentStagingSupabaseProfilesPrerequisite(
  source: string,
  candidateSha: string,
): { readonly resultCount: 0 | 1 } | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!exactKeys(value, [
      "schemaVersion",
      "target",
      "candidateSha",
      "projectRef",
      "origin",
      "endpoint",
      "authentication",
      "outcome",
      "httpStatus",
      "resultCount",
      "checks",
      "secretMaterialIncluded",
      "secretDerivedCommitmentsIncluded",
    ]) || canonical(value) !== source || !exactKeys(value.checks, [
      "argumentsExact",
      "githubAuthorityExact",
      "stagingOriginExact",
      "serviceKeyShapeExact",
      "responseStatusExact",
      "responseContentTypeExact",
      "profilesRelationAccessible",
      "responseShapeExact",
      "evidenceSecretFreeExact",
    ]) || Object.values(value.checks).some((check) => check !== true) ||
      value.schemaVersion !== STAGING_SUPABASE_PROFILES_PREREQUISITE_SCHEMA ||
      value.target !== "permanent-staging" ||
      value.candidateSha !== candidateSha ||
      value.projectRef !== STAGING_SUPABASE_PROFILES_LOCK.projectRef ||
      value.origin !== STAGING_SUPABASE_PROFILES_LOCK.origin ||
      value.endpoint !== STAGING_SUPABASE_PROFILES_LOCK.endpoint ||
      value.authentication !== "service-key-apikey-header" ||
      value.outcome !== "passed" || value.httpStatus !== 200 ||
      (value.resultCount !== 0 && value.resultCount !== 1) ||
      value.secretMaterialIncluded !== false ||
      value.secretDerivedCommitmentsIncluded !== false) return null;
    return { resultCount: value.resultCount };
  } catch {
    return null;
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments | null {
  if (argv.length !== 4) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || values.has(key)) return null;
    values.set(key, value);
  }
  if ([...values.keys()].some((key) =>
    key !== "--candidate-sha" && key !== "--output")) return null;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const output = values.get("--output") ?? "";
  if (
    !SHA_PATTERN.test(candidateSha) ||
    !path.isAbsolute(output) ||
    path.resolve(output) !== output ||
    path.basename(output) !== STAGING_SUPABASE_PROFILES_PREREQUISITE_FILENAME
  ) return null;
  return { candidateSha, output };
}

function authorityExact(
  env: Dependencies["env"],
  candidateSha: string,
): boolean {
  return env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_REPOSITORY === STAGING_SUPABASE_PROFILES_LOCK.repository &&
    env.GITHUB_REF === "refs/heads/main" &&
    env.GITHUB_SHA === candidateSha &&
    env.GITHUB_RUN_ATTEMPT === "1" &&
    env.PINTPATH_PROTECTED_ENVIRONMENT ===
      STAGING_SUPABASE_PROFILES_LOCK.githubEnvironment &&
    env.PINTPATH_COLD_RECOVERY_CONFIRMATION ===
      `PREPARE_PERMANENT_STAGING_COLD_RECOVERY_FOR_${candidateSha}_FROM_12c0d24f6619a0286e16b8daf56fc27aaa1e3aba`;
}

async function boundedJson(response: Response): Promise<unknown | null> {
  if (!response.ok || response.status !== 200 || response.body === null) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, size),
    );
    return JSON.parse(source) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function profilesShapeExact(value: unknown): value is readonly { readonly id: string }[] {
  return Array.isArray(value) && value.length <= 1 && value.every((row) =>
    typeof row === "object" && row !== null && !Array.isArray(row) &&
    Object.keys(row).length === 1 && Object.hasOwn(row, "id") &&
    UUID_PATTERN.test(String((row as { id?: unknown }).id)));
}

function authSettingsShapeExact(value: unknown): boolean {
  if (!exactKeys(value, ["disable_signup", "external"]) &&
    !(typeof value === "object" && value !== null && !Array.isArray(value) &&
      Object.hasOwn(value, "disable_signup") && Object.hasOwn(value, "external"))) {
    return false;
  }
  const candidate = value as { disable_signup?: unknown; external?: unknown };
  if (typeof candidate.disable_signup !== "boolean" ||
    typeof candidate.external !== "object" || candidate.external === null ||
    Array.isArray(candidate.external)) return false;
  const entries = Object.entries(candidate.external as Record<string, unknown>);
  return entries.length >= 1 && entries.length <= 64 && entries.every(
    ([name, enabled]) =>
      /^[a-z][a-z0-9_]{0,63}$/.test(name) && typeof enabled === "boolean",
  );
}

/**
 * Probes the exact pair held by the replacement executor. The returned
 * evidence intentionally contains no key bytes, lengths, hashes, prefixes, or
 * other value-derived commitments.
 */
export async function canaryPermanentStagingSupabaseKeyPair(input: {
  readonly fetchImpl: typeof fetch;
  readonly publishableKey: string;
  readonly secretKey: string;
}): Promise<PermanentStagingSupabasePairCanaryEvidence> {
  const replacementKeyShapesExact =
    PUBLISHABLE_KEY_PATTERN.test(input.publishableKey) &&
    SECRET_KEY_PATTERN.test(input.secretKey);
  const replacementKeysDistinct = replacementKeyShapesExact &&
    input.publishableKey !== input.secretKey;
  let publishableHttpStatus: number | null = null;
  let secretHttpStatus: number | null = null;
  let publishableAuthSettingsExact = false;
  let secretProfilesRelationExact = false;
  if (replacementKeyShapesExact && replacementKeysDistinct) {
    try {
      const response = await input.fetchImpl(
        `${STAGING_SUPABASE_PROFILES_LOCK.origin}${STAGING_SUPABASE_PROFILES_LOCK.publishableEndpoint}`,
        {
          method: "GET",
          headers: { accept: "application/json", apikey: input.publishableKey },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        },
      );
      publishableHttpStatus = response.status;
      publishableAuthSettingsExact = response.status === 200 &&
        authSettingsShapeExact(await boundedJson(response));
    } catch {
      // A missing/ambiguous response is a closed canary result.
    }
    try {
      const response = await input.fetchImpl(
        `${STAGING_SUPABASE_PROFILES_LOCK.origin}${STAGING_SUPABASE_PROFILES_LOCK.endpoint}`,
        {
          method: "GET",
          headers: { accept: "application/json", apikey: input.secretKey },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        },
      );
      secretHttpStatus = response.status;
      secretProfilesRelationExact = response.status === 200 &&
        profilesShapeExact(await boundedJson(response));
    } catch {
      // A missing/ambiguous response is a closed canary result.
    }
  }
  return {
    origin: STAGING_SUPABASE_PROFILES_LOCK.origin,
    publishableEndpoint: STAGING_SUPABASE_PROFILES_LOCK.publishableEndpoint,
    secretEndpoint: STAGING_SUPABASE_PROFILES_LOCK.endpoint,
    publishableHttpStatus,
    secretHttpStatus,
    checks: {
      replacementKeyShapesExact,
      replacementKeysDistinct,
      publishableAuthSettingsExact,
      secretProfilesRelationExact,
      exactInputPairUsed: true,
      evidenceSecretFreeExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
}

function defaultWriteEvidence(filename: string, source: string): void {
  const directory = path.dirname(filename);
  const held = holdPrivateDirectoryIdentity(directory, {
    requireExactDirectoryMode: true,
    requireOwner: true,
  });
  let closed = false;
  try {
    held.assertExact();
    const identity = held.identity;
    held.close();
    closed = true;
    writePrivateExclusiveFile(directory, path.basename(filename), source, {
      requireExactDirectoryMode: true,
      requireOwner: true,
      expectedDirectoryIdentity: identity,
    });
  } finally {
    if (!closed) held.close();
  }
}

export async function runPermanentStagingSupabaseProfilesPrerequisite(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    fetchImpl: fetch,
    writeEvidence: defaultWriteEvidence,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const args = parseArguments(dependencies.argv);
  const key = dependencies.env.PINTPATH_SUPABASE_STAGING_READINESS_SERVICE_KEY ?? "";
  const checks = {
    argumentsExact: args !== null,
    githubAuthorityExact: args !== null && authorityExact(dependencies.env, args.candidateSha),
    stagingOriginExact: true,
    serviceKeyShapeExact: SECRET_KEY_PATTERN.test(key),
    responseStatusExact: false,
    responseContentTypeExact: false,
    profilesRelationAccessible: false,
    responseShapeExact: false,
    evidenceSecretFreeExact: true,
  };
  let resultCount: number | null = null;
  try {
    if (!args || !Object.values(checks).slice(0, 4).every(Boolean)) {
      throw new Error("prerequisite_invalid");
    }
    const response = await dependencies.fetchImpl(
      `${STAGING_SUPABASE_PROFILES_LOCK.origin}${STAGING_SUPABASE_PROFILES_LOCK.endpoint}`,
      {
        method: "GET",
        headers: { accept: "application/json", apikey: key },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    checks.responseStatusExact = response.status === 200;
    checks.responseContentTypeExact =
      /^application\/json(?:\s*;|\s*$)/i.test(
        response.headers.get("content-type") ?? "",
      );
    const value = await boundedJson(response);
    const shapeExact = profilesShapeExact(value);
    checks.responseShapeExact = shapeExact;
    checks.profilesRelationAccessible = checks.responseStatusExact &&
      checks.responseShapeExact;
    if (shapeExact) resultCount = value.length;
  } catch {
    // A failed direct probe is a closed prerequisite.
  }
  const passed = Object.values(checks).every((value) => value === true);
  if (passed && args) {
    const receipt = canonical({
      schemaVersion: STAGING_SUPABASE_PROFILES_PREREQUISITE_SCHEMA,
      target: "permanent-staging",
      candidateSha: args.candidateSha,
      projectRef: STAGING_SUPABASE_PROFILES_LOCK.projectRef,
      origin: STAGING_SUPABASE_PROFILES_LOCK.origin,
      endpoint: STAGING_SUPABASE_PROFILES_LOCK.endpoint,
      authentication: "service-key-apikey-header",
      outcome: "passed",
      httpStatus: 200,
      resultCount,
      checks,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    try {
      dependencies.writeEvidence(args.output, receipt);
      dependencies.writeOutput(`${JSON.stringify({
        ok: true,
        candidateSha: args.candidateSha,
        resultCount,
        productionContactAttempted: false,
        secretMaterialIncluded: false,
      })}\n`);
      return 0;
    } catch {
      // Fall through to a bounded failure receipt on stdout only.
    }
  }
  dependencies.writeOutput(`${JSON.stringify({
    ok: false,
    candidateSha: args?.candidateSha ?? null,
    checks,
    productionContactAttempted: false,
    secretMaterialIncluded: false,
  })}\n`);
  return 1;
}

export const stagingSupabaseProfilesPrerequisiteInternals = {
  authSettingsShapeExact,
  authorityExact,
  boundedJson,
  parseArguments,
  parsePermanentStagingSupabaseProfilesPrerequisite,
  profilesShapeExact,
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runPermanentStagingSupabaseProfilesPrerequisite();
}
