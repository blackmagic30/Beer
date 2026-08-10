import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { z } from "zod";

import { AdminIngestionQueueRepository } from "../src/db/admin-ingestion-queue.repository.js";
import type { AdminIngestionQueueRecord } from "../src/db/models.js";
import type { SqlDatabase } from "../src/db/sql-database.js";
import { redactSecrets } from "../src/lib/redact.js";
import {
  REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS,
  REVIEWED_PRICE_SELECTION_POLICY_SHA256,
  selectPublishableMapBaseRows,
  type ReviewedPriceSelectionOptions,
} from "../src/lib/reviewed-price-selection-policy.js";
import type { AdminService } from "../src/modules/admin/admin.service.js";
import type { AdminBeerInput } from "../src/modules/admin/admin.schemas.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

const MANIFEST_KIND = "pintpath-reviewed-price-promotion-manifest";
const RECEIPT_KIND = "pintpath-reviewed-price-promotion-receipt";
const QUARANTINE_RECEIPT_KIND = "pintpath-reviewed-price-quarantine-receipt";
const LEGACY_SQLITE_APPLY_DISABLED_ERROR =
  "Legacy SQLite reviewed-price apply is disabled; PostgreSQL promotion is required.";
const LEGACY_SQLITE_QUARANTINE_DISABLED_ERROR =
  "Legacy SQLite reviewed-price quarantine is disabled; PostgreSQL quarantine is required.";
export const PRODUCTION_SUPABASE_PROJECT_REF = "jxpubqlmqnnqwadmjgyk";
const QUARANTINED_SOURCE_TYPE = "source_ingestion_quarantined";
const MAX_ITEMS_PER_PROMOTION = 50;
const MAX_BACKUP_AGE_MS = 30 * 60 * 1000;
const SOURCE_CHECK_TIMEOUT_MS = 8_000;
const MAX_SOURCE_REDIRECTS = 4;
const TRUSTED_PUBLIC_CONFIDENCE = [
  "admin_verified",
  "venue_confirmed",
  "photo_verified",
  "community_confirmed",
] as const;

async function createLegacyQueueDatabase(
  database: Database.Database,
): Promise<SqlDatabase> {
  const { asAsyncSqliteDatabase } = await import("../src/db/sql-database.js");
  return asAsyncSqliteDatabase(database);
}

export const PRODUCTION_MAP_BASE_POLICY: Readonly<ReviewedPriceSelectionOptions> =
  REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const beerSchema = z.object({
  availabilityStatus: z.literal("on_tap"),
  availableOnTap: z.literal(true),
  availablePackageOnly: z.literal(false),
  name: z.string().trim().min(1),
  needsReview: z.literal(false),
  priceNumeric: z.number().finite().min(PRODUCTION_MAP_BASE_POLICY.minPrice).max(PRODUCTION_MAP_BASE_POLICY.maxPrice),
  priceText: z.string().nullable(),
  servingSize: z.literal("pint"),
  unavailableReason: z.null(),
}).strict();

const manifestItemSchema = z.object({
  id: z.string().uuid(),
  overallConfidence: z.number().finite(),
  queueCreatedAt: z.string().datetime({ offset: true }),
  queueSnapshotSha256: sha256Schema,
  queueUpdatedAt: z.string().datetime({ offset: true }),
  rowCount: z.number().int().positive(),
  rows: z.array(beerSchema).min(1),
  rowsSha256: sha256Schema,
  sourceUrl: z.string().url(),
  venueId: z.string().uuid(),
  venueName: z.string().trim().min(1),
}).strict();

const policySchema = z.object({
  allowHomepage: z.literal(PRODUCTION_MAP_BASE_POLICY.allowHomepage),
  allowSpecialSources: z.literal(PRODUCTION_MAP_BASE_POLICY.allowSpecialSources),
  maxPrice: z.literal(PRODUCTION_MAP_BASE_POLICY.maxPrice),
  minOverallConfidence: z.literal(PRODUCTION_MAP_BASE_POLICY.minOverallConfidence),
  minPrice: z.literal(PRODUCTION_MAP_BASE_POLICY.minPrice),
  minRowConfidence: z.literal(PRODUCTION_MAP_BASE_POLICY.minRowConfidence),
}).strict();

const manifestSchema = z.object({
  candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
  databasePath: z.string().refine(path.isAbsolute, "databasePath must be absolute"),
  itemCount: z.number().int().min(1).max(MAX_ITEMS_PER_PROMOTION),
  items: z.array(manifestItemSchema).min(1).max(MAX_ITEMS_PER_PROMOTION),
  kind: z.literal(MANIFEST_KIND),
  policy: policySchema,
  policySha256: sha256Schema,
  rowCount: z.number().int().positive(),
  sourceSnapshotSha256: sha256Schema,
  supabaseOrigin: z.string().url(),
  supabaseProjectRef: z.string().regex(/^[a-z0-9]{20}$/),
  version: z.literal(1),
}).strict();

export type ReviewedPricePromotionManifest = z.infer<typeof manifestSchema>;

export interface PromotionApplyControls {
  approvalReference: string;
  backupId: string;
  backupManifestSha256: string;
  backupVerifiedAt: string;
  operator: string;
  reviewer: string;
}

export interface PromotionPublicRow {
  beerName: string;
  confidence: string;
  id: string;
  isHappyHourPrice: number;
  isOnTap: string;
  lastVerifiedAt: string;
  price: number | null;
  servingSize: string;
  sourceEvidenceReference: string | null;
  sourceEvidenceVerifiedAt: string | null;
  sourceIngestionId: string | null;
  sourceType: string;
  updatedAt: string;
  venueId: string;
}

export interface PromotionFailure {
  error: string;
  id: string | null;
  stage: "preflight" | "publish" | "verify";
}

export interface PromotionExecutionResult {
  afterPublicRows: PromotionPublicRow[];
  beforePublicRows: PromotionPublicRow[];
  failed: PromotionFailure[];
  published: Array<{ id: string; rows: number; savedAt: string }>;
  succeeded: boolean;
}

export interface PromotionReceipt {
  approvalReference: string;
  appliedAt: string;
  backup: {
    authoritySha256: string;
    id: string;
    manifestSha256: string;
    verifiedAt: string;
  };
  candidateSha: string;
  failed: PromotionFailure[];
  hashes: {
    afterPublicRowsSha256: string;
    approvalReferenceSha256: string;
    backupAuthoritySha256: string;
    backupManifestSha256: string;
    beforePublicRowsSha256: string;
    failedItemsSha256: string;
    manifestSha256: string;
  };
  kind: typeof RECEIPT_KIND;
  manifest: {
    itemCount: number;
    path: string;
    rowCount: number;
    sha256: string;
    sourceSnapshotSha256: string;
  };
  operator: string;
  outcome: "succeeded" | "failed";
  published: Array<{ id: string; rows: number; savedAt: string }>;
  reviewer: string;
  supabaseProjectRef: string;
  version: 1;
}

export interface InProgressPromotionReceipt {
  approvalReferenceSha256: string;
  backupAuthoritySha256: string;
  candidateSha: string;
  kind: typeof RECEIPT_KIND;
  manifestSha256: string;
  operator: string;
  outcome: "in_progress";
  reviewer: string;
  supabaseProjectRef: string;
  version: 1;
}

export type PromotionReceiptAuthority = PromotionReceipt | InProgressPromotionReceipt;

export interface QuarantineFailure {
  error: string;
  id: string | null;
  stage: "preflight" | "quarantine" | "verify";
}

export interface QuarantineExecutionResult {
  absentIds: string[];
  afterRows: PromotionPublicRow[];
  alreadyQuarantinedIds: string[];
  beforeRows: PromotionPublicRow[];
  failed: QuarantineFailure[];
  queueHistoryAfterSha256: string;
  queueHistoryBeforeSha256: string;
  quarantinedIds: string[];
  succeeded: boolean;
}

export interface QuarantineReceipt {
  approvalReference: string;
  backup: {
    authoritySha256: string;
    id: string;
    manifestSha256: string;
    verifiedAt: string;
  };
  candidateSha: string;
  failed: QuarantineFailure[];
  hashes: {
    afterRowsSha256: string;
    approvalReferenceSha256: string;
    backupAuthoritySha256: string;
    backupManifestSha256: string;
    beforeRowsSha256: string;
    failedItemsSha256: string;
    manifestSha256: string;
    promotionReceiptSha256: string;
    queueHistoryAfterSha256: string;
    queueHistoryBeforeSha256: string;
  };
  kind: typeof QUARANTINE_RECEIPT_KIND;
  manifest: {
    path: string;
    sha256: string;
  };
  operator: string;
  outcome: "succeeded" | "failed";
  promotionReceipt: {
    outcome: PromotionReceiptAuthority["outcome"];
    path: string;
    sha256: string;
  };
  quarantinedAt: string;
  reconciliation: {
    absentIds: string[];
    alreadyQuarantinedIds: string[];
    quarantinedIds: string[];
  };
  reviewer: string;
  supabaseProjectRef: string;
  version: 1;
}

export type ReachableSourceVerifier = (sourceUrl: string) => Promise<void>;
export type PromotionPublisher = (
  id: string,
  rows: AdminBeerInput[],
  note: string,
) => Promise<{ mapPriceRecordCount: number; savedAt: string }>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256Bytes(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

function normalizeIdentity(value: string, fieldName: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    normalized.length < 3 ||
    normalized.length > 120 ||
    /[\r\n]/.test(normalized) ||
    !/^[A-Za-z0-9][A-Za-z0-9@._:+ /-]*$/.test(normalized)
  ) {
    throw new Error(`${fieldName} must be an explicit 3-120 character operator identity.`);
  }
  return normalized;
}

function normalizeApprovalReference(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    normalized.length < 6 ||
    normalized.length > 200 ||
    /[\r\n]/.test(normalized) ||
    !/^[A-Za-z0-9][A-Za-z0-9@._:+ /#-]*$/.test(normalized)
  ) {
    throw new Error("Approval reference must be an explicit 6-200 character ticket, change, or signed-review reference.");
  }
  return normalized;
}

function parseExactIsoTimestamp(value: string, fieldName: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${fieldName} must be an exact ISO-8601 UTC timestamp with milliseconds.`);
  }
  return timestamp;
}

function assertExplicitFalse(environment: NodeJS.ProcessEnv, name: string): void {
  if (environment[name]?.trim().toLowerCase() !== "false") {
    throw new Error(`${name}=false must be explicitly set for reviewed price promotion.`);
  }
}

export function validateApplyControls(
  input: PromotionApplyControls,
  now: Date,
  environment: NodeJS.ProcessEnv,
): PromotionApplyControls {
  if (environment.NODE_ENV?.trim().toLowerCase() !== "production") {
    throw new Error("NODE_ENV=production must be explicitly set for reviewed price promotion.");
  }
  assertExplicitFalse(environment, "COMMERCIAL_LAUNCH_ENABLED");
  assertExplicitFalse(environment, "CONSUMER_PAID_ENROLLMENT_ENABLED");
  assertExplicitFalse(environment, "PINT_POINTS_REWARDS_ENABLED");
  assertExplicitFalse(environment, "ALCOHOL_GAMIFICATION_ENABLED");

  const operator = normalizeIdentity(input.operator, "Operator");
  const reviewer = normalizeIdentity(input.reviewer, "Reviewer");
  if (operator.toLowerCase() === reviewer.toLowerCase()) {
    throw new Error("Operator and reviewer must be distinct people.");
  }
  const approvalReference = normalizeApprovalReference(input.approvalReference);
  if (
    approvalReference.toLowerCase() === operator.toLowerCase() ||
    approvalReference.toLowerCase() === reviewer.toLowerCase()
  ) {
    throw new Error("Approval reference must be distinct from the operator and reviewer identities.");
  }

  const backupId = input.backupId.trim();
  if (!/^pint-path-[A-Za-z0-9][A-Za-z0-9._-]{8,120}$/.test(backupId)) {
    throw new Error("Backup ID must be an immutable Pint Path backup identifier.");
  }
  const backupManifestSha256 = input.backupManifestSha256.trim();
  if (!/^[a-f0-9]{64}$/.test(backupManifestSha256)) {
    throw new Error("Backup manifest SHA-256 must be exactly 64 lowercase hexadecimal characters.");
  }
  const backupVerifiedAt = input.backupVerifiedAt.trim();
  const backupTimestamp = parseExactIsoTimestamp(backupVerifiedAt, "Backup verification timestamp");
  const backupAge = now.getTime() - backupTimestamp;
  if (backupAge < 0 || backupAge > MAX_BACKUP_AGE_MS) {
    throw new Error("Backup verification must be no more than 30 minutes old and cannot be in the future.");
  }

  return {
    approvalReference,
    backupId,
    backupManifestSha256,
    backupVerifiedAt,
    operator,
    reviewer,
  };
}

export function assertExactSupabaseProjectTarget(
  supabaseUrlValue: string,
  expectedProjectRefValue: string,
): { origin: string; projectRef: string } {
  const expectedProjectRef = expectedProjectRefValue.trim().toLowerCase();
  if (!/^[a-z0-9]{20}$/.test(expectedProjectRef)) {
    throw new Error("Expected Supabase project ref must be exactly 20 lowercase letters or digits.");
  }

  let supabaseUrl: URL;
  try {
    supabaseUrl = new URL(supabaseUrlValue);
  } catch {
    throw new Error("SUPABASE_URL must be the canonical Supabase project origin.");
  }
  const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(supabaseUrl.hostname.toLowerCase());
  if (
    supabaseUrl.protocol !== "https:" ||
    !match ||
    supabaseUrl.port ||
    supabaseUrl.username ||
    supabaseUrl.password ||
    !["", "/"].includes(supabaseUrl.pathname) ||
    supabaseUrl.search ||
    supabaseUrl.hash
  ) {
    throw new Error(
      "SUPABASE_URL must be the canonical HTTPS origin https://<project-ref>.supabase.co with no alias, port, path, query, or fragment.",
    );
  }
  if (match[1] !== expectedProjectRef) {
    throw new Error(
      `Supabase project target mismatch. Expected ${expectedProjectRef}; SUPABASE_URL resolves to ${match[1]}.`,
    );
  }
  return {
    origin: `https://${match[1]}.supabase.co`,
    projectRef: match[1],
  };
}

export function assertProductionMutationTarget(projectRef: string): void {
  if (projectRef !== PRODUCTION_SUPABASE_PROJECT_REF) {
    throw new Error(
      `Reviewed price mutations are locked to production project ${PRODUCTION_SUPABASE_PROJECT_REF}; received ${projectRef}.`,
    );
  }
}

export function assertReviewedManifestMutationTarget(
  manifest: ReviewedPricePromotionManifest,
  input: {
    candidateSha: string;
    databasePath: string;
    supabaseOrigin: string;
    supabaseProjectRef: string;
  },
): void {
  if (
    manifest.candidateSha !== input.candidateSha ||
    manifest.databasePath !== input.databasePath ||
    manifest.supabaseProjectRef !== input.supabaseProjectRef ||
    manifest.supabaseOrigin !== input.supabaseOrigin
  ) {
    throw new Error("Manifest candidate, database, or Supabase target does not match the explicitly pinned mutation target.");
  }
}

function assertCanonicalAbsoluteFile(filePath: string, fieldName: string): string {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) {
    throw new Error(`${fieldName} must be a canonical absolute path.`);
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${fieldName} must be an existing regular file, not a symlink.`);
  }
  if (fs.realpathSync(filePath) !== filePath) {
    throw new Error(`${fieldName} must not resolve through a symlink.`);
  }
  return filePath;
}

function assertNewCanonicalAbsoluteFile(filePath: string, fieldName: string): string {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) {
    throw new Error(`${fieldName} must be a canonical absolute path.`);
  }
  if (fs.existsSync(filePath)) {
    throw new Error(`${fieldName} already exists; refusing to overwrite an audit artifact.`);
  }
  const parent = path.dirname(filePath);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent) {
    throw new Error(`${fieldName} parent must be an existing canonical directory without symlinks.`);
  }
  return filePath;
}

export function writeNewJsonArtifact(filePath: string, value: unknown): string {
  assertNewCanonicalAbsoluteFile(filePath, "Artifact path");
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    return writeReservedJsonArtifact(descriptor, value);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeReservedJsonArtifact(descriptor: number, value: unknown): string {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  fs.ftruncateSync(descriptor, 0);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) {
      throw new Error("Audit artifact write stopped before all bytes were persisted.");
    }
    offset += written;
  }
  fs.fsyncSync(descriptor);
  return sha256Bytes(bytes);
}

function queueSnapshot(queueItem: AdminIngestionQueueRecord): Record<string, unknown> {
  return {
    capturedNotes: queueItem.capturedNotes,
    createdAt: queueItem.createdAt,
    extractedBeers: queueItem.extractedBeers,
    id: queueItem.id,
    note: queueItem.note,
    overallConfidence: queueItem.overallConfidence,
    sourceType: queueItem.sourceType,
    sourceUrl: queueItem.sourceUrl,
    status: queueItem.status,
    updatedAt: queueItem.updatedAt,
    venueId: queueItem.venueId,
    venueName: queueItem.venueName,
  };
}

function manifestItemAuthority(item: ReviewedPricePromotionManifest["items"][number]): Record<string, unknown> {
  return {
    id: item.id,
    overallConfidence: item.overallConfidence,
    queueCreatedAt: item.queueCreatedAt,
    queueSnapshotSha256: item.queueSnapshotSha256,
    queueUpdatedAt: item.queueUpdatedAt,
    rowCount: item.rowCount,
    rows: item.rows,
    rowsSha256: item.rowsSha256,
    sourceUrl: item.sourceUrl,
    venueId: item.venueId,
    venueName: item.venueName,
  };
}

function assertVenueHasNoTrustedPublicRows(database: Database.Database, venueId: string): void {
  const placeholders = TRUSTED_PUBLIC_CONFIDENCE.map(() => "?").join(", ");
  const result = database.prepare(
    `SELECT count(*) AS total
       FROM venue_price_records
      WHERE venue_id = ?
        AND confidence IN (${placeholders})`,
  ).get(venueId, ...TRUSTED_PUBLIC_CONFIDENCE) as { total: number };
  if (Number(result.total) > 0) {
    throw new Error(`Venue ${venueId} already has trusted public price rows; map-base promotion is not allowed.`);
  }
}

function assertExactUniqueIds(ids: readonly string[]): string[] {
  if (ids.length < 1 || ids.length > MAX_ITEMS_PER_PROMOTION) {
    throw new Error(`Pass between 1 and ${MAX_ITEMS_PER_PROMOTION} exact source-ingestion IDs.`);
  }
  const normalized = ids.map((id) => z.string().uuid().parse(id.trim())).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Source-ingestion IDs must be unique.");
  }
  return normalized;
}

export async function buildReviewedPricePromotionManifest(input: {
  candidateSha: string;
  database: Database.Database;
  databasePath: string;
  ids: readonly string[];
  sourceVerifier: ReachableSourceVerifier;
  supabaseOrigin: string;
  supabaseProjectRef: string;
}): Promise<ReviewedPricePromotionManifest> {
  const candidateSha = z.string().regex(/^[a-f0-9]{40}$/).parse(input.candidateSha);
  const ids = assertExactUniqueIds(input.ids);
  const repository = new AdminIngestionQueueRepository(
    await createLegacyQueueDatabase(input.database),
  );
  const items: ReviewedPricePromotionManifest["items"] = [];

  for (const id of ids) {
    const queueItem = await repository.getById(id);
    if (!queueItem) {
      throw new Error(`Source-ingestion item ${id} was not found.`);
    }
    if (queueItem.status !== "pending_review") {
      throw new Error(`Source-ingestion item ${id} is ${queueItem.status}, not pending_review.`);
    }
    assertVenueHasNoTrustedPublicRows(input.database, queueItem.venueId);
    const selection = selectPublishableMapBaseRows(
      queueItem,
      PRODUCTION_MAP_BASE_POLICY,
    );
    if (selection.reasons.length > 0 || selection.beers.length === 0) {
      throw new Error(
        `Source-ingestion item ${id} failed immutable map-base policy: ${selection.reasons.join(", ") || "no rows"}.`,
      );
    }
    if (!queueItem.sourceUrl) {
      throw new Error(`Source-ingestion item ${id} has no public source URL.`);
    }
    await input.sourceVerifier(queueItem.sourceUrl);

    const rows = z.array(beerSchema).parse(selection.beers);
    items.push({
      id,
      overallConfidence: queueItem.overallConfidence ?? 0,
      queueCreatedAt: queueItem.createdAt,
      queueSnapshotSha256: sha256Json(queueSnapshot(queueItem)),
      queueUpdatedAt: queueItem.updatedAt,
      rowCount: rows.length,
      rows,
      rowsSha256: sha256Json(rows),
      sourceUrl: queueItem.sourceUrl,
      venueId: queueItem.venueId,
      venueName: queueItem.venueName,
    });
  }

  const manifest: ReviewedPricePromotionManifest = {
    candidateSha,
    databasePath: input.databasePath,
    itemCount: items.length,
    items,
    kind: MANIFEST_KIND,
    policy: { ...PRODUCTION_MAP_BASE_POLICY },
    policySha256: REVIEWED_PRICE_SELECTION_POLICY_SHA256,
    rowCount: items.reduce((total, item) => total + item.rowCount, 0),
    sourceSnapshotSha256: sha256Json(items.map(manifestItemAuthority)),
    supabaseOrigin: input.supabaseOrigin,
    supabaseProjectRef: input.supabaseProjectRef,
    version: 1,
  };
  return validateManifestIntegrity(manifest);
}

export function validateManifestIntegrity(value: unknown): ReviewedPricePromotionManifest {
  const manifest = manifestSchema.parse(value);
  if (manifest.itemCount !== manifest.items.length) {
    throw new Error("Manifest item count does not match its exact item list.");
  }
  if (manifest.rowCount !== manifest.items.reduce((total, item) => total + item.rowCount, 0)) {
    throw new Error("Manifest row count does not match its exact item rows.");
  }
  if (manifest.policySha256 !== REVIEWED_PRICE_SELECTION_POLICY_SHA256) {
    throw new Error("Manifest policy hash does not match the immutable production policy.");
  }
  const ids = manifest.items.map((item) => item.id);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    throw new Error("Manifest item IDs must be unique and sorted.");
  }
  const venueIds = manifest.items.map((item) => item.venueId);
  if (new Set(venueIds).size !== venueIds.length) {
    throw new Error("A reviewed promotion may contain only one exact source-ingestion item per venue.");
  }
  for (const item of manifest.items) {
    if (item.rowCount !== item.rows.length || item.rowsSha256 !== sha256Json(item.rows)) {
      throw new Error(`Manifest rows changed for source-ingestion item ${item.id}.`);
    }
  }
  if (manifest.sourceSnapshotSha256 !== sha256Json(manifest.items.map(manifestItemAuthority))) {
    throw new Error("Manifest source snapshot hash does not match its exact items.");
  }
  return manifest;
}

function sameStableFile(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs;
}

function pathStillNamesStableFile(filePath: string, descriptorStat: fs.Stats): boolean {
  try {
    const pathStat = fs.lstatSync(filePath);
    return pathStat.isFile() &&
      !pathStat.isSymbolicLink() &&
      fs.realpathSync(filePath) === filePath &&
      sameStableFile(descriptorStat, pathStat);
  } catch {
    return false;
  }
}

function readStableCanonicalFile(
  filePath: string,
  fieldName: string,
  changedMessage: string,
): Buffer {
  assertCanonicalAbsoluteFile(filePath, fieldName);
  const noFollowFlag = Number.isInteger(fs.constants.O_NOFOLLOW)
    ? fs.constants.O_NOFOLLOW
    : 0;
  const nonBlockingFlag = Number.isInteger(fs.constants.O_NONBLOCK)
    ? fs.constants.O_NONBLOCK
    : 0;
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | noFollowFlag | nonBlockingFlag,
  );
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || !pathStillNamesStableFile(filePath, before)) {
      throw new Error(`${fieldName} must remain the same canonical regular file while it is opened.`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      bytes.length !== after.size ||
      !sameStableFile(before, after) ||
      !pathStillNamesStableFile(filePath, after)
    ) {
      throw new Error(changedMessage);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function loadReviewedPricePromotionManifest(
  manifestPath: string,
  expectedSha256: string,
): { bytes: Buffer; manifest: ReviewedPricePromotionManifest; sha256: string } {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("Expected manifest SHA-256 must be exactly 64 lowercase hexadecimal characters.");
  }
  const bytes = readStableCanonicalFile(
    manifestPath,
    "Manifest path",
    "Manifest changed while it was being read.",
  );
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Manifest SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Manifest is not valid JSON.");
  }
  const manifest = validateManifestIntegrity(parsed);
  if (!bytes.equals(Buffer.from(canonicalJson(manifest)))) {
    throw new Error("Manifest is not in the deterministic canonical form written by plan mode.");
  }
  return { bytes, manifest, sha256: actualSha256 };
}

function listPublicRowsForIngestionIds(
  database: Database.Database,
  ids: readonly string[],
): PromotionPublicRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return database.prepare(
    `SELECT
       beer_name AS beerName,
       confidence,
       id,
       is_happy_hour_price AS isHappyHourPrice,
       is_on_tap AS isOnTap,
       last_verified_at AS lastVerifiedAt,
       price,
       serving_size AS servingSize,
       source_evidence_reference AS sourceEvidenceReference,
       source_evidence_verified_at AS sourceEvidenceVerifiedAt,
       source_ingestion_id AS sourceIngestionId,
       source_type AS sourceType,
       updated_at AS updatedAt,
       venue_id AS venueId
     FROM venue_price_records
     WHERE source_ingestion_id IN (${placeholders})
     ORDER BY source_ingestion_id, id`,
  ).all(...ids) as PromotionPublicRow[];
}

function verifyPublishedRows(
  database: Database.Database,
  item: ReviewedPricePromotionManifest["items"][number],
  savedAt: string,
  expectedCount: number,
): void {
  const rows = listPublicRowsForIngestionIds(database, [item.id]);
  if (expectedCount !== item.rowCount || rows.length !== item.rowCount) {
    throw new Error(
      `Published ${rows.length} public rows for ${item.id}; the reviewed manifest requires exactly ${item.rowCount}.`,
    );
  }
  parseExactIsoTimestamp(savedAt, "Admin publish timestamp");
  item.rows.forEach((expected, index) => {
    const expectedId = `source-ingestion:${item.id}:${index}`;
    const row = rows.find((candidate) => candidate.id === expectedId);
    if (!row) {
      throw new Error(`Reviewed public row ${expectedId} is missing after publication.`);
    }
    if (
      row.id !== expectedId ||
      row.sourceIngestionId !== item.id ||
      row.sourceType !== "source_ingestion" ||
      row.venueId !== item.venueId ||
      row.beerName !== expected.name ||
      row.confidence !== "admin_verified" ||
      row.isHappyHourPrice !== 0 ||
      row.isOnTap !== "yes" ||
      row.servingSize !== expected.servingSize ||
      row.price !== expected.priceNumeric ||
      row.sourceEvidenceReference !== `source-ingestion:${item.id}` ||
      row.sourceEvidenceVerifiedAt !== savedAt ||
      row.lastVerifiedAt !== savedAt
    ) {
      throw new Error(`Public row ${expectedId} does not exactly match the reviewed row and evidence authority.`);
    }
    parseExactIsoTimestamp(row.sourceEvidenceVerifiedAt, `Evidence timestamp for ${expectedId}`);
  });
}

async function preflightManifestItem(
  database: Database.Database,
  repository: AdminIngestionQueueRepository,
  item: ReviewedPricePromotionManifest["items"][number],
): Promise<AdminIngestionQueueRecord> {
  const queueItem = await repository.getById(item.id);
  if (!queueItem) {
    throw new Error("Source-ingestion item no longer exists.");
  }
  if (queueItem.status !== "pending_review") {
    throw new Error(`Source-ingestion item is now ${queueItem.status}, not pending_review.`);
  }
  if (
    queueItem.venueId !== item.venueId ||
    queueItem.venueName !== item.venueName ||
    queueItem.sourceUrl !== item.sourceUrl ||
    queueItem.createdAt !== item.queueCreatedAt ||
    queueItem.updatedAt !== item.queueUpdatedAt ||
    (queueItem.overallConfidence ?? 0) !== item.overallConfidence ||
    sha256Json(queueSnapshot(queueItem)) !== item.queueSnapshotSha256
  ) {
    throw new Error("Source-ingestion queue item changed after the reviewed manifest was created.");
  }
  assertVenueHasNoTrustedPublicRows(database, queueItem.venueId);
  const selection = selectPublishableMapBaseRows(
    queueItem,
    PRODUCTION_MAP_BASE_POLICY,
  );
  if (
    selection.reasons.length > 0 ||
    selection.beers.length !== item.rows.length ||
    sha256Json(selection.beers) !== item.rowsSha256
  ) {
    throw new Error("Source-ingestion rows no longer pass the immutable reviewed selection.");
  }
  return queueItem;
}

export async function executeReviewedPricePromotion(input: {
  controls: PromotionApplyControls;
  database: Database.Database;
  manifest: ReviewedPricePromotionManifest;
  publisher: PromotionPublisher;
  queueDatabase?: SqlDatabase;
  sourceVerifier: ReachableSourceVerifier;
}): Promise<PromotionExecutionResult> {
  const repository = new AdminIngestionQueueRepository(
    input.queueDatabase ?? await createLegacyQueueDatabase(input.database),
  );
  const ids = input.manifest.items.map((item) => item.id);
  const beforePublicRows = listPublicRowsForIngestionIds(input.database, ids);
  const failed: PromotionFailure[] = [];

  for (const item of input.manifest.items) {
    try {
      await preflightManifestItem(input.database, repository, item);
      await input.sourceVerifier(item.sourceUrl);
    } catch (error) {
      failed.push({
        error: redactSecrets(error instanceof Error ? error.message : "Unknown preflight failure"),
        id: item.id,
        stage: "preflight",
      });
    }
  }

  if (failed.length > 0) {
    return {
      afterPublicRows: listPublicRowsForIngestionIds(input.database, ids),
      beforePublicRows,
      failed,
      published: [],
      succeeded: false,
    };
  }

  const published: PromotionExecutionResult["published"] = [];
  for (const item of input.manifest.items) {
    let result: Awaited<ReturnType<PromotionPublisher>>;
    try {
      // Repeat the local authority check immediately before this exact write so
      // a concurrent local change after the all-item preflight cannot pass.
      await preflightManifestItem(input.database, repository, item);
      result = await input.publisher(
        item.id,
        item.rows,
        [
          "Reviewed production map-base promotion.",
          `Approval: ${input.controls.approvalReference}.`,
          `Independent reviewer: ${input.controls.reviewer}.`,
        ].join(" "),
      );
      published.push({ id: item.id, rows: result.mapPriceRecordCount, savedAt: result.savedAt });
    } catch (error) {
      failed.push({
        error: redactSecrets(error instanceof Error ? error.message : "Unknown publish failure"),
        id: item.id,
        stage: "publish",
      });
      break;
    }

    try {
      verifyPublishedRows(input.database, item, result.savedAt, result.mapPriceRecordCount);
    } catch (error) {
      failed.push({
        error: redactSecrets(error instanceof Error ? error.message : "Unknown verification failure"),
        id: item.id,
        stage: "verify",
      });
      break;
    }
  }

  return {
    afterPublicRows: listPublicRowsForIngestionIds(input.database, ids),
    beforePublicRows,
    failed,
    published,
    succeeded: failed.length === 0 && published.length === input.manifest.items.length,
  };
}

export function buildPromotionReceipt(input: {
  appliedAt: string;
  controls: PromotionApplyControls;
  execution: PromotionExecutionResult;
  manifest: ReviewedPricePromotionManifest;
  manifestPath: string;
  manifestSha256: string;
}): PromotionReceipt {
  const backupAuthority = {
    id: input.controls.backupId,
    manifestSha256: input.controls.backupManifestSha256,
    verifiedAt: input.controls.backupVerifiedAt,
  };
  const backupAuthoritySha256 = sha256Json(backupAuthority);
  return {
    approvalReference: input.controls.approvalReference,
    appliedAt: input.appliedAt,
    backup: {
      authoritySha256: backupAuthoritySha256,
      ...backupAuthority,
    },
    candidateSha: input.manifest.candidateSha,
    failed: input.execution.failed,
    hashes: {
      afterPublicRowsSha256: sha256Json(input.execution.afterPublicRows),
      approvalReferenceSha256: sha256Bytes(input.controls.approvalReference),
      backupAuthoritySha256,
      backupManifestSha256: input.controls.backupManifestSha256,
      beforePublicRowsSha256: sha256Json(input.execution.beforePublicRows),
      failedItemsSha256: sha256Json(input.execution.failed),
      manifestSha256: input.manifestSha256,
    },
    kind: RECEIPT_KIND,
    manifest: {
      itemCount: input.manifest.itemCount,
      path: input.manifestPath,
      rowCount: input.manifest.rowCount,
      sha256: input.manifestSha256,
      sourceSnapshotSha256: input.manifest.sourceSnapshotSha256,
    },
    operator: input.controls.operator,
    outcome: input.execution.succeeded ? "succeeded" : "failed",
    published: input.execution.published,
    reviewer: input.controls.reviewer,
    supabaseProjectRef: input.manifest.supabaseProjectRef,
    version: 1,
  };
}

const promotionFailureSchema = z.object({
  error: z.string(),
  id: z.string().uuid().nullable(),
  stage: z.enum(["preflight", "publish", "verify"]),
}).strict();
const promotionReceiptSchema = z.object({
  approvalReference: z.string().min(1),
  appliedAt: z.string().datetime({ offset: true }),
  backup: z.object({
    authoritySha256: sha256Schema,
    id: z.string().min(1),
    manifestSha256: sha256Schema,
    verifiedAt: z.string().datetime({ offset: true }),
  }).strict(),
  candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
  failed: z.array(promotionFailureSchema),
  hashes: z.object({
    afterPublicRowsSha256: sha256Schema,
    approvalReferenceSha256: sha256Schema,
    backupAuthoritySha256: sha256Schema,
    backupManifestSha256: sha256Schema,
    beforePublicRowsSha256: sha256Schema,
    failedItemsSha256: sha256Schema,
    manifestSha256: sha256Schema,
  }).strict(),
  kind: z.literal(RECEIPT_KIND),
  manifest: z.object({
    itemCount: z.number().int().positive(),
    path: z.string().refine(path.isAbsolute),
    rowCount: z.number().int().positive(),
    sha256: sha256Schema,
    sourceSnapshotSha256: sha256Schema,
  }).strict(),
  operator: z.string().min(1),
  outcome: z.enum(["succeeded", "failed"]),
  published: z.array(z.object({
    id: z.string().uuid(),
    rows: z.number().int().positive(),
    savedAt: z.string().datetime({ offset: true }),
  }).strict()),
  reviewer: z.string().min(1),
  supabaseProjectRef: z.string().regex(/^[a-z0-9]{20}$/),
  version: z.literal(1),
}).strict();
const inProgressPromotionReceiptSchema = z.object({
  approvalReferenceSha256: sha256Schema,
  backupAuthoritySha256: sha256Schema,
  candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
  kind: z.literal(RECEIPT_KIND),
  manifestSha256: sha256Schema,
  operator: z.string().min(1),
  outcome: z.literal("in_progress"),
  reviewer: z.string().min(1),
  supabaseProjectRef: z.string().regex(/^[a-z0-9]{20}$/),
  version: z.literal(1),
}).strict();

function validatePromotionReceiptAuthority(value: unknown): PromotionReceiptAuthority {
  const partial = value as { outcome?: unknown };
  if (partial?.outcome === "in_progress") {
    return inProgressPromotionReceiptSchema.parse(value);
  }
  const receipt = promotionReceiptSchema.parse(value);
  const backupAuthority = {
    id: receipt.backup.id,
    manifestSha256: receipt.backup.manifestSha256,
    verifiedAt: receipt.backup.verifiedAt,
  };
  if (
    receipt.backup.authoritySha256 !== sha256Json(backupAuthority) ||
    receipt.hashes.backupAuthoritySha256 !== receipt.backup.authoritySha256 ||
    receipt.hashes.backupManifestSha256 !== receipt.backup.manifestSha256 ||
    receipt.hashes.approvalReferenceSha256 !== sha256Bytes(receipt.approvalReference) ||
    receipt.hashes.failedItemsSha256 !== sha256Json(receipt.failed) ||
    receipt.hashes.manifestSha256 !== receipt.manifest.sha256
  ) {
    throw new Error("Promotion receipt internal authority hashes do not match.");
  }
  const publishedIds = receipt.published.map((item) => item.id);
  if (new Set(publishedIds).size !== publishedIds.length) {
    throw new Error("Promotion receipt contains duplicate published source-ingestion IDs.");
  }
  if (receipt.outcome === "succeeded" && receipt.failed.length > 0) {
    throw new Error("A succeeded promotion receipt cannot contain failures.");
  }
  return receipt;
}

export function loadPromotionReceiptAuthority(
  receiptPath: string,
  expectedSha256: string,
): { bytes: Buffer; receipt: PromotionReceiptAuthority; sha256: string } {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("Expected promotion receipt SHA-256 must be exactly 64 lowercase hexadecimal characters.");
  }
  const bytes = readStableCanonicalFile(
    receiptPath,
    "Promotion receipt path",
    "Promotion receipt changed while it was being read.",
  );
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Promotion receipt SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Promotion receipt is not valid JSON.");
  }
  const receipt = validatePromotionReceiptAuthority(parsed);
  if (!bytes.equals(Buffer.from(canonicalJson(receipt)))) {
    throw new Error("Promotion receipt is not in deterministic canonical form.");
  }
  return { bytes, receipt, sha256: actualSha256 };
}

function queueHistorySnapshot(database: Database.Database, ids: readonly string[]): unknown[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return database.prepare(
    `SELECT
       id,
       status,
       review_beers_json AS reviewBeersJson,
       crawler_feedback_json AS crawlerFeedbackJson,
       error_message AS errorMessage,
       published_at AS publishedAt,
       rejected_at AS rejectedAt,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM admin_ingestion_queue
     WHERE id IN (${placeholders})
     ORDER BY id`,
  ).all(...ids) as unknown[];
}

function exactExpectedRowId(ingestionId: string, index: number): string {
  return `source-ingestion:${ingestionId}:${index}`;
}

function assertQuarantineRowAuthority(input: {
  item: ReviewedPricePromotionManifest["items"][number];
  rows: PromotionPublicRow[];
  savedAt: string | null;
}): "public" | "quarantined" {
  if (input.rows.length !== input.item.rows.length) {
    throw new Error(
      `Source-ingestion ${input.item.id} has ${input.rows.length} rows; immutable manifest requires ${input.item.rows.length}.`,
    );
  }
  let state: "public" | "quarantined" | null = null;
  input.item.rows.forEach((expected, index) => {
    const expectedId = exactExpectedRowId(input.item.id, index);
    const row = input.rows.find((candidate) => candidate.id === expectedId);
    if (!row) {
      throw new Error(`Source-ingestion ${input.item.id} row ${index} is missing.`);
    }
    const rowState = row.sourceType === "source_ingestion" && row.confidence === "admin_verified"
      ? "public"
      : row.sourceType === QUARANTINED_SOURCE_TYPE && row.confidence === "disputed"
        ? "quarantined"
        : null;
    if (!rowState || (state && state !== rowState)) {
      throw new Error(`Source-ingestion ${input.item.id} has mixed or unsupported publication state.`);
    }
    state = rowState;
    if (
      row.id !== expectedId ||
      row.sourceIngestionId !== input.item.id ||
      row.venueId !== input.item.venueId ||
      row.beerName !== expected.name ||
      row.servingSize !== expected.servingSize ||
      row.price !== expected.priceNumeric ||
      row.isHappyHourPrice !== 0 ||
      row.isOnTap !== "yes" ||
      row.sourceEvidenceReference !== `source-ingestion:${input.item.id}` ||
      !row.sourceEvidenceVerifiedAt ||
      row.lastVerifiedAt !== row.sourceEvidenceVerifiedAt
    ) {
      throw new Error(`Source-ingestion ${input.item.id} row ${index} does not match immutable manifest/evidence authority.`);
    }
    parseExactIsoTimestamp(row.sourceEvidenceVerifiedAt, `Evidence timestamp for ${row.id}`);
    parseExactIsoTimestamp(row.updatedAt, `Updated timestamp for ${row.id}`);
    if (input.savedAt && row.lastVerifiedAt !== input.savedAt) {
      throw new Error(`Source-ingestion ${input.item.id} timestamp does not match its promotion receipt.`);
    }
  });
  return state!;
}

function authorizedQuarantineIds(input: {
  manifest: ReviewedPricePromotionManifest;
  manifestPath: string;
  manifestSha256: string;
  promotionReceipt: PromotionReceiptAuthority;
}): { ids: string[]; savedAtById: Map<string, string>; reconciliationMode: "finalized" | "in_progress" } {
  const { manifest, promotionReceipt } = input;
  if (
    promotionReceipt.candidateSha !== manifest.candidateSha ||
    promotionReceipt.supabaseProjectRef !== manifest.supabaseProjectRef
  ) {
    throw new Error("Promotion receipt candidate or project does not match the immutable manifest.");
  }
  const manifestIds = new Set(manifest.items.map((item) => item.id));
  if (promotionReceipt.outcome === "in_progress") {
    if (promotionReceipt.manifestSha256 !== input.manifestSha256) {
      throw new Error("In-progress promotion receipt does not identify the supplied manifest hash.");
    }
    return {
      ids: [...manifestIds].sort(),
      savedAtById: new Map(),
      reconciliationMode: "in_progress",
    };
  }
  if (
    promotionReceipt.manifest.sha256 !== input.manifestSha256 ||
    promotionReceipt.manifest.path !== input.manifestPath ||
    promotionReceipt.manifest.itemCount !== manifest.itemCount ||
    promotionReceipt.manifest.rowCount !== manifest.rowCount ||
    promotionReceipt.manifest.sourceSnapshotSha256 !== manifest.sourceSnapshotSha256
  ) {
    throw new Error("Final promotion receipt does not identify the supplied immutable manifest.");
  }
  const savedAtById = new Map<string, string>();
  for (const published of promotionReceipt.published) {
    if (!manifestIds.has(published.id)) {
      throw new Error("Promotion receipt lists a source-ingestion ID outside the immutable manifest.");
    }
    const item = manifest.items.find((candidate) => candidate.id === published.id)!;
    if (published.rows !== item.rowCount) {
      throw new Error(`Promotion receipt row count changed for source-ingestion ${published.id}.`);
    }
    savedAtById.set(published.id, published.savedAt);
  }
  const ids = [...savedAtById.keys()].sort();
  if (
    promotionReceipt.outcome === "succeeded" &&
    (ids.length !== manifestIds.size || [...manifestIds].some((id) => !savedAtById.has(id)))
  ) {
    throw new Error("Succeeded promotion receipt does not list every exact manifest source-ingestion ID.");
  }
  return { ids, savedAtById, reconciliationMode: "finalized" };
}

export async function executeReviewedPriceQuarantine(input: {
  controls: PromotionApplyControls;
  database: Database.Database;
  manifest: ReviewedPricePromotionManifest;
  manifestPath: string;
  manifestSha256: string;
  now: string;
  promotionReceipt: PromotionReceiptAuthority;
}): Promise<QuarantineExecutionResult> {
  parseExactIsoTimestamp(input.now, "Quarantine timestamp");
  const authority = authorizedQuarantineIds(input);
  const allManifestIds = input.manifest.items.map((item) => item.id);
  const beforeRows = listPublicRowsForIngestionIds(input.database, allManifestIds);
  const queueHistoryBeforeSha256 = sha256Json(queueHistorySnapshot(input.database, allManifestIds));
  const failed: QuarantineFailure[] = [];
  const absentIds: string[] = [];
  const alreadyQuarantinedIds: string[] = [];
  const publicIds: string[] = [];
  const authorizedSet = new Set(authority.ids);

  for (const item of input.manifest.items) {
    const rows = beforeRows.filter((row) => row.sourceIngestionId === item.id);
    if (!authorizedSet.has(item.id)) {
      if (rows.length > 0) {
        failed.push({
          error: "Rows exist for a manifest item that the finalized promotion receipt did not list as published.",
          id: item.id,
          stage: "preflight",
        });
      }
      continue;
    }
    if (rows.length === 0 && authority.reconciliationMode === "in_progress") {
      absentIds.push(item.id);
      continue;
    }
    try {
      const state = assertQuarantineRowAuthority({
        item,
        rows,
        savedAt: authority.savedAtById.get(item.id) ?? null,
      });
      if (state === "quarantined") {
        alreadyQuarantinedIds.push(item.id);
      } else {
        publicIds.push(item.id);
      }
    } catch (error) {
      failed.push({
        error: redactSecrets(error instanceof Error ? error.message : "Unknown quarantine preflight failure"),
        id: item.id,
        stage: "preflight",
      });
    }
  }

  if (failed.length > 0) {
    return {
      absentIds,
      afterRows: listPublicRowsForIngestionIds(input.database, allManifestIds),
      alreadyQuarantinedIds,
      beforeRows,
      failed,
      queueHistoryAfterSha256: sha256Json(queueHistorySnapshot(input.database, allManifestIds)),
      queueHistoryBeforeSha256,
      quarantinedIds: [],
      succeeded: false,
    };
  }

  try {
    const quarantine = input.database.transaction(() => {
      for (const id of publicIds) {
        const item = input.manifest.items.find((candidate) => candidate.id === id)!;
        const expectedIds = item.rows.map((_, index) => exactExpectedRowId(id, index));
        const placeholders = expectedIds.map(() => "?").join(", ");
        const result = input.database.prepare(
          `UPDATE venue_price_records
              SET source_type = ?,
                  confidence = 'disputed',
                  updated_at = ?
            WHERE source_ingestion_id = ?
              AND source_type = 'source_ingestion'
              AND confidence = 'admin_verified'
              AND id IN (${placeholders})`,
        ).run(QUARANTINED_SOURCE_TYPE, input.now, id, ...expectedIds);
        if (result.changes !== expectedIds.length) {
          throw new Error(`Quarantine changed ${result.changes} of ${expectedIds.length} exact rows for ${id}.`);
        }
      }

      const afterRows = listPublicRowsForIngestionIds(input.database, allManifestIds);
      for (const id of authority.ids) {
        const item = input.manifest.items.find((candidate) => candidate.id === id)!;
        const before = beforeRows.filter((row) => row.sourceIngestionId === id);
        const after = afterRows.filter((row) => row.sourceIngestionId === id);
        if (before.length === 0 && authority.reconciliationMode === "in_progress") continue;
        if (after.length !== before.length) {
          throw new Error(`Quarantine did not preserve every historical row for ${id}.`);
        }
        assertQuarantineRowAuthority({
          item,
          rows: after,
          savedAt: authority.savedAtById.get(id) ?? null,
        });
        after.forEach((row, index) => {
          const beforeRow = before[index]!;
          if (
            row.sourceType !== QUARANTINED_SOURCE_TYPE ||
            row.confidence !== "disputed" ||
            row.sourceEvidenceReference !== beforeRow.sourceEvidenceReference ||
            row.sourceEvidenceVerifiedAt !== beforeRow.sourceEvidenceVerifiedAt ||
            row.lastVerifiedAt !== beforeRow.lastVerifiedAt
          ) {
            throw new Error(`Quarantine did not preserve evidence/history for ${id}.`);
          }
        });
      }
      const queueHistoryAfterSha256 = sha256Json(queueHistorySnapshot(input.database, allManifestIds));
      if (queueHistoryAfterSha256 !== queueHistoryBeforeSha256) {
        throw new Error("Quarantine changed source-ingestion queue history.");
      }
      return { afterRows, queueHistoryAfterSha256 };
    });
    const verified = quarantine();
    return {
      absentIds,
      afterRows: verified.afterRows,
      alreadyQuarantinedIds,
      beforeRows,
      failed: [],
      queueHistoryAfterSha256: verified.queueHistoryAfterSha256,
      queueHistoryBeforeSha256,
      quarantinedIds: publicIds,
      succeeded: true,
    };
  } catch (error) {
    return {
      absentIds,
      afterRows: listPublicRowsForIngestionIds(input.database, allManifestIds),
      alreadyQuarantinedIds,
      beforeRows,
      failed: [{
        error: redactSecrets(error instanceof Error ? error.message : "Unknown quarantine failure"),
        id: null,
        stage: "quarantine",
      }],
      queueHistoryAfterSha256: sha256Json(queueHistorySnapshot(input.database, allManifestIds)),
      queueHistoryBeforeSha256,
      quarantinedIds: [],
      succeeded: false,
    };
  }
}

export function buildQuarantineReceipt(input: {
  controls: PromotionApplyControls;
  execution: QuarantineExecutionResult;
  manifest: ReviewedPricePromotionManifest;
  manifestPath: string;
  manifestSha256: string;
  promotionReceipt: PromotionReceiptAuthority;
  promotionReceiptPath: string;
  promotionReceiptSha256: string;
  quarantinedAt: string;
}): QuarantineReceipt {
  const backupAuthority = {
    id: input.controls.backupId,
    manifestSha256: input.controls.backupManifestSha256,
    verifiedAt: input.controls.backupVerifiedAt,
  };
  const backupAuthoritySha256 = sha256Json(backupAuthority);
  return {
    approvalReference: input.controls.approvalReference,
    backup: {
      authoritySha256: backupAuthoritySha256,
      ...backupAuthority,
    },
    candidateSha: input.manifest.candidateSha,
    failed: input.execution.failed,
    hashes: {
      afterRowsSha256: sha256Json(input.execution.afterRows),
      approvalReferenceSha256: sha256Bytes(input.controls.approvalReference),
      backupAuthoritySha256,
      backupManifestSha256: input.controls.backupManifestSha256,
      beforeRowsSha256: sha256Json(input.execution.beforeRows),
      failedItemsSha256: sha256Json(input.execution.failed),
      manifestSha256: input.manifestSha256,
      promotionReceiptSha256: input.promotionReceiptSha256,
      queueHistoryAfterSha256: input.execution.queueHistoryAfterSha256,
      queueHistoryBeforeSha256: input.execution.queueHistoryBeforeSha256,
    },
    kind: QUARANTINE_RECEIPT_KIND,
    manifest: {
      path: input.manifestPath,
      sha256: input.manifestSha256,
    },
    operator: input.controls.operator,
    outcome: input.execution.succeeded ? "succeeded" : "failed",
    promotionReceipt: {
      outcome: input.promotionReceipt.outcome,
      path: input.promotionReceiptPath,
      sha256: input.promotionReceiptSha256,
    },
    quarantinedAt: input.quarantinedAt,
    reconciliation: {
      absentIds: input.execution.absentIds,
      alreadyQuarantinedIds: input.execution.alreadyQuarantinedIds,
      quarantinedIds: input.execution.quarantinedIds,
    },
    reviewer: input.controls.reviewer,
    supabaseProjectRef: input.manifest.supabaseProjectRef,
    version: 1,
  };
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function ipv4InCidr(address: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

export function isPrivateOrReservedAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) {
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
    ].some(([base, prefix]) => ipv4InCidr(address, String(base), Number(prefix)));
  }
  if (kind === 6) {
    const normalized = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped) return isPrivateOrReservedAddress(mapped[1]!);
    return normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:");
  }
  return true;
}

async function assertPublicSourceUrl(sourceUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new Error("Source URL is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  ) {
    throw new Error("Source must use a public HTTP(S) URL without credentials or a non-standard port.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    (net.isIP(hostname) > 0 && isPrivateOrReservedAddress(hostname))
  ) {
    throw new Error("Source URL does not identify a public network host.");
  }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateOrReservedAddress(address))) {
    throw new Error("Source hostname did not resolve exclusively to public network addresses.");
  }
  return url;
}

export async function verifyReachablePublicSource(sourceUrl: string): Promise<void> {
  let current = sourceUrl;
  for (let redirect = 0; redirect <= MAX_SOURCE_REDIRECTS; redirect += 1) {
    const url = await assertPublicSourceUrl(current);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SOURCE_CHECK_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Range: "bytes=0-8191",
          "User-Agent": "PintPathReviewedPricePromotion/1.0 (+https://pintpath.au)",
        },
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirect === MAX_SOURCE_REDIRECTS) {
          throw new Error("Source redirect chain is incomplete or too long.");
        }
        current = new URL(location, url).toString();
        continue;
      }
      if (!response.ok && response.status !== 206) {
        throw new Error(`Public source returned HTTP ${response.status}.`);
      }
      return;
    } catch (error) {
      if (error instanceof Error && /^(Source|Public source)/.test(error.message)) {
        throw error;
      }
      throw new Error("Public source could not be reached within the fixed verification timeout.");
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("Source redirect chain is too long.");
}

function requiredEnvironment(name: "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseIds(value: string): string[] {
  if (/\s/.test(value)) {
    throw new Error("--ids must be a comma-separated list without whitespace.");
  }
  return assertExactUniqueIds(value.split(","));
}

const PLAN_ARGUMENTS = new Set([
  "--candidate-sha",
  "--database",
  "--expected-project-ref",
  "--ids",
  "--manifest",
]);
const APPLY_ARGUMENTS = new Set([
  "--approval-reference",
  "--backup-id",
  "--backup-manifest-sha256",
  "--backup-verified-at",
  "--candidate-sha",
  "--database",
  "--expected-project-ref",
  "--manifest",
  "--manifest-sha256",
  "--operator",
  "--receipt",
  "--reviewer",
]);
const QUARANTINE_ARGUMENTS = new Set([
  "--approval-reference",
  "--backup-id",
  "--backup-manifest-sha256",
  "--backup-verified-at",
  "--candidate-sha",
  "--database",
  "--expected-project-ref",
  "--manifest",
  "--manifest-sha256",
  "--operator",
  "--promotion-receipt",
  "--promotion-receipt-sha256",
  "--quarantine-receipt",
  "--reviewer",
]);

async function runPlan(argv: readonly string[]): Promise<void> {
  await import("dotenv/config");
  const args = parseStrictArguments(argv, { allowed: PLAN_ARGUMENTS, required: PLAN_ARGUMENTS });
  const databasePath = assertCanonicalAbsoluteFile(args.get("--database")!, "Database path");
  const manifestPath = assertNewCanonicalAbsoluteFile(args.get("--manifest")!, "Manifest path");
  const target = assertExactSupabaseProjectTarget(
    requiredEnvironment("SUPABASE_URL"),
    args.get("--expected-project-ref")!,
  );
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const manifest = await buildReviewedPricePromotionManifest({
      candidateSha: args.get("--candidate-sha")!,
      database,
      databasePath,
      ids: parseIds(args.get("--ids")!),
      sourceVerifier: verifyReachablePublicSource,
      supabaseOrigin: target.origin,
      supabaseProjectRef: target.projectRef,
    });
    const manifestSha256 = writeNewJsonArtifact(manifestPath, manifest);
    console.log(canonicalJson({
      itemCount: manifest.itemCount,
      candidateSha: manifest.candidateSha,
      manifestPath,
      manifestSha256,
      mode: "plan",
      ok: true,
      rowCount: manifest.rowCount,
      sourceSnapshotSha256: manifest.sourceSnapshotSha256,
      supabaseProjectRef: manifest.supabaseProjectRef,
    }).trimEnd());
  } finally {
    database.close();
  }
}

async function runApply(argv: readonly string[]): Promise<void> {
  const args = parseStrictArguments(argv, { allowed: APPLY_ARGUMENTS, required: APPLY_ARGUMENTS });
  assertOperatorMutationAllowed("Reviewed production price promotion");
  const databasePath = assertCanonicalAbsoluteFile(args.get("--database")!, "Database path");
  const manifestPath = assertCanonicalAbsoluteFile(args.get("--manifest")!, "Manifest path");
  const receiptPath = assertNewCanonicalAbsoluteFile(args.get("--receipt")!, "Receipt path");
  const target = assertExactSupabaseProjectTarget(
    requiredEnvironment("SUPABASE_URL"),
    args.get("--expected-project-ref")!,
  );
  assertProductionMutationTarget(target.projectRef);
  const controls = validateApplyControls({
    approvalReference: args.get("--approval-reference")!,
    backupId: args.get("--backup-id")!,
    backupManifestSha256: args.get("--backup-manifest-sha256")!,
    backupVerifiedAt: args.get("--backup-verified-at")!,
    operator: args.get("--operator")!,
    reviewer: args.get("--reviewer")!,
  }, new Date(), process.env);
  const loaded = loadReviewedPricePromotionManifest(
    manifestPath,
    args.get("--manifest-sha256")!,
  );
  assertReviewedManifestMutationTarget(loaded.manifest, {
    candidateSha: args.get("--candidate-sha")!,
    databasePath,
    supabaseOrigin: target.origin,
    supabaseProjectRef: target.projectRef,
  });

  const menuCaptureTable = process.env.SUPABASE_MENU_CAPTURE_TABLE?.trim() || "venue_menu_captures";
  if (menuCaptureTable !== "venue_menu_captures") {
    throw new Error("Reviewed production price promotion requires SUPABASE_MENU_CAPTURE_TABLE=venue_menu_captures.");
  }
  const ids = loaded.manifest.items.map((item) => item.id);
  let execution: PromotionExecutionResult = {
    afterPublicRows: [],
    beforePublicRows: [],
    failed: [],
    published: [],
    succeeded: false,
  };
  const receiptDescriptor = fs.openSync(receiptPath, "wx", 0o600);
  let receiptSha256: string;
  try {
    writeReservedJsonArtifact(receiptDescriptor, {
      approvalReferenceSha256: sha256Bytes(controls.approvalReference),
      backupAuthoritySha256: sha256Json({
        id: controls.backupId,
        manifestSha256: controls.backupManifestSha256,
        verifiedAt: controls.backupVerifiedAt,
      }),
      kind: RECEIPT_KIND,
      candidateSha: loaded.manifest.candidateSha,
      manifestSha256: loaded.sha256,
      operator: controls.operator,
      outcome: "in_progress",
      reviewer: controls.reviewer,
      supabaseProjectRef: loaded.manifest.supabaseProjectRef,
      version: 1,
    });

    let database: Database.Database | null = null;
    try {
      database = new Database(databasePath, { fileMustExist: true });
      const emergencyBeforeRows = listPublicRowsForIngestionIds(database, ids);
      execution = {
        ...execution,
        afterPublicRows: emergencyBeforeRows,
        beforePublicRows: emergencyBeforeRows,
      };
      const queueDatabase = await createLegacyQueueDatabase(database);
      const repository = new AdminIngestionQueueRepository(queueDatabase);
      let adminService: AdminService | null = null;
      execution = await executeReviewedPricePromotion({
        controls,
        database,
        manifest: loaded.manifest,
        queueDatabase,
        publisher: async (id, rows, note) => {
          // Construct the mutating service only after every exact manifest item
          // and public source has passed the read-only preflight.
          if (!adminService) {
            const { AdminService: AdminServiceConstructor } = await import(
              "../src/modules/admin/admin.service.js"
            );
            adminService = new AdminServiceConstructor(
              repository,
              target.origin,
              requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
              menuCaptureTable,
              undefined,
              undefined,
              queueDatabase,
            );
          }
          const result = await adminService.publishQueuedIngestion(id, { beers: rows, note });
          return { mapPriceRecordCount: result.mapPriceRecordCount, savedAt: result.savedAt };
        },
        sourceVerifier: verifyReachablePublicSource,
      });
    } catch (error) {
      let afterRows = execution.afterPublicRows;
      if (database) {
        try {
          afterRows = listPublicRowsForIngestionIds(database, ids);
        } catch {
          // Keep the last successfully captured state in the receipt.
        }
      }
      execution = {
        ...execution,
        afterPublicRows: afterRows,
        failed: [{
          error: redactSecrets(error instanceof Error ? error.message : "Unknown apply failure"),
          id: null,
          stage: "preflight",
        }],
        succeeded: false,
      };
    } finally {
      database?.close();
    }

    const receipt = buildPromotionReceipt({
      appliedAt: new Date().toISOString(),
      controls,
      execution,
      manifest: loaded.manifest,
      manifestPath,
      manifestSha256: loaded.sha256,
    });
    receiptSha256 = writeReservedJsonArtifact(receiptDescriptor, receipt);
  } finally {
    fs.closeSync(receiptDescriptor);
  }
  console.log(canonicalJson({
    failedCount: execution.failed.length,
    candidateSha: loaded.manifest.candidateSha,
    manifestSha256: loaded.sha256,
    mode: "apply",
    ok: execution.succeeded,
    publishedCount: execution.published.length,
    receiptPath,
    receiptSha256,
    supabaseProjectRef: loaded.manifest.supabaseProjectRef,
  }).trimEnd());
  if (!execution.succeeded) {
    throw new Error(`Reviewed price promotion failed; inspect the immutable receipt at ${receiptPath}.`);
  }
}

async function runQuarantine(argv: readonly string[]): Promise<void> {
  const args = parseStrictArguments(argv, {
    allowed: QUARANTINE_ARGUMENTS,
    required: QUARANTINE_ARGUMENTS,
  });
  assertOperatorMutationAllowed("Reviewed production price quarantine");
  const databasePath = assertCanonicalAbsoluteFile(args.get("--database")!, "Database path");
  const manifestPath = assertCanonicalAbsoluteFile(args.get("--manifest")!, "Manifest path");
  const promotionReceiptPath = assertCanonicalAbsoluteFile(
    args.get("--promotion-receipt")!,
    "Promotion receipt path",
  );
  const quarantineReceiptPath = assertNewCanonicalAbsoluteFile(
    args.get("--quarantine-receipt")!,
    "Quarantine receipt path",
  );
  const target = assertExactSupabaseProjectTarget(
    requiredEnvironment("SUPABASE_URL"),
    args.get("--expected-project-ref")!,
  );
  assertProductionMutationTarget(target.projectRef);
  const controls = validateApplyControls({
    approvalReference: args.get("--approval-reference")!,
    backupId: args.get("--backup-id")!,
    backupManifestSha256: args.get("--backup-manifest-sha256")!,
    backupVerifiedAt: args.get("--backup-verified-at")!,
    operator: args.get("--operator")!,
    reviewer: args.get("--reviewer")!,
  }, new Date(), process.env);
  const loadedManifest = loadReviewedPricePromotionManifest(
    manifestPath,
    args.get("--manifest-sha256")!,
  );
  const loadedPromotionReceipt = loadPromotionReceiptAuthority(
    promotionReceiptPath,
    args.get("--promotion-receipt-sha256")!,
  );
  assertReviewedManifestMutationTarget(loadedManifest.manifest, {
    candidateSha: args.get("--candidate-sha")!,
    databasePath,
    supabaseOrigin: target.origin,
    supabaseProjectRef: target.projectRef,
  });

  let execution: QuarantineExecutionResult = {
    absentIds: [],
    afterRows: [],
    alreadyQuarantinedIds: [],
    beforeRows: [],
    failed: [],
    queueHistoryAfterSha256: sha256Json([]),
    queueHistoryBeforeSha256: sha256Json([]),
    quarantinedIds: [],
    succeeded: false,
  };
  const quarantinedAt = new Date().toISOString();
  const receiptDescriptor = fs.openSync(quarantineReceiptPath, "wx", 0o600);
  let quarantineReceiptSha256: string;
  try {
    writeReservedJsonArtifact(receiptDescriptor, {
      candidateSha: loadedManifest.manifest.candidateSha,
      kind: QUARANTINE_RECEIPT_KIND,
      manifestSha256: loadedManifest.sha256,
      operator: controls.operator,
      outcome: "in_progress",
      promotionReceiptSha256: loadedPromotionReceipt.sha256,
      reviewer: controls.reviewer,
      supabaseProjectRef: loadedManifest.manifest.supabaseProjectRef,
      version: 1,
    });

    let database: Database.Database | null = null;
    try {
      database = new Database(databasePath, { fileMustExist: true });
      execution = await executeReviewedPriceQuarantine({
        controls,
        database,
        manifest: loadedManifest.manifest,
        manifestPath,
        manifestSha256: loadedManifest.sha256,
        now: quarantinedAt,
        promotionReceipt: loadedPromotionReceipt.receipt,
      });
    } catch (error) {
      execution = {
        ...execution,
        failed: [{
          error: redactSecrets(error instanceof Error ? error.message : "Unknown quarantine apply failure"),
          id: null,
          stage: "preflight",
        }],
        succeeded: false,
      };
    } finally {
      database?.close();
    }

    const receipt = buildQuarantineReceipt({
      controls,
      execution,
      manifest: loadedManifest.manifest,
      manifestPath,
      manifestSha256: loadedManifest.sha256,
      promotionReceipt: loadedPromotionReceipt.receipt,
      promotionReceiptPath,
      promotionReceiptSha256: loadedPromotionReceipt.sha256,
      quarantinedAt,
    });
    quarantineReceiptSha256 = writeReservedJsonArtifact(receiptDescriptor, receipt);
  } finally {
    fs.closeSync(receiptDescriptor);
  }

  console.log(canonicalJson({
    alreadyQuarantinedCount: execution.alreadyQuarantinedIds.length,
    candidateSha: loadedManifest.manifest.candidateSha,
    failedCount: execution.failed.length,
    mode: "quarantine",
    ok: execution.succeeded,
    quarantineReceiptPath,
    quarantineReceiptSha256,
    quarantinedCount: execution.quarantinedIds.length,
    reconciledAbsentCount: execution.absentIds.length,
    supabaseProjectRef: loadedManifest.manifest.supabaseProjectRef,
  }).trimEnd());
  if (!execution.succeeded) {
    throw new Error(`Reviewed price quarantine failed; inspect ${quarantineReceiptPath}.`);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "apply") {
    throw new Error(LEGACY_SQLITE_APPLY_DISABLED_ERROR);
  }
  if (mode === "quarantine") {
    throw new Error(LEGACY_SQLITE_QUARANTINE_DISABLED_ERROR);
  }
  if (mode === "plan") {
    await runPlan(process.argv.slice(3));
    return;
  }
  throw new Error("Choose exactly one mode: plan, apply, or quarantine.");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
