import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

export const PROTECTED_SUPABASE_CUTOVER_SCHEMA =
  "pintpath-protected-permanent-staging-supabase-cutover/v1" as const;
export const PROTECTED_SUPABASE_CUTOVER_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;

const PROJECT_REF = "bbfibbadwjxzrcdncavy";
const ORIGIN = `https://${PROJECT_REF}.supabase.co`;
const MANAGEMENT_ORIGIN = "https://api.supabase.com";
const BUCKET = "beermap-source-evidence";
const POLICY_PATH =
  "ops/supabase/protected-permanent-staging-supabase-cutover-policy.json";
const CONFIRMATION = "DISABLE_PERMANENT_STAGING_SUPABASE_LEGACY_KEYS";
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const PUBLISHABLE_PATTERN = /^sb_publishable_[A-Za-z0-9_-]{20,220}$/;
const SECRET_PATTERN = /^sb_secret_[A-Za-z0-9_-]{20,220}$/;
const MAX_BODY_BYTES = 64 * 1024;

const POLICY = Object.freeze({
  schemaVersion: "pintpath-protected-permanent-staging-supabase-cutover-policy/v1",
  policyId: "pintpath-permanent-staging-supabase-legacy-cutover",
  activationState: PROTECTED_SUPABASE_CUTOVER_STATE,
  githubEnvironment: "permanent-staging-supabase-legacy-disable",
  target: {
    projectRef: PROJECT_REF,
    origin: ORIGIN,
    privateStorageBucket: BUCKET,
    legacyKeyFamilies: ["anon", "service_role"],
  },
  canaryB: {
    transport: "protected-runner-direct-provider-read-only",
    beforeDisableRequired: true,
    afterDisableRequired: true,
    checks: [
      "replacement-publishable-auth-settings",
      "replacement-secret-admin-list-limit-one",
      "replacement-secret-private-storage-bucket",
    ],
  },
  mutation: {
    method: "PUT",
    path: `/v1/projects/${PROJECT_REF}/api-keys/legacy?enabled=false`,
    operation: "disable-all-legacy-jwt-api-keys",
    maximumAttempts: 1,
    automaticRetriesAllowed: false,
    rerunsAllowed: false,
    unconditionalPostflightRequired: true,
    ambiguousOutcomeAction: "READ_ONLY_RECONCILIATION_STOP_NO_RETRY",
  },
  postflight: {
    exactLegacyState: { enabled: false },
    oldAnonStatus: 401,
    oldServiceRoleStatus: 401,
  },
  authority: {
    requiredGitRef: "refs/heads/main",
    requiredRunAttempt: 1,
    confirmation: CONFIRMATION,
    separateReadAndWriteTokensRequired: true,
  },
  evidence: {
    durableIntentRequiredBeforeAttempt: true,
    secretMaterialAllowed: false,
    secretDerivedCommitmentsAllowed: false,
  },
} as const);

interface Arguments {
  readonly candidateSha: string;
  readonly managementReadTokenFile: string;
  readonly managementWriteTokenFile: string;
  readonly newPublishableKeyFile: string;
  readonly newSecretKeyFile: string;
  readonly oldAnonKeyFile: string;
  readonly oldServiceRoleKeyFile: string;
  readonly evidenceDirectory: string;
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly readSecret: (filename: string) => Buffer;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  inputShapesExact: boolean;
  canaryBBeforeExact: boolean;
  legacyPreflightEnabledExact: boolean;
  oldAnonAcceptedBeforeExact: boolean;
  oldServiceRoleAcceptedBeforeExact: boolean;
  durableIntentExact: boolean;
  writeAttemptedAtMostOnce: boolean;
  disableAcknowledgementExact: boolean;
  postflightAttempted: boolean;
  legacyPostflightDisabledExact: boolean;
  canaryBAfterExact: boolean;
  oldAnonDeniedExact: boolean;
  oldServiceRoleDeniedExact: boolean;
  inputZeroized: boolean;
  terminalEvidenceExact: boolean;
}

interface HttpResult {
  readonly status: number;
  readonly value: unknown;
}

type LegacyKeyFamily = "anon" | "service_role";

interface LegacyKeyProbe {
  readonly family: LegacyKeyFamily;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return record(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function emptyChecks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    inputShapesExact: false,
    canaryBBeforeExact: false,
    legacyPreflightEnabledExact: false,
    oldAnonAcceptedBeforeExact: false,
    oldServiceRoleAcceptedBeforeExact: false,
    durableIntentExact: false,
    writeAttemptedAtMostOnce: true,
    disableAcknowledgementExact: false,
    postflightAttempted: false,
    legacyPostflightDisabledExact: false,
    canaryBAfterExact: false,
    oldAnonDeniedExact: false,
    oldServiceRoleDeniedExact: false,
    inputZeroized: false,
    terminalEvidenceExact: false,
  };
}

function parseArguments(argv: readonly string[]): Arguments | null {
  if (argv.length !== 16) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || values.has(flag)) return null;
    values.set(flag, value);
  }
  const candidateSha = values.get("--candidate-sha") ?? "";
  const managementReadTokenFile = values.get("--management-read-token-file") ?? "";
  const managementWriteTokenFile = values.get("--management-write-token-file") ?? "";
  const newPublishableKeyFile = values.get("--new-publishable-key-file") ?? "";
  const newSecretKeyFile = values.get("--new-secret-key-file") ?? "";
  const oldAnonKeyFile = values.get("--old-anon-key-file") ?? "";
  const oldServiceRoleKeyFile = values.get("--old-service-role-key-file") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const files = [managementReadTokenFile, managementWriteTokenFile,
    newPublishableKeyFile, newSecretKeyFile, oldAnonKeyFile, oldServiceRoleKeyFile];
  return SHA_PATTERN.test(candidateSha)
    && files.every(path.isAbsolute)
    && new Set(files).size === files.length
    && path.isAbsolute(evidenceDirectory)
    ? { candidateSha, managementReadTokenFile, managementWriteTokenFile,
      newPublishableKeyFile, newSecretKeyFile, oldAnonKeyFile,
      oldServiceRoleKeyFile, evidenceDirectory }
    : null;
}

function privateRead(filename: string): Buffer {
  try {
    return readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 4096,
      requireOwner: true,
      requirePrivate: true,
    });
  } catch {
    throw new Error("input_invalid");
  }
}

function durableWrite(directory: string, leaf: string, source: string): string {
  try {
    writePrivateExclusiveFile(directory, leaf, source, { requireOwner: true });
  } catch {
    throw new Error("evidence_invalid");
  }
  return sha256(source);
}

function policyExact(cwd: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(cwd, POLICY_PATH), "utf8")) as unknown;
    return JSON.stringify(parsed) === JSON.stringify(POLICY);
  } catch {
    return false;
  }
}

function decode(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function legacyJwtRole(value: string, role: "anon" | "service_role"): boolean {
  try {
    if (value !== value.trim() || value.length < 64 || value.length > 2048) return false;
    const parts = value.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as unknown;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    return exactKeys(header, ["alg", "typ"]) && header.alg === "HS256" && header.typ === "JWT"
      && record(payload) && payload.role === role && payload.iss === "supabase";
  } catch {
    return false;
  }
}

async function boundedJson(response: Response): Promise<unknown | null> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")
    || !response.body) return null;
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d{1,8}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
    if (length < 2) return null;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<HttpResult | null> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const value = await boundedJson(response);
    return value === null ? null : { status: response.status, value };
  } catch {
    return null;
  }
}

function legacyStateExact(result: HttpResult | null, enabled: boolean): boolean {
  return result?.status === 200
    && exactKeys(result.value, ["enabled"])
    && result.value.enabled === enabled;
}

function authSettingsExact(value: unknown): boolean {
  return record(value) && typeof value.disable_signup === "boolean"
    && record(value.external) && Object.keys(value.external).length >= 1
    && Object.entries(value.external).every(([name, enabled]) =>
      /^[a-z][a-z0-9_]{0,63}$/.test(name) && typeof enabled === "boolean");
}

function adminPageExact(value: unknown): boolean {
  return record(value) && Array.isArray(value.users) && value.users.length <= 1
    && value.users.every(record);
}

function privateBucketExact(value: unknown): boolean {
  if (!record(value) || value.id !== BUCKET || value.name !== BUCKET
    || value.public !== false || !Array.isArray(value.allowed_mime_types)) return false;
  const actual = [...value.allowed_mime_types].sort();
  const expected = ["application/pdf", "image/heic", "image/heif", "image/jpeg",
    "image/png", "image/webp"].sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function replacementCanary(
  fetchImpl: typeof fetch,
  publishableKey: string,
  secretKey: string,
): Promise<boolean> {
  const [settings, admin, bucket] = await Promise.all([
    requestJson(fetchImpl, `${ORIGIN}/auth/v1/settings`, {
      method: "GET", headers: { apikey: publishableKey },
    }),
    requestJson(fetchImpl, `${ORIGIN}/auth/v1/admin/users?page=1&per_page=1`, {
      method: "GET", headers: { apikey: secretKey },
    }),
    requestJson(fetchImpl, `${ORIGIN}/storage/v1/bucket/${BUCKET}`, {
      method: "GET", headers: { apikey: secretKey },
    }),
  ]);
  return settings?.status === 200 && authSettingsExact(settings.value)
    && admin?.status === 200 && adminPageExact(admin.value)
    && bucket?.status === 200 && privateBucketExact(bucket.value);
}

async function legacyState(fetchImpl: typeof fetch, token: string): Promise<HttpResult | null> {
  return requestJson(fetchImpl,
    `${MANAGEMENT_ORIGIN}/v1/projects/${PROJECT_REF}/api-keys/legacy`, {
      method: "GET", headers: { authorization: `Bearer ${token}` },
    });
}

async function disableLegacy(fetchImpl: typeof fetch, token: string): Promise<HttpResult | null> {
  return requestJson(fetchImpl,
    `${MANAGEMENT_ORIGIN}/v1/projects/${PROJECT_REF}/api-keys/legacy?enabled=false`, {
      method: "PUT", headers: { authorization: `Bearer ${token}` },
    });
}

function rejectionExact(result: HttpResult | null): boolean {
  return result?.status === 401
    && exactKeys(result.value, ["message"])
    && result.value.message === "Invalid API key";
}

function legacyKeyProbe(key: string, family: LegacyKeyFamily): LegacyKeyProbe {
  return family === "anon"
    ? {
        family,
        url: `${ORIGIN}/auth/v1/settings`,
        headers: Object.freeze({ apikey: key }),
      }
    : {
        family,
        url: `${ORIGIN}/auth/v1/admin/users?page=1&per_page=1`,
        headers: Object.freeze({
          apikey: key,
          authorization: `Bearer ${key}`,
        }),
      };
}

async function probeLegacyKey(
  fetchImpl: typeof fetch,
  probe: LegacyKeyProbe,
): Promise<HttpResult | null> {
  return requestJson(fetchImpl, probe.url, {
    method: "GET",
    headers: probe.headers,
  });
}

function legacyKeyAcceptedExact(
  result: HttpResult | null,
  family: LegacyKeyFamily,
): boolean {
  return result?.status === 200 && (family === "anon"
    ? authSettingsExact(result.value)
    : adminPageExact(result.value));
}

async function oldKeyDenied(
  fetchImpl: typeof fetch,
  probe: LegacyKeyProbe,
): Promise<boolean> {
  return rejectionExact(await probeLegacyKey(fetchImpl, probe));
}

function receipt(
  outcome: "disabled" | "failed_before_attempt" | "mutation_uncertain",
  attempts: 0 | 1,
  candidateSha: string | null,
  intentSha256: string | null,
  terminalEvidenceSha256: string | null,
  checks: Checks,
) {
  return {
    schemaVersion: PROTECTED_SUPABASE_CUTOVER_SCHEMA,
    executorState: PROTECTED_SUPABASE_CUTOVER_STATE,
    projectRef: PROJECT_REF,
    outcome,
    attempts,
    retryAllowed: false as const,
    candidateSha,
    intentSha256,
    terminalEvidenceSha256,
    secretMaterialIncluded: false as const,
    secretDerivedCommitmentsIncluded: false as const,
    checks,
  };
}

export async function runProtectedPermanentStagingSupabaseCutover(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), fetchImpl: fetch,
    readSecret: privateRead, writeDurable: durableWrite,
    writeOutput: (source) => process.stdout.write(source), ...overrides,
  };
  const args = parseArguments(dependencies.argv);
  const checks = emptyChecks();
  const buffers: Buffer[] = [];
  let attempts: 0 | 1 = 0;
  let outcome: "disabled" | "failed_before_attempt" | "mutation_uncertain" =
    "failed_before_attempt";
  let intentSha: string | null = null;
  let terminalSha: string | null = null;
  let readToken = "";
  let writeToken = "";
  let newPublishable = "";
  let newSecret = "";
  let oldAnon = "";
  let oldServiceRole = "";
  let oldAnonProbe: LegacyKeyProbe | null = null;
  let oldServiceRoleProbe: LegacyKeyProbe | null = null;
  try {
    checks.policyExact = policyExact(dependencies.cwd);
    checks.githubAuthorityExact = args !== null
      && dependencies.env.GITHUB_REF === "refs/heads/main"
      && dependencies.env.GITHUB_SHA === args.candidateSha
      && dependencies.env.GITHUB_RUN_ATTEMPT === "1"
      && dependencies.env.PINTPATH_SUPABASE_CUTOVER_CONFIRMATION === CONFIRMATION;
    if (!args || !checks.policyExact || !checks.githubAuthorityExact) throw new Error("authority_invalid");
    const names = [args.managementReadTokenFile, args.managementWriteTokenFile,
      args.newPublishableKeyFile, args.newSecretKeyFile, args.oldAnonKeyFile,
      args.oldServiceRoleKeyFile];
    buffers.push(...names.map(dependencies.readSecret));
    const decoded = buffers.map(decode);
    readToken = decoded[0]!;
    writeToken = decoded[1]!;
    newPublishable = decoded[2]!;
    newSecret = decoded[3]!;
    oldAnon = decoded[4]!;
    oldServiceRole = decoded[5]!;
    checks.inputShapesExact = readToken.length >= 16 && readToken.length <= 4096
      && writeToken.length >= 16 && writeToken.length <= 4096
      && readToken !== writeToken && !/[\u0000\r\n]/.test(readToken + writeToken)
      && PUBLISHABLE_PATTERN.test(newPublishable) && SECRET_PATTERN.test(newSecret)
      && newPublishable !== newSecret && legacyJwtRole(oldAnon, "anon")
      && legacyJwtRole(oldServiceRole, "service_role") && oldAnon !== oldServiceRole;
    for (const buffer of buffers) buffer.fill(0);
    checks.inputZeroized = buffers.every((buffer) => buffer.every((byte) => byte === 0));
    if (!checks.inputShapesExact || !checks.inputZeroized) throw new Error("input_invalid");
    oldAnonProbe = legacyKeyProbe(oldAnon, "anon");
    oldServiceRoleProbe = legacyKeyProbe(oldServiceRole, "service_role");
    const [canaryBefore, legacyPreflight, oldAnonBefore, oldServiceRoleBefore] =
      await Promise.all([
        replacementCanary(dependencies.fetchImpl, newPublishable, newSecret),
        legacyState(dependencies.fetchImpl, readToken),
        probeLegacyKey(dependencies.fetchImpl, oldAnonProbe),
        probeLegacyKey(dependencies.fetchImpl, oldServiceRoleProbe),
      ]);
    checks.canaryBBeforeExact = canaryBefore;
    checks.legacyPreflightEnabledExact = legacyStateExact(legacyPreflight, true);
    checks.oldAnonAcceptedBeforeExact = legacyKeyAcceptedExact(oldAnonBefore, "anon");
    checks.oldServiceRoleAcceptedBeforeExact = legacyKeyAcceptedExact(
      oldServiceRoleBefore,
      "service_role",
    );
    if (!checks.canaryBBeforeExact || !checks.legacyPreflightEnabledExact
      || !checks.oldAnonAcceptedBeforeExact
      || !checks.oldServiceRoleAcceptedBeforeExact) {
      throw new Error("preflight_invalid");
    }
    const intent = canonical({
      schemaVersion: "pintpath-protected-permanent-staging-supabase-cutover-intent/v1",
      candidateSha: args.candidateSha,
      projectRef: PROJECT_REF,
      legacyKeyFamilies: ["anon", "service_role"],
      operation: "disable-all-legacy-jwt-api-keys",
      maximumAttempts: 1,
      retryAllowed: false,
      replacementCanaryBeforePassed: true,
      legacyPreflightEnabled: true,
      oldAnonAcceptedBeforeDisable: true,
      oldServiceRoleAcceptedBeforeDisable: true,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    intentSha = dependencies.writeDurable(args.evidenceDirectory, "intent.json", intent);
    checks.durableIntentExact = intentSha === sha256(intent);
    if (!checks.durableIntentExact) throw new Error("intent_invalid");
    attempts = 1;
    const acknowledgement = await disableLegacy(dependencies.fetchImpl, writeToken);
    checks.disableAcknowledgementExact = legacyStateExact(acknowledgement, false);
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  } finally {
    for (const buffer of buffers) buffer.fill(0);
    checks.inputZeroized = buffers.length === 6
      && buffers.every((buffer) => buffer.every((byte) => byte === 0));
    if (attempts === 1) {
      checks.postflightAttempted = true;
      checks.legacyPostflightDisabledExact = legacyStateExact(
        await legacyState(dependencies.fetchImpl, readToken), false);
      if (checks.legacyPostflightDisabledExact && oldAnonProbe && oldServiceRoleProbe) {
        const [canaryAfter, anonDenied, serviceRoleDenied] = await Promise.all([
          replacementCanary(dependencies.fetchImpl, newPublishable, newSecret),
          oldKeyDenied(dependencies.fetchImpl, oldAnonProbe),
          oldKeyDenied(dependencies.fetchImpl, oldServiceRoleProbe),
        ]);
        checks.canaryBAfterExact = canaryAfter;
        checks.oldAnonDeniedExact = anonDenied;
        checks.oldServiceRoleDeniedExact = serviceRoleDenied;
      }
      outcome = checks.disableAcknowledgementExact
        && checks.legacyPostflightDisabledExact && checks.canaryBAfterExact
        && checks.oldAnonDeniedExact && checks.oldServiceRoleDeniedExact
        ? "disabled" : "mutation_uncertain";
    }
  }
  const provisional = receipt(outcome, attempts, args?.candidateSha ?? null,
    intentSha, null, checks);
  if (args && checks.durableIntentExact) {
    try {
      const terminal = canonical({
        schemaVersion: "pintpath-protected-permanent-staging-supabase-cutover-terminal/v1",
        receipt: provisional,
      });
      terminalSha = dependencies.writeDurable(args.evidenceDirectory, "terminal.json", terminal);
      checks.terminalEvidenceExact = terminalSha === sha256(terminal);
    } catch {
      checks.terminalEvidenceExact = false;
      if (attempts === 1) outcome = "mutation_uncertain";
    }
  }
  const finalReceipt = receipt(outcome, attempts, args?.candidateSha ?? null,
    intentSha, terminalSha, checks);
  dependencies.writeOutput(`${JSON.stringify(finalReceipt)}\n`);
  return outcome === "disabled" && checks.terminalEvidenceExact ? 0 : 1;
}

export const protectedPermanentStagingSupabaseCutoverInternals = {
  parseArguments,
  legacyJwtRole,
  legacyStateExact,
  rejectionExact,
  legacyKeyProbe,
  legacyKeyAcceptedExact,
  authSettingsExact,
  adminPageExact,
  privateBucketExact,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedPermanentStagingSupabaseCutover();
}
