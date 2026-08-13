import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface ReleaseMetadata {
  id: string | null;
  candidateSha: string | null;
  environment: string;
}

interface EvidenceItem {
  id: string;
  label: string;
  owner: string;
  nextAction: string;
  required: boolean | null;
  status: string;
  evidence: string | null;
  evidenceSha256: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  costReceipt: unknown | null;
}

interface PermanentStagingCostProviderObservation {
  provider: string;
  inventorySha256: string;
  priceOrCapEvidenceSha256: string;
  inventoryComplete: boolean;
  upperBoundComplete: boolean;
  unknownResourceCount: number;
  unpricedResourceCount: number;
  sharedResourceCount: number;
  unboundedResourceCount: number;
  upperBoundMonthlyCents: number;
}

interface PermanentStagingExcludedCostScope {
  scope: string;
  includedInPermanentStagingTotal: boolean;
  handling: string;
  evidenceSha256: string;
}

interface PermanentStagingCostReceipt {
  schemaVersion: string;
  releaseId: string;
  candidateSha: string;
  gateId: string;
  environment: string;
  scope: string;
  currency: string;
  amountUnit: string;
  lineItemRounding: string;
  observationSource: string;
  providerObservationBindingImplemented: boolean;
  policySha256: string;
  observedAt: string;
  privateManifestSha256: string;
  totalUpperBoundMonthlyCents: number;
  providers: PermanentStagingCostProviderObservation[];
  excludedScopes: PermanentStagingExcludedCostScope[];
}

const expectedRequiredIds = [
  "production_public_smoke",
  "production_role_smoke",
  "account_deletion_completion_notice",
  "ocr_labelled_corpus",
  "venue_pilot_one",
  "venue_pilot_two",
  "venue_pilot_three",
  "moderation_operations",
  "backup_restore",
  "accessibility_devices",
  "legal_billing",
  "ios_release",
  "permanent_staging_cost",
] as const;
const expectedRequiredIdSet = new Set<string>(expectedRequiredIds);
const allowedStatuses = new Set(["pending", "pass", "fail", "not_applicable"]);
const expectedRootFields = new Set(["version", "release", "items"]);
const expectedReleaseFields = new Set(["id", "candidateSha", "environment"]);
const expectedItemFields = new Set([
  "id",
  "label",
  "owner",
  "nextAction",
  "required",
  "status",
  "evidence",
  "evidenceSha256",
  "verifiedAt",
  "verifiedBy",
]);
const expectedCostItemFields = new Set([...expectedItemFields, "costReceipt"]);
const expectedCostReceiptFields = new Set([
  "schemaVersion",
  "releaseId",
  "candidateSha",
  "gateId",
  "environment",
  "scope",
  "currency",
  "amountUnit",
  "lineItemRounding",
  "observationSource",
  "providerObservationBindingImplemented",
  "policySha256",
  "observedAt",
  "privateManifestSha256",
  "totalUpperBoundMonthlyCents",
  "providers",
  "excludedScopes",
]);
const expectedCostProviderFields = new Set([
  "provider",
  "inventorySha256",
  "priceOrCapEvidenceSha256",
  "inventoryComplete",
  "upperBoundComplete",
  "unknownResourceCount",
  "unpricedResourceCount",
  "sharedResourceCount",
  "unboundedResourceCount",
  "upperBoundMonthlyCents",
]);
const expectedExcludedCostScopeFields = new Set([
  "scope",
  "includedInPermanentStagingTotal",
  "handling",
  "evidenceSha256",
]);
const expectedCostProviders = ["railway", "staging-supabase", "staging-external-providers"] as const;
const expectedExcludedCostScopes = new Map<string, string>([
  ["production-operational-copy", "separate-production-cost-authority"],
  ["disposable-restore", "separate-temporary-spend-authority"],
]);
const permanentStagingCostReceiptSchema = "pintpath-permanent-staging-cost-receipt/v1";
const permanentStagingCostPolicyPath = path.resolve(
  "ops/railway/permanent-staging-cost-policy.json",
);
const permanentStagingCostPolicySha256 =
  "895d5bdcfe0fb05d17b3fa7cab6c525a80f3beacf0ff0cbd1bafdb54c979c8ca";
const maximumPermanentStagingMonthlyCents = 5_000;
const releaseIdPattern = /^PP-LAUNCH-\d{4}-[A-Z0-9][A-Z0-9_-]{2,31}$/;
const commitShaPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const liveEvidenceMaxAgeMs = 24 * 60 * 60 * 1000;
const futureClockSkewMs = 5 * 60 * 1000;

const record = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === "object"
  && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

function isoTimestamp(value: unknown): value is string {
  if (!nonEmpty(value)) return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[9]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[10]);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;

  return year >= 1
    && month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth
    && hour >= 0
    && hour <= 23
    && minute >= 0
    && minute <= 59
    && second >= 0
    && second <= 59
    && offsetHour >= 0
    && offsetHour <= 14
    && offsetMinute >= 0
    && offsetMinute <= 59
    && (offsetHour < 14 || offsetMinute === 0)
    && !Number.isNaN(Date.parse(value));
}

function namedVerifier(value: unknown): value is string {
  if (!nonEmpty(value)) return false;
  const separator = value.indexOf(",");
  return separator >= 2
    && value.slice(0, separator).trim().length >= 2
    && value.slice(separator + 1).trim().length >= 2;
}

function unexpectedKeys(
  value: Record<string, unknown>,
  expected: Set<string>,
  prefix: string,
): string[] {
  return Object.keys(value)
    .filter((key) => !expected.has(key))
    .map((key) => `${prefix}.${key}`);
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function inspectPermanentStagingCostPolicy(): {
  sha256: string | null;
  collectorImplemented: boolean;
  bindingImplemented: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  let source: Buffer;
  try {
    source = fs.readFileSync(permanentStagingCostPolicyPath);
  } catch {
    return {
      sha256: null,
      collectorImplemented: false,
      bindingImplemented: false,
      errors: ["unable to read the permanent-staging cost policy"],
    };
  }
  const sha256 = crypto.createHash("sha256").update(source).digest("hex");
  if (sha256 !== permanentStagingCostPolicySha256) {
    errors.push("checked-in permanent-staging cost policy is not the reviewed canonical policy");
  }
  let policy: unknown;
  try {
    policy = JSON.parse(source.toString("utf8")) as unknown;
  } catch {
    policy = null;
    errors.push("checked-in permanent-staging cost policy is invalid JSON");
  }
  const evidenceContract = record(policy) && record(policy.evidenceContract)
    ? policy.evidenceContract
    : null;
  const collectorImplemented = evidenceContract?.providerCollectorImplemented === true;
  const bindingImplemented = evidenceContract?.providerObservationBindingImplemented === true;
  if (!collectorImplemented) {
    errors.push("permanent-staging cost provider collector is not implemented by policy");
  }
  if (!bindingImplemented) {
    errors.push("permanent-staging cost provider observation binding is not implemented by policy");
  }
  return { sha256, collectorImplemented, bindingImplemented, errors };
}

function parsePermanentStagingCostReceipt(
  value: unknown,
  release: ReleaseMetadata,
  evidenceSha256: string | null,
): { receipt: PermanentStagingCostReceipt | null; errors: string[] } {
  const errors: string[] = [];
  if (!record(value)) return { receipt: null, errors: ["costReceipt must be an object"] };

  errors.push(...unexpectedKeys(value, expectedCostReceiptFields, "costReceipt"));
  for (const field of [
    "schemaVersion",
    "releaseId",
    "candidateSha",
    "gateId",
    "environment",
    "scope",
    "currency",
    "amountUnit",
    "lineItemRounding",
    "observationSource",
    "policySha256",
    "observedAt",
    "privateManifestSha256",
  ] as const) {
    if (typeof value[field] !== "string") errors.push(`costReceipt.${field} must be a string`);
  }
  if (typeof value.providerObservationBindingImplemented !== "boolean") {
    errors.push("costReceipt.providerObservationBindingImplemented must be a boolean");
  }
  if (!safeNonNegativeInteger(value.totalUpperBoundMonthlyCents)) {
    errors.push("costReceipt.totalUpperBoundMonthlyCents must be non-negative integer cents");
  }
  if (!Array.isArray(value.providers)) errors.push("costReceipt.providers must be an array");
  if (!Array.isArray(value.excludedScopes)) errors.push("costReceipt.excludedScopes must be an array");
  if (errors.length > 0) return { receipt: null, errors };

  const providers: PermanentStagingCostProviderObservation[] = [];
  for (const [index, providerValue] of (value.providers as unknown[]).entries()) {
    const prefix = `costReceipt.providers[${index}]`;
    if (!record(providerValue)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    errors.push(...unexpectedKeys(providerValue, expectedCostProviderFields, prefix));
    if (typeof providerValue.provider !== "string") errors.push(`${prefix}.provider must be a string`);
    for (const field of ["inventorySha256", "priceOrCapEvidenceSha256"] as const) {
      if (typeof providerValue[field] !== "string" || !sha256Pattern.test(providerValue[field])) {
        errors.push(`${prefix}.${field} must be a lowercase SHA-256`);
      }
    }
    for (const field of ["inventoryComplete", "upperBoundComplete"] as const) {
      if (typeof providerValue[field] !== "boolean") errors.push(`${prefix}.${field} must be a boolean`);
    }
    for (const field of [
      "unknownResourceCount",
      "unpricedResourceCount",
      "sharedResourceCount",
      "unboundedResourceCount",
      "upperBoundMonthlyCents",
    ] as const) {
      if (!safeNonNegativeInteger(providerValue[field])) {
        errors.push(`${prefix}.${field} must be non-negative integer cents/count`);
      }
    }
    if (errors.some((error) => error.startsWith(prefix))) continue;
    providers.push(providerValue as unknown as PermanentStagingCostProviderObservation);
  }

  const excludedScopes: PermanentStagingExcludedCostScope[] = [];
  for (const [index, excludedValue] of (value.excludedScopes as unknown[]).entries()) {
    const prefix = `costReceipt.excludedScopes[${index}]`;
    if (!record(excludedValue)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    errors.push(...unexpectedKeys(excludedValue, expectedExcludedCostScopeFields, prefix));
    for (const field of ["scope", "handling"] as const) {
      if (typeof excludedValue[field] !== "string") errors.push(`${prefix}.${field} must be a string`);
    }
    if (typeof excludedValue.includedInPermanentStagingTotal !== "boolean") {
      errors.push(`${prefix}.includedInPermanentStagingTotal must be a boolean`);
    }
    if (
      typeof excludedValue.evidenceSha256 !== "string"
      || !sha256Pattern.test(excludedValue.evidenceSha256)
    ) errors.push(`${prefix}.evidenceSha256 must be a lowercase SHA-256`);
    if (errors.some((error) => error.startsWith(prefix))) continue;
    excludedScopes.push(excludedValue as unknown as PermanentStagingExcludedCostScope);
  }
  if (errors.length > 0) return { receipt: null, errors };

  if (value.schemaVersion !== permanentStagingCostReceiptSchema) {
    errors.push(`costReceipt.schemaVersion must equal ${permanentStagingCostReceiptSchema}`);
  }
  if (value.releaseId !== release.id) errors.push("costReceipt.releaseId must match release.id");
  if (value.candidateSha !== release.candidateSha) {
    errors.push("costReceipt.candidateSha must match release.candidateSha");
  }
  if (value.gateId !== "permanent_staging_cost") {
    errors.push("costReceipt.gateId must equal permanent_staging_cost");
  }
  if (value.environment !== "permanent-staging") {
    errors.push("costReceipt.environment must equal permanent-staging");
  }
  if (value.scope !== "permanent-staging-only") {
    errors.push("costReceipt.scope must equal permanent-staging-only");
  }
  if (value.currency !== "USD") errors.push("costReceipt.currency must equal USD");
  if (value.amountUnit !== "integer-cents") {
    errors.push("costReceipt.amountUnit must equal integer-cents");
  }
  if (value.lineItemRounding !== "ceiling") {
    errors.push("costReceipt.lineItemRounding must equal ceiling");
  }
  if (value.observationSource !== "provider-observed") {
    errors.push("costReceipt.observationSource must equal provider-observed");
  }
  if (value.providerObservationBindingImplemented !== true) {
    errors.push("costReceipt.providerObservationBindingImplemented must equal true");
  }
  if (!sha256Pattern.test(value.policySha256 as string)) {
    errors.push("costReceipt.policySha256 must be a lowercase SHA-256");
  }
  if (!isoTimestamp(value.observedAt)) {
    errors.push("costReceipt.observedAt must be a valid ISO-8601 timestamp");
  }
  if (!sha256Pattern.test(value.privateManifestSha256 as string)) {
    errors.push("costReceipt.privateManifestSha256 must be a lowercase SHA-256");
  }
  if (value.privateManifestSha256 !== evidenceSha256) {
    errors.push("costReceipt.privateManifestSha256 must match evidenceSha256");
  }

  const policy = inspectPermanentStagingCostPolicy();
  errors.push(...policy.errors);
  if (policy.sha256 !== null && value.policySha256 !== policy.sha256) {
    errors.push("costReceipt.policySha256 must match the checked-in cost policy");
  }

  const providerNames = providers.map((provider) => provider.provider);
  if (
    providerNames.length !== expectedCostProviders.length
    || new Set(providerNames).size !== providerNames.length
    || expectedCostProviders.some((provider) => !providerNames.includes(provider))
  ) errors.push("costReceipt.providers must contain exactly Railway, staging Supabase, and staging external providers");
  for (const provider of providers) {
    if (!provider.inventoryComplete) errors.push(`${provider.provider} inventory is incomplete`);
    if (!provider.upperBoundComplete) errors.push(`${provider.provider} upper bound is incomplete`);
    if (provider.unknownResourceCount !== 0) errors.push(`${provider.provider} has unknown resources`);
    if (provider.unpricedResourceCount !== 0) errors.push(`${provider.provider} has unpriced resources`);
    if (provider.sharedResourceCount !== 0) errors.push(`${provider.provider} has shared resources`);
    if (provider.unboundedResourceCount !== 0) errors.push(`${provider.provider} has unbounded resources`);
  }
  const summedUpperBound = providers.reduce(
    (sum, provider) => sum + provider.upperBoundMonthlyCents,
    0,
  );
  if (!Number.isSafeInteger(summedUpperBound)) errors.push("costReceipt provider total overflows integer cents");
  if (value.totalUpperBoundMonthlyCents !== summedUpperBound) {
    errors.push("costReceipt.totalUpperBoundMonthlyCents must equal the provider sum");
  }
  if ((value.totalUpperBoundMonthlyCents as number) > maximumPermanentStagingMonthlyCents) {
    errors.push("costReceipt.totalUpperBoundMonthlyCents exceeds 5000 USD cents");
  }

  const excludedByScope = new Map(excludedScopes.map((scope) => [scope.scope, scope]));
  if (
    excludedScopes.length !== expectedExcludedCostScopes.size
    || excludedByScope.size !== excludedScopes.length
  ) errors.push("costReceipt.excludedScopes must contain exactly two separate cost authorities");
  for (const [scope, handling] of expectedExcludedCostScopes) {
    const entry = excludedByScope.get(scope);
    if (!entry) {
      errors.push(`costReceipt.excludedScopes is missing ${scope}`);
    } else if (entry.includedInPermanentStagingTotal || entry.handling !== handling) {
      errors.push(`${scope} must be excluded under its exact separate cost authority`);
    }
  }

  return {
    receipt: value as unknown as PermanentStagingCostReceipt,
    errors,
  };
}

function normalizedRelease(value: unknown, schemaErrors: string[], unexpectedFields: string[]): ReleaseMetadata {
  if (!record(value)) {
    schemaErrors.push("release must be an object");
    return { id: null, candidateSha: null, environment: "" };
  }
  unexpectedFields.push(...unexpectedKeys(value, expectedReleaseFields, "release"));
  for (const field of ["id", "candidateSha"] as const) {
    if (!nullableString(value[field])) schemaErrors.push(`release.${field} must be a string or null`);
  }
  if (typeof value.environment !== "string") schemaErrors.push("release.environment must be a string");
  return {
    id: nullableString(value.id) ? value.id : null,
    candidateSha: nullableString(value.candidateSha) ? value.candidateSha : null,
    environment: typeof value.environment === "string" ? value.environment : "",
  };
}

function normalizedItem(
  value: unknown,
  index: number,
  schemaErrors: string[],
  unexpectedFields: string[],
): EvidenceItem {
  if (!record(value)) {
    schemaErrors.push(`items[${index}] must be an object`);
    return {
      id: `[items:${index}]`,
      label: "",
      owner: "",
      nextAction: "",
      required: null,
      status: "",
      evidence: null,
      evidenceSha256: null,
      verifiedAt: null,
      verifiedBy: null,
      costReceipt: null,
    };
  }

  const id = typeof value.id === "string" ? value.id : `[items:${index}]`;
  unexpectedFields.push(...unexpectedKeys(
    value,
    id === "permanent_staging_cost" ? expectedCostItemFields : expectedItemFields,
    `items[${index}]`,
  ));
  for (const field of ["id", "label", "owner", "nextAction", "status"] as const) {
    if (typeof value[field] !== "string") schemaErrors.push(`items[${index}].${field} must be a string`);
  }
  if (typeof value.required !== "boolean") schemaErrors.push(`items[${index}].required must be a boolean`);
  for (const field of ["evidence", "evidenceSha256", "verifiedAt", "verifiedBy"] as const) {
    if (!nullableString(value[field])) schemaErrors.push(`items[${index}].${field} must be a string or null`);
  }
  if (id === "permanent_staging_cost" && !("costReceipt" in value)) {
    schemaErrors.push(`items[${index}].costReceipt is required`);
  }
  if (
    id === "permanent_staging_cost"
    && value.costReceipt !== null
    && !record(value.costReceipt)
  ) schemaErrors.push(`items[${index}].costReceipt must be an object or null`);
  if (
    id === "permanent_staging_cost"
    && value.status !== "pass"
    && value.costReceipt !== null
  ) schemaErrors.push(`items[${index}].costReceipt must be null unless status is pass`);

  return {
    id,
    label: typeof value.label === "string" ? value.label : "",
    owner: typeof value.owner === "string" ? value.owner : "",
    nextAction: typeof value.nextAction === "string" ? value.nextAction : "",
    required: typeof value.required === "boolean" ? value.required : null,
    status: typeof value.status === "string" ? value.status : "",
    evidence: nullableString(value.evidence) ? value.evidence : null,
    evidenceSha256: nullableString(value.evidenceSha256) ? value.evidenceSha256 : null,
    verifiedAt: nullableString(value.verifiedAt) ? value.verifiedAt : null,
    verifiedBy: nullableString(value.verifiedBy) ? value.verifiedBy : null,
    costReceipt: record(value.costReceipt)
      ? value.costReceipt
      : null,
  };
}

function runGit(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  return {
    ok: result.status === 0,
    output: result.status === 0 ? result.stdout.trim() : result.stderr.trim(),
  };
}

const defaultFilename = path.resolve("docs/release-evidence.json");
const filename = path.resolve(process.env.RELEASE_EVIDENCE_PATH || defaultFilename);
const validatesRepositoryFile = filename === defaultFilename;
const strict = process.argv.includes("--strict");
const schemaErrors: string[] = [];
const unexpectedFields: string[] = [];
let raw: unknown = null;
try {
  raw = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
} catch (error) {
  schemaErrors.push(error instanceof Error ? `Invalid JSON: ${error.message}` : "Invalid JSON");
}

const root = record(raw) ? raw : null;
if (!root) schemaErrors.push("Evidence root must be an object");
if (root) unexpectedFields.push(...unexpectedKeys(root, expectedRootFields, "root"));
if (root?.version !== 3) schemaErrors.push("Evidence version must equal 3");
if (!Array.isArray(root?.items)) schemaErrors.push("Evidence items must be an array");
const release = normalizedRelease(root?.release, schemaErrors, unexpectedFields);
const rawItems = Array.isArray(root?.items) ? root.items : [];
const items = rawItems.map((item, index) => normalizedItem(item, index, schemaErrors, unexpectedFields));
const invalid = items.filter((item) =>
  !nonEmpty(item.id)
  || !nonEmpty(item.label)
  || !nonEmpty(item.owner)
  || !nonEmpty(item.nextAction)
  || typeof item.required !== "boolean"
  || !allowedStatuses.has(item.status),
);
const duplicateIds = [...new Set(items
  .map((item) => item.id)
  .filter((id, index, ids) => ids.indexOf(id) !== index))];
const missingRequiredIds = expectedRequiredIds.filter((id) => !items.some((item) => item.id === id));
const unexpectedIds = items
  .map((item) => item.id)
  .filter((id) => !expectedRequiredIdSet.has(id));
const misconfiguredRequiredIds = expectedRequiredIds.filter((id) =>
  items.some((item) => item.id === id && item.required !== true),
);
const invalidNotApplicable = items.filter((item) => item.required === true && item.status === "not_applicable");
const incomplete = items.filter((item) => item.required === true && item.status !== "pass");
const completed = items.filter((item) => item.status === "pass" || item.status === "fail");
const pendingWithProof = items.filter((item) =>
  (item.status === "pending" || item.status === "not_applicable")
  && [item.evidence, item.evidenceSha256, item.verifiedAt, item.verifiedBy, item.costReceipt]
    .some((field) => field !== null),
);
const unexpectedCostReceiptIds = items
  .filter((item) => item.id !== "permanent_staging_cost" && item.costReceipt !== null)
  .map((item) => item.id);

const releaseMetadataErrors: string[] = [];
if (release.environment !== "production") releaseMetadataErrors.push("release.environment must equal production");
if ((release.id === null) !== (release.candidateSha === null)) {
  releaseMetadataErrors.push("release.id and release.candidateSha must both be null or both be set");
}
if (release.id !== null && !releaseIdPattern.test(release.id)) {
  releaseMetadataErrors.push("release.id must match PP-LAUNCH-YYYY-ID using uppercase letters, digits, underscores, or hyphens");
}
if (release.candidateSha !== null && !commitShaPattern.test(release.candidateSha)) {
  releaseMetadataErrors.push("release.candidateSha must be a full lowercase 40-character Git commit SHA");
}
if (completed.length > 0 && (release.id === null || release.candidateSha === null)) {
  releaseMetadataErrors.push("Completed evidence requires a release ID and frozen candidate SHA");
}

const unsupportedProof = completed.filter((item) => {
  const expectedEvidence = release.id ? `${release.id}/${item.id}` : null;
  return !expectedEvidence
    || item.evidence !== expectedEvidence
    || !nonEmpty(item.evidenceSha256)
    || !sha256Pattern.test(item.evidenceSha256)
    || !isoTimestamp(item.verifiedAt)
    || !namedVerifier(item.verifiedBy);
});

const now = Date.now();
const futureEvidence = completed.filter((item) =>
  isoTimestamp(item.verifiedAt) && Date.parse(item.verifiedAt) > now + futureClockSkewMs,
);
const permanentStagingCostItem = items.find((item) => item.id === "permanent_staging_cost");
const permanentStagingCostReceiptErrors: string[] = [];
const stalePermanentStagingCostReceipt: string[] = [];
let permanentStagingCostReceipt: PermanentStagingCostReceipt | null = null;
if (permanentStagingCostItem?.status === "pass") {
  const result = parsePermanentStagingCostReceipt(
    permanentStagingCostItem.costReceipt,
    release,
    permanentStagingCostItem.evidenceSha256,
  );
  permanentStagingCostReceipt = result.receipt;
  permanentStagingCostReceiptErrors.push(...result.errors);
}
if (
  permanentStagingCostReceipt
  && isoTimestamp(permanentStagingCostReceipt.observedAt)
  && Date.parse(permanentStagingCostReceipt.observedAt) > now + futureClockSkewMs
) permanentStagingCostReceiptErrors.push("costReceipt.observedAt is in the future");
if (
  permanentStagingCostReceipt
  && isoTimestamp(permanentStagingCostReceipt.observedAt)
  && now - Date.parse(permanentStagingCostReceipt.observedAt) > liveEvidenceMaxAgeMs
) stalePermanentStagingCostReceipt.push("permanent_staging_cost");
if (
  permanentStagingCostReceipt
  && isoTimestamp(permanentStagingCostReceipt.observedAt)
  && isoTimestamp(permanentStagingCostItem?.verifiedAt)
  && Date.parse(permanentStagingCostReceipt.observedAt)
    > Date.parse(permanentStagingCostItem.verifiedAt) + futureClockSkewMs
) permanentStagingCostReceiptErrors.push("costReceipt.observedAt must not postdate verification");
const staleLiveEvidence = completed.filter((item) =>
  item.status === "pass"
  && (
    item.id === "production_public_smoke"
    || item.id === "production_role_smoke"
    || item.id === "permanent_staging_cost"
  )
  && isoTimestamp(item.verifiedAt)
  && now - Date.parse(item.verifiedAt) > liveEvidenceMaxAgeMs,
);

const repositoryBindingErrors: string[] = [];
const staleCodePaths: string[] = [];
const dirtyPaths: string[] = [];
const evidenceBeforeCandidate = new Set<string>();
if (release.candidateSha && commitShaPattern.test(release.candidateSha)) {
  const candidateExists = runGit(["cat-file", "-e", `${release.candidateSha}^{commit}`]);
  if (!candidateExists.ok) {
    repositoryBindingErrors.push("release.candidateSha is not a commit in this repository");
  } else {
    const ancestor = runGit(["merge-base", "--is-ancestor", release.candidateSha, "HEAD"]);
    if (!ancestor.ok) {
      repositoryBindingErrors.push("release.candidateSha is not an ancestor of the current commit");
    } else {
      const changed = runGit(["diff", "--name-only", `${release.candidateSha}..HEAD`]);
      if (!changed.ok) {
        repositoryBindingErrors.push("Unable to compare the candidate with the current commit");
      } else {
        staleCodePaths.push(...changed.output.split("\n").filter((entry) => entry && entry !== "docs/release-evidence.json"));
      }
    }

    const commitTime = runGit(["show", "-s", "--format=%cI", release.candidateSha]);
    if (!commitTime.ok || Number.isNaN(Date.parse(commitTime.output))) {
      repositoryBindingErrors.push("Unable to read the candidate commit timestamp");
    } else {
      const candidateTimestamp = Date.parse(commitTime.output);
      for (const item of completed) {
        if (isoTimestamp(item.verifiedAt) && Date.parse(item.verifiedAt) < candidateTimestamp) {
          evidenceBeforeCandidate.add(item.id);
        }
      }
      if (
        permanentStagingCostReceipt
        && isoTimestamp(permanentStagingCostReceipt.observedAt)
        && Date.parse(permanentStagingCostReceipt.observedAt) < candidateTimestamp
      ) permanentStagingCostReceiptErrors.push("costReceipt.observedAt predates the frozen candidate");
    }

    if (validatesRepositoryFile && completed.length > 0) {
      const workingTreeCommands = [
        ["diff", "--name-only"],
        ["diff", "--cached", "--name-only"],
        ["ls-files", "--others", "--exclude-standard"],
      ];
      for (const args of workingTreeCommands) {
        const result = runGit(args);
        if (!result.ok) {
          repositoryBindingErrors.push("Unable to verify the release-evidence working tree");
          break;
        }
        dirtyPaths.push(...result.output.split("\n").filter((entry) => entry && entry !== "docs/release-evidence.json"));
      }
    }
  }
}

const uniqueStaleCodePaths = [...new Set(staleCodePaths)];
const uniqueDirtyPaths = [...new Set(dirtyPaths)];
const valid = schemaErrors.length === 0
  && unexpectedFields.length === 0
  && invalid.length === 0
  && duplicateIds.length === 0
  && missingRequiredIds.length === 0
  && unexpectedIds.length === 0
  && misconfiguredRequiredIds.length === 0
  && invalidNotApplicable.length === 0
  && pendingWithProof.length === 0
  && unexpectedCostReceiptIds.length === 0
  && unsupportedProof.length === 0
  && futureEvidence.length === 0
  && permanentStagingCostReceiptErrors.length === 0
  && releaseMetadataErrors.length === 0
  && repositoryBindingErrors.length === 0
  && evidenceBeforeCandidate.size === 0;
const evidenceCurrent = staleLiveEvidence.length === 0
  && stalePermanentStagingCostReceipt.length === 0
  && uniqueStaleCodePaths.length === 0
  && uniqueDirtyPaths.length === 0;
const launchReady = valid && evidenceCurrent && incomplete.length === 0;

console.log(JSON.stringify({
  ok: launchReady,
  valid,
  evidenceCurrent,
  launchReady,
  strict,
  release,
  summary: {
    total: items.length,
    passed: items.filter((item) => item.status === "pass").length,
    pending: items.filter((item) => item.status === "pending").length,
    failed: items.filter((item) => item.status === "fail").length,
    requiredIncomplete: incomplete.length,
    blockingEvidenceIssues: staleLiveEvidence.length
      + stalePermanentStagingCostReceipt.length
      + uniqueStaleCodePaths.length
      + uniqueDirtyPaths.length,
  },
  schemaErrors,
  unexpectedFields,
  invalid: invalid.map((item) => item.id),
  duplicateIds,
  missingRequiredIds,
  unexpectedIds,
  misconfiguredRequiredIds,
  invalidNotApplicable: invalidNotApplicable.map((item) => item.id),
  pendingWithProof: pendingWithProof.map((item) => item.id),
  unexpectedCostReceiptIds,
  unsupportedProof: unsupportedProof.map((item) => item.id),
  permanentStagingCostReceiptErrors,
  futureEvidence: futureEvidence.map((item) => item.id),
  staleLiveEvidence: staleLiveEvidence.map((item) => item.id),
  stalePermanentStagingCostReceipt,
  evidenceBeforeCandidate: [...evidenceBeforeCandidate],
  releaseMetadataErrors,
  repositoryBindingErrors,
  staleCodePaths: uniqueStaleCodePaths,
  dirtyPaths: uniqueDirtyPaths,
  incomplete: incomplete.map((item) => ({
    id: item.id,
    label: item.label,
    status: item.status,
    owner: item.owner,
    nextAction: item.nextAction,
  })),
}, null, 2));

if (!valid || (strict && !launchReady)) process.exitCode = 1;
