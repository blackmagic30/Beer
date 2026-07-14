import { spawnSync } from "node:child_process";
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
    };
  }

  unexpectedFields.push(...unexpectedKeys(value, expectedItemFields, `items[${index}]`));
  const id = typeof value.id === "string" ? value.id : `[items:${index}]`;
  for (const field of ["id", "label", "owner", "nextAction", "status"] as const) {
    if (typeof value[field] !== "string") schemaErrors.push(`items[${index}].${field} must be a string`);
  }
  if (typeof value.required !== "boolean") schemaErrors.push(`items[${index}].required must be a boolean`);
  for (const field of ["evidence", "evidenceSha256", "verifiedAt", "verifiedBy"] as const) {
    if (!nullableString(value[field])) schemaErrors.push(`items[${index}].${field} must be a string or null`);
  }

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
if (root?.version !== 2) schemaErrors.push("Evidence version must equal 2");
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
  && [item.evidence, item.evidenceSha256, item.verifiedAt, item.verifiedBy].some((field) => field !== null),
);

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
const staleLiveEvidence = completed.filter((item) =>
  item.status === "pass"
  && (item.id === "production_public_smoke" || item.id === "production_role_smoke")
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
  && unsupportedProof.length === 0
  && futureEvidence.length === 0
  && releaseMetadataErrors.length === 0
  && repositoryBindingErrors.length === 0
  && evidenceBeforeCandidate.size === 0;
const evidenceCurrent = staleLiveEvidence.length === 0
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
    blockingEvidenceIssues: staleLiveEvidence.length + uniqueStaleCodePaths.length + uniqueDirtyPaths.length,
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
  unsupportedProof: unsupportedProof.map((item) => item.id),
  futureEvidence: futureEvidence.map((item) => item.id),
  staleLiveEvidence: staleLiveEvidence.map((item) => item.id),
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
