import fs from "node:fs";
import path from "node:path";

interface EvidenceItem {
  id: string;
  label: string;
  required: boolean | null;
  status: string;
  evidence: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
}

const expectedRequiredIds = [
  "production_public_smoke",
  "production_role_smoke",
  "ocr_labelled_corpus",
  "venue_pilot_one",
  "venue_pilot_two",
  "venue_pilot_three",
  "pos_vendor_pilot",
  "backup_restore",
  "accessibility_devices",
  "legal_billing",
  "ios_release",
  "android_release",
] as const;
const expectedRequiredIdSet = new Set<string>(expectedRequiredIds);
const allowedStatuses = new Set(["pending", "pass", "fail", "not_applicable"]);

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

function normalizedItem(value: unknown, index: number, schemaErrors: string[]): EvidenceItem {
  if (!record(value)) {
    schemaErrors.push(`items[${index}] must be an object`);
    return {
      id: `[items:${index}]`,
      label: "",
      required: null,
      status: "",
      evidence: null,
      verifiedAt: null,
      verifiedBy: null,
    };
  }

  const id = typeof value.id === "string" ? value.id : `[items:${index}]`;
  if (typeof value.id !== "string") schemaErrors.push(`items[${index}].id must be a string`);
  if (typeof value.label !== "string") schemaErrors.push(`items[${index}].label must be a string`);
  if (typeof value.required !== "boolean") schemaErrors.push(`items[${index}].required must be a boolean`);
  if (typeof value.status !== "string") schemaErrors.push(`items[${index}].status must be a string`);
  for (const field of ["evidence", "verifiedAt", "verifiedBy"] as const) {
    if (!nullableString(value[field])) schemaErrors.push(`items[${index}].${field} must be a string or null`);
  }

  return {
    id,
    label: typeof value.label === "string" ? value.label : "",
    required: typeof value.required === "boolean" ? value.required : null,
    status: typeof value.status === "string" ? value.status : "",
    evidence: nullableString(value.evidence) ? value.evidence : null,
    verifiedAt: nullableString(value.verifiedAt) ? value.verifiedAt : null,
    verifiedBy: nullableString(value.verifiedBy) ? value.verifiedBy : null,
  };
}

const filename = path.resolve(process.env.RELEASE_EVIDENCE_PATH || "docs/release-evidence.json");
const strict = process.argv.includes("--strict");
const schemaErrors: string[] = [];
let raw: unknown = null;
try {
  raw = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
} catch (error) {
  schemaErrors.push(error instanceof Error ? `Invalid JSON: ${error.message}` : "Invalid JSON");
}

const root = record(raw) ? raw : null;
if (!root) schemaErrors.push("Evidence root must be an object");
if (root?.version !== 1) schemaErrors.push("Evidence version must equal 1");
if (!Array.isArray(root?.items)) schemaErrors.push("Evidence items must be an array");
const rawItems = Array.isArray(root?.items) ? root.items : [];
const items = rawItems.map((item, index) => normalizedItem(item, index, schemaErrors));
const invalid = items.filter((item) =>
  !nonEmpty(item.id)
  || !nonEmpty(item.label)
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
const incomplete = items.filter((item) => item.required === true && item.status !== "pass");
const unsupportedPasses = items.filter((item) => item.status === "pass" && (
  !nonEmpty(item.evidence)
  || !isoTimestamp(item.verifiedAt)
  || !nonEmpty(item.verifiedBy)
));
const valid = schemaErrors.length === 0
  && invalid.length === 0
  && duplicateIds.length === 0
  && missingRequiredIds.length === 0
  && unexpectedIds.length === 0
  && misconfiguredRequiredIds.length === 0
  && unsupportedPasses.length === 0;
const launchReady = valid && incomplete.length === 0;

console.log(JSON.stringify({
  ok: launchReady,
  valid,
  launchReady,
  strict,
  summary: {
    total: items.length,
    passed: items.filter((item) => item.status === "pass").length,
    pending: items.filter((item) => item.status === "pending").length,
    failed: items.filter((item) => item.status === "fail").length,
    requiredIncomplete: incomplete.length,
  },
  schemaErrors,
  invalid: invalid.map((item) => item.id),
  duplicateIds,
  missingRequiredIds,
  unexpectedIds,
  misconfiguredRequiredIds,
  unsupportedPasses: unsupportedPasses.map((item) => item.id),
  incomplete: incomplete.map((item) => ({ id: item.id, label: item.label, status: item.status })),
}, null, 2));

if (!valid || (strict && incomplete.length)) process.exitCode = 1;
