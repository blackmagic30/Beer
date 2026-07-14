import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  type AccountDeletionTombstone,
  type BackupStorageEvidence,
  createDataBackup,
  finalizeBackupSupplementalData,
  listBackupFiles,
  listAccountDeletionTombstones,
  listSupabaseEvidenceReferences,
  normalizeTombstones,
  parseAccountDeletionTombstones,
  sha256Bytes,
  verifyDataBackup,
} from "./data-backup.js";
import { logger } from "./logger.js";
import { redactSecrets } from "./redact.js";

export interface OffsiteBackupConfig {
  databasePath: string;
  evidencePath: string;
  sourceSupabaseUrl: string;
  sourceServiceRoleKey: string;
  destinationSupabaseUrl: string;
  destinationServiceRoleKey: string;
  sourceEvidenceBucketName?: string;
  bucketName: string;
  retentionDays: number;
  clientFactory?: ((url: string, serviceRoleKey: string) => SupabaseClient) | undefined;
  acquireLease?: (() => boolean | Promise<boolean>) | undefined;
  releaseLease?: (() => void | Promise<void>) | undefined;
  onStatus?: (status: {
    state: "running" | "succeeded" | "failed";
    startedAt: string;
    completedAt: string | null;
    backupId?: string;
    objectCount?: number;
    bytes?: number;
    sourceEvidenceObjects?: number;
    deletionTombstones?: number;
    prunedBackups?: number;
    error?: string;
  }) => void;
}

export interface AccountDeletionLedgerConfig {
  sourceSupabaseUrl: string;
  destinationSupabaseUrl: string;
  destinationServiceRoleKey: string;
  bucketName: string;
  clientFactory?: ((url: string, serviceRoleKey: string) => SupabaseClient) | undefined;
}

export interface AccountDeletionLedgerCheckpoint {
  version: 2;
  generatedAt: string;
  genesisPath: string;
  genesisSha256: string;
  currentLedgerPath: string;
  currentLedgerSha256: string;
  immutableObjectCount: number;
  immutableSetSha256: string;
  tombstoneCount: number;
  latestCompletedAt: string | null;
}

export interface VerifiedAccountDeletionLedger {
  bytes: Buffer;
  sha256: string;
  genesisBytes: Buffer;
  genesisSha256: string;
  checkpointBytes: Buffer;
  checkpointSha256: string;
  tombstones: AccountDeletionTombstone[];
  checkpoint: AccountDeletionLedgerCheckpoint;
}

export interface OffsiteBackupReadiness {
  status: "ok" | "failed" | "required_unconfigured";
  required: boolean;
  liveProbe: boolean;
  lastSuccessfulAt: string | null;
  ageHours: number | null;
  error?: string;
}

function backupIdFromDate(date: Date): string {
  return `pint-path-${date.toISOString().replace(/[:.]/g, "-")}`;
}

function backupDateFromId(value: string): Date | null {
  const match = /^pint-path-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-\d{3}Z$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ));
  return Number.isNaN(date.getTime()) ? null : date;
}

function contentTypeForPath(filePath: string): string {
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".heic")) return "image/heic";
  if (filePath.endsWith(".heif")) return "image/heif";
  if (filePath.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function normalizedProjectOrigin(value: string): string {
  const url = new URL(value);
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
}

function assertIndependentDestination(config: OffsiteBackupConfig): void {
  if (normalizedProjectOrigin(config.sourceSupabaseUrl) === normalizedProjectOrigin(config.destinationSupabaseUrl)) {
    throw new Error("Off-site backup destination must be a different Supabase project/provider from production.");
  }
}

function resolveContainedPath(root: string, relativePath: string): string {
  const normalizedRoot = path.resolve(root);
  const filePath = path.resolve(normalizedRoot, relativePath);
  if (filePath === normalizedRoot || !filePath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Unsafe Storage object path: ${relativePath}`);
  }
  return filePath;
}

function normalizeContentType(value: string | null | undefined, filePath: string): string {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || contentTypeForPath(filePath);
}

interface StoredObject {
  path: string;
  contentType: string;
}

const DEFAULT_SOURCE_EVIDENCE_BUCKET = "beermap-source-evidence";
const TOMBSTONE_LEDGER_PREFIX = "_control/account-deletion-ledger/v1";
const TOMBSTONE_LEDGER_GENESIS_PATH = "_control/account-deletion-ledger-genesis.json";
const CURRENT_TOMBSTONE_LEDGER_PATH = "_control/account-deletion-tombstones.json";
const TOMBSTONE_LEDGER_CHECKPOINT_PATH = "_control/account-deletion-ledger-checkpoint.json";
const MAX_RECONCILIATION_ATTEMPTS = 3;

function createStorageClient(
  config: OffsiteBackupConfig,
  url: string,
  serviceRoleKey: string,
): SupabaseClient {
  return config.clientFactory
    ? config.clientFactory(url, serviceRoleKey)
    : createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
}

async function assertPrivateBucket(
  client: SupabaseClient,
  bucketName: string,
  purpose: string,
): Promise<void> {
  const { data, error } = await client.storage.getBucket(bucketName);
  if (error || !data || data.public !== false) {
    throw error ?? new Error(`${purpose} bucket must exist and remain private: ${bucketName}`);
  }
}

async function assertBackupDestinationCapabilities(
  client: SupabaseClient,
  bucketName: string,
): Promise<void> {
  const { data, error } = await client.storage.getBucket(bucketName);
  if (error || !data) throw error ?? new Error("Off-site backup bucket metadata is unavailable.");
  const bucket = data as typeof data & {
    file_size_limit?: number | null;
    allowed_mime_types?: string[] | null;
  };
  const requiredMimeTypes = [
    "application/json", "application/octet-stream", "application/pdf",
    "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
  ];
  const allowedMimeTypes = new Set(bucket.allowed_mime_types ?? []);
  if (requiredMimeTypes.some((mimeType) => !allowedMimeTypes.has(mimeType))) {
    throw new Error("Off-site backup bucket MIME policy is incomplete (PDF/database/image support required).");
  }
  if (bucket.file_size_limit !== null) {
    throw new Error("Off-site backup bucket must not impose a bucket-level object cap on growing SQLite snapshots.");
  }
}

async function probeBackupDestinationReadWrite(
  client: SupabaseClient,
  bucketName: string,
): Promise<void> {
  const prefix = `_readiness/${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const canaries = [
    { path: `${prefix}/probe.pdf`, bytes: Buffer.from("%PDF-readiness"), contentType: "application/pdf" },
    { path: `${prefix}/probe.sqlite`, bytes: Buffer.from("SQLite format 3\0readiness"), contentType: "application/octet-stream" },
    { path: `${prefix}/probe.jpg`, bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), contentType: "image/jpeg" },
  ];
  try {
    for (const canary of canaries) {
      const { error } = await client.storage.from(bucketName).upload(
        canary.path,
        canary.bytes,
        { contentType: canary.contentType, upsert: false },
      );
      if (error) throw error;
    }
    const { data: listed, error: listError } = await client.storage.from(bucketName).list(prefix);
    if (listError || (listed?.length ?? 0) !== canaries.length) {
      throw listError ?? new Error("Backup readiness list canary failed.");
    }
    for (const canary of canaries) {
      const { data, error } = await client.storage.from(bucketName).download(canary.path);
      if (error || !data) throw error ?? new Error("Backup readiness download canary failed.");
      const bytes = Buffer.from(await data.arrayBuffer());
      const contentType = data.type?.split(";", 1)[0]?.trim().toLowerCase();
      if (!bytes.equals(canary.bytes) || (contentType && contentType !== canary.contentType)) {
        throw new Error("Backup readiness canary checksum/MIME verification failed.");
      }
    }
  } finally {
    const { error } = await client.storage.from(bucketName).remove(canaries.map((canary) => canary.path));
    if (error) throw error;
  }
}

let destinationCapabilityCache: { key: string; expiresAt: number; error: string | null } | null = null;

export async function probeOffsiteBackupReadiness(input: {
  sourceSupabaseUrl?: string | undefined;
  destinationSupabaseUrl?: string | undefined;
  destinationServiceRoleKey?: string | undefined;
  bucketName: string;
  lastSuccessfulAt: string | null;
  maxFreshnessHours: number;
  required: boolean;
  clientFactory?: ((url: string, serviceRoleKey: string) => SupabaseClient) | undefined;
}): Promise<OffsiteBackupReadiness> {
  const completedAtMs = input.lastSuccessfulAt ? Date.parse(input.lastSuccessfulAt) : Number.NaN;
  const ageHours = Number.isFinite(completedAtMs) ? (Date.now() - completedAtMs) / (60 * 60 * 1000) : null;
  if (!input.required) {
    return {
      status: "ok",
      required: false,
      liveProbe: false,
      lastSuccessfulAt: input.lastSuccessfulAt,
      ageHours,
    };
  }
  if (!input.sourceSupabaseUrl || !input.destinationSupabaseUrl || !input.destinationServiceRoleKey) {
    return {
      status: "required_unconfigured",
      required: true,
      liveProbe: false,
      lastSuccessfulAt: input.lastSuccessfulAt,
      ageHours,
      error: "destination_unconfigured",
    };
  }
  let capabilityError: string | null = null;
  const cacheKey = `${normalizedProjectOrigin(input.destinationSupabaseUrl)}:${input.bucketName}`;
  if (destinationCapabilityCache?.key === cacheKey && destinationCapabilityCache.expiresAt > Date.now()) {
    capabilityError = destinationCapabilityCache.error;
  } else {
    try {
      if (normalizedProjectOrigin(input.sourceSupabaseUrl) === normalizedProjectOrigin(input.destinationSupabaseUrl)) {
        throw new Error("destination_not_independent");
      }
      const client = input.clientFactory
        ? input.clientFactory(input.destinationSupabaseUrl, input.destinationServiceRoleKey)
        : createClient(input.destinationSupabaseUrl, input.destinationServiceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
      await assertPrivateBucket(client, input.bucketName, "Off-site backup destination");
      await assertBackupDestinationCapabilities(client, input.bucketName);
      await probeBackupDestinationReadWrite(client, input.bucketName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      capabilityError = message === "destination_not_independent"
        ? "destination_not_independent"
        : message.includes("private")
          ? "bucket_not_private_or_unreachable"
          : message.includes("MIME")
            ? "bucket_mime_types_incomplete"
            : message.includes("object cap")
              ? "bucket_object_cap_present"
              : "bucket_canary_failed";
    }
    destinationCapabilityCache = { key: cacheKey, expiresAt: Date.now() + 60_000, error: capabilityError };
  }
  const freshnessError = ageHours === null
    ? "no_successful_backup"
    : ageHours < 0 || ageHours > input.maxFreshnessHours
      ? "last_successful_backup_stale"
      : null;
  const error = capabilityError ?? freshnessError;
  return {
    status: error ? "failed" : "ok",
    required: true,
    liveProbe: true,
    lastSuccessfulAt: input.lastSuccessfulAt,
    ageHours,
    ...(error ? { error } : {}),
  };
}

async function collectStoredObjectPaths(
  client: SupabaseClient,
  bucketName: string,
  prefix: string,
): Promise<StoredObject[]> {
  const paths: StoredObject[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await client.storage.from(bucketName).list(prefix, {
      limit: 100,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    const entries = data ?? [];
    for (const entry of entries) {
      const objectPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id || entry.metadata) {
        const metadata = entry.metadata as Record<string, unknown> | null;
        paths.push({
          path: objectPath,
          contentType: normalizeContentType(
            typeof metadata?.mimetype === "string"
              ? metadata.mimetype
              : typeof metadata?.contentType === "string"
                ? metadata.contentType
                : null,
            objectPath,
          ),
        });
      } else {
        paths.push(...await collectStoredObjectPaths(client, bucketName, objectPath));
      }
    }
    if (entries.length < 100) break;
    offset += entries.length;
  }
  return paths.sort((first, second) => first.path.localeCompare(second.path));
}

async function pruneExpiredBackups(
  client: SupabaseClient,
  bucketName: string,
  now: Date,
  retentionDays: number,
  currentBackupId: string,
): Promise<number> {
  const { data, error } = await client.storage.from(bucketName).list("", {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) throw error;

  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  let removedBackups = 0;
  for (const entry of data ?? []) {
    if (entry.name === currentBackupId) continue;
    const backupDate = backupDateFromId(entry.name);
    if (!backupDate || backupDate.getTime() >= cutoff) continue;
    const objectPaths = (await collectStoredObjectPaths(client, bucketName, entry.name))
      .map((object) => object.path);
    for (let index = 0; index < objectPaths.length; index += 100) {
      const { error: removeError } = await client.storage
        .from(bucketName)
        .remove(objectPaths.slice(index, index + 100));
      if (removeError) throw removeError;
    }
    removedBackups += 1;
  }
  return removedBackups;
}

function tombstoneObjectPath(tombstone: AccountDeletionTombstone): string {
  const digest = sha256Bytes(Buffer.from(
    `${tombstone.requestId}\0${tombstone.userId}\0${tombstone.completedAt}`,
  ));
  return `${TOMBSTONE_LEDGER_PREFIX}/${digest}.json`;
}

function serializeTombstoneDocument(
  tombstones: AccountDeletionTombstone[],
  generatedAt: string,
): Buffer {
  return Buffer.from(`${JSON.stringify({
    version: 1,
    generatedAt,
    tombstones: normalizeTombstones(tombstones),
  }, null, 2)}\n`);
}

interface AccountDeletionLedgerGenesis {
  version: 1;
  kind: "pint-path-account-deletion-ledger-genesis";
  createdAt: string;
  immutablePrefix: string;
  currentLedgerPath: string;
}

function serializeLedgerGenesis(createdAt: string): Buffer {
  return Buffer.from(`${JSON.stringify({
    version: 1,
    kind: "pint-path-account-deletion-ledger-genesis",
    createdAt,
    immutablePrefix: TOMBSTONE_LEDGER_PREFIX,
    currentLedgerPath: CURRENT_TOMBSTONE_LEDGER_PATH,
  } satisfies AccountDeletionLedgerGenesis, null, 2)}\n`);
}

function parseLedgerGenesis(bytes: Buffer): AccountDeletionLedgerGenesis {
  const parsed = JSON.parse(bytes.toString("utf8")) as AccountDeletionLedgerGenesis;
  if (
    parsed.version !== 1 ||
    parsed.kind !== "pint-path-account-deletion-ledger-genesis" ||
    !parsed.createdAt ||
    Number.isNaN(Date.parse(parsed.createdAt)) ||
    parsed.immutablePrefix !== TOMBSTONE_LEDGER_PREFIX ||
    parsed.currentLedgerPath !== CURRENT_TOMBSTONE_LEDGER_PATH
  ) {
    throw new Error("Invalid independent account-deletion ledger genesis record.");
  }
  return parsed;
}

async function downloadBytes(
  client: SupabaseClient,
  bucketName: string,
  objectPath: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const { data, error } = await client.storage.from(bucketName).download(objectPath);
  if (error || !data) throw error ?? new Error(`Storage download failed: ${objectPath}`);
  return {
    bytes: Buffer.from(await data.arrayBuffer()),
    contentType: normalizeContentType(data.type, objectPath),
  };
}

async function ensureLedgerGenesis(
  client: SupabaseClient,
  bucketName: string,
  now: Date,
): Promise<{ bytes: Buffer; sha256: string; document: AccountDeletionLedgerGenesis }> {
  try {
    const existing = await downloadBytes(client, bucketName, TOMBSTONE_LEDGER_GENESIS_PATH);
    return {
      bytes: existing.bytes,
      sha256: sha256Bytes(existing.bytes),
      document: parseLedgerGenesis(existing.bytes),
    };
  } catch {
    const body = serializeLedgerGenesis(now.toISOString());
    const { error } = await client.storage.from(bucketName).upload(
      TOMBSTONE_LEDGER_GENESIS_PATH,
      body,
      { contentType: "application/json", upsert: false },
    );
    if (error) {
      // A concurrent first writer may have created the immutable genesis. It is
      // safe to continue only after that exact object parses and is checkpointed.
      const concurrent = await downloadBytes(client, bucketName, TOMBSTONE_LEDGER_GENESIS_PATH);
      return {
        bytes: concurrent.bytes,
        sha256: sha256Bytes(concurrent.bytes),
        document: parseLedgerGenesis(concurrent.bytes),
      };
    }
    const remote = await downloadBytes(client, bucketName, TOMBSTONE_LEDGER_GENESIS_PATH);
    if (sha256Bytes(remote.bytes) !== sha256Bytes(body)) {
      throw new Error("Account-deletion ledger genesis failed remote checksum verification.");
    }
    return {
      bytes: remote.bytes,
      sha256: sha256Bytes(remote.bytes),
      document: parseLedgerGenesis(remote.bytes),
    };
  }
}

interface AppendOnlyLedgerState {
  tombstones: AccountDeletionTombstone[];
  objectCount: number;
  immutableSetSha256: string;
}

async function loadAppendOnlyLedgerState(
  client: SupabaseClient,
  bucketName: string,
): Promise<AppendOnlyLedgerState> {
  const objects = await collectStoredObjectPaths(client, bucketName, TOMBSTONE_LEDGER_PREFIX);
  const tombstones: AccountDeletionTombstone[] = [];
  const immutableObjects: Array<{ path: string; sha256: string }> = [];
  for (const object of objects) {
    const { bytes } = await downloadBytes(client, bucketName, object.path);
    let parsed;
    try {
      parsed = parseAccountDeletionTombstones(bytes);
    } catch {
      throw new Error(`Invalid append-only account-deletion ledger object: ${object.path}`);
    }
    if (parsed.tombstones.length !== 1) {
      throw new Error(`Append-only account-deletion ledger object must contain one tombstone: ${object.path}`);
    }
    const tombstone = parsed.tombstones[0]!;
    const expectedPath = tombstoneObjectPath(tombstone);
    const expectedBytes = serializeTombstoneDocument([tombstone], tombstone.completedAt);
    if (object.path !== expectedPath || sha256Bytes(bytes) !== sha256Bytes(expectedBytes)) {
      throw new Error(`Append-only account-deletion ledger object is not canonical: ${object.path}`);
    }
    tombstones.push(tombstone);
    immutableObjects.push({ path: object.path, sha256: sha256Bytes(bytes) });
  }
  return {
    tombstones: normalizeTombstones(tombstones),
    objectCount: immutableObjects.length,
    immutableSetSha256: sha256Bytes(Buffer.from(JSON.stringify(immutableObjects))),
  };
}

async function loadAppendOnlyTombstones(
  client: SupabaseClient,
  bucketName: string,
): Promise<AccountDeletionTombstone[]> {
  return (await loadAppendOnlyLedgerState(client, bucketName)).tombstones;
}

function sameTombstones(
  first: AccountDeletionTombstone[],
  second: AccountDeletionTombstone[],
): boolean {
  const normalizedFirst = normalizeTombstones(first);
  const normalizedSecond = normalizeTombstones(second);
  return normalizedFirst.length === normalizedSecond.length && normalizedFirst.every((tombstone, index) => (
    tombstone.requestId === normalizedSecond[index]?.requestId &&
    tombstone.userId === normalizedSecond[index]?.userId &&
    tombstone.completedAt === normalizedSecond[index]?.completedAt
  ));
}

async function publishCurrentTombstoneLedger(
  client: SupabaseClient,
  bucketName: string,
  now: Date,
): Promise<AccountDeletionTombstone[]> {
  const genesis = await ensureLedgerGenesis(client, bucketName, now);
  for (let attempt = 1; attempt <= MAX_RECONCILIATION_ATTEMPTS; attempt += 1) {
    const state = await loadAppendOnlyLedgerState(client, bucketName);
    const currentBody = serializeTombstoneDocument(state.tombstones, now.toISOString());
    const { error } = await client.storage.from(bucketName).upload(
      CURRENT_TOMBSTONE_LEDGER_PATH,
      currentBody,
      { contentType: "application/json", upsert: true },
    );
    if (error) throw error;
    const verifiedCurrent = await downloadBytes(client, bucketName, CURRENT_TOMBSTONE_LEDGER_PATH);
    if (sha256Bytes(verifiedCurrent.bytes) !== sha256Bytes(currentBody)) {
      if (attempt < MAX_RECONCILIATION_ATTEMPTS) continue;
      throw new Error("Current account-deletion ledger failed remote checksum verification.");
    }
    const checkpoint: AccountDeletionLedgerCheckpoint = {
      version: 2,
      generatedAt: now.toISOString(),
      genesisPath: TOMBSTONE_LEDGER_GENESIS_PATH,
      genesisSha256: genesis.sha256,
      currentLedgerPath: CURRENT_TOMBSTONE_LEDGER_PATH,
      currentLedgerSha256: sha256Bytes(currentBody),
      immutableObjectCount: state.objectCount,
      immutableSetSha256: state.immutableSetSha256,
      tombstoneCount: state.tombstones.length,
      latestCompletedAt: state.tombstones.reduce<string | null>(
        (latest, tombstone) => latest === null || Date.parse(tombstone.completedAt) > Date.parse(latest)
          ? tombstone.completedAt
          : latest,
        null,
      ),
    };
    const checkpointBody = Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`);
    const { error: checkpointError } = await client.storage.from(bucketName).upload(
      TOMBSTONE_LEDGER_CHECKPOINT_PATH,
      checkpointBody,
      { contentType: "application/json", upsert: true },
    );
    if (checkpointError) throw checkpointError;
    const verifiedCheckpoint = await downloadBytes(client, bucketName, TOMBSTONE_LEDGER_CHECKPOINT_PATH);
    if (sha256Bytes(verifiedCheckpoint.bytes) !== sha256Bytes(checkpointBody)) {
      if (attempt < MAX_RECONCILIATION_ATTEMPTS) continue;
      throw new Error("Account-deletion ledger checkpoint failed remote checksum verification.");
    }
    const stateAfterWrite = await loadAppendOnlyLedgerState(client, bucketName);
    const genesisAfterWrite = await downloadBytes(client, bucketName, TOMBSTONE_LEDGER_GENESIS_PATH);
    parseLedgerGenesis(genesisAfterWrite.bytes);
    if (
      genesis.sha256 === sha256Bytes(genesisAfterWrite.bytes) &&
      state.immutableSetSha256 === stateAfterWrite.immutableSetSha256 &&
      sameTombstones(state.tombstones, stateAfterWrite.tombstones)
    ) {
      return stateAfterWrite.tombstones;
    }
  }
  throw new Error("Current account-deletion ledger could not converge with its immutable entries.");
}

async function ensureAppendOnlyTombstones(input: {
  client: SupabaseClient;
  bucketName: string;
  tombstones: AccountDeletionTombstone[];
  now: Date;
}): Promise<AccountDeletionTombstone[]> {
  const existing = await loadAppendOnlyTombstones(input.client, input.bucketName);
  const existingPaths = new Set(existing.map(tombstoneObjectPath));
  for (const tombstone of normalizeTombstones(input.tombstones)) {
    const objectPath = tombstoneObjectPath(tombstone);
    if (existingPaths.has(objectPath)) continue;
    const body = serializeTombstoneDocument([tombstone], tombstone.completedAt);
    const { error } = await input.client.storage.from(input.bucketName).upload(
      objectPath,
      body,
      { contentType: "application/json", upsert: false },
    );
    if (error) {
      // A concurrent writer may have created the same immutable object. It is
      // only safe to continue when the remote bytes are exactly what we expect.
      const remote = await downloadBytes(input.client, input.bucketName, objectPath);
      if (sha256Bytes(remote.bytes) !== sha256Bytes(body)) throw error;
    }
  }

  return publishCurrentTombstoneLedger(input.client, input.bucketName, input.now);
}

/**
 * Durably records an account deletion before the local deletion transaction is
 * allowed to mark the request complete. The immutable object key and bytes are
 * deterministic, so retrying the same deletion is safe.
 */
export async function appendAccountDeletionTombstone(
  config: AccountDeletionLedgerConfig,
  tombstone: AccountDeletionTombstone,
): Promise<{ ledgerCount: number; currentLedgerPath: string }> {
  if (normalizedProjectOrigin(config.sourceSupabaseUrl) === normalizedProjectOrigin(config.destinationSupabaseUrl)) {
    throw new Error("Account-deletion ledger destination must be independent from the production Supabase project.");
  }
  const normalized = normalizeTombstones([tombstone]);
  if (normalized.length !== 1) throw new Error("A valid account-deletion tombstone is required.");
  const client = config.clientFactory
    ? config.clientFactory(config.destinationSupabaseUrl, config.destinationServiceRoleKey)
    : createClient(config.destinationSupabaseUrl, config.destinationServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  await assertPrivateBucket(client, config.bucketName, "Account-deletion ledger destination");
  const complete = await ensureAppendOnlyTombstones({
    client,
    bucketName: config.bucketName,
    tombstones: normalized,
    now: new Date(),
  });
  if (!complete.some((entry) => (
    entry.requestId === normalized[0]!.requestId &&
    entry.userId === normalized[0]!.userId &&
    entry.completedAt === normalized[0]!.completedAt
  ))) {
    throw new Error("Account-deletion tombstone did not survive ledger verification.");
  }
  return { ledgerCount: complete.length, currentLedgerPath: CURRENT_TOMBSTONE_LEDGER_PATH };
}

function parseLedgerCheckpoint(bytes: Buffer): AccountDeletionLedgerCheckpoint {
  const parsed = JSON.parse(bytes.toString("utf8")) as AccountDeletionLedgerCheckpoint;
  if (
    parsed.version !== 2 ||
    !parsed.generatedAt ||
    Number.isNaN(Date.parse(parsed.generatedAt)) ||
    parsed.genesisPath !== TOMBSTONE_LEDGER_GENESIS_PATH ||
    !/^[a-f0-9]{64}$/.test(parsed.genesisSha256) ||
    parsed.currentLedgerPath !== CURRENT_TOMBSTONE_LEDGER_PATH ||
    !/^[a-f0-9]{64}$/.test(parsed.currentLedgerSha256) ||
    !Number.isInteger(parsed.immutableObjectCount) ||
    parsed.immutableObjectCount < 0 ||
    !/^[a-f0-9]{64}$/.test(parsed.immutableSetSha256) ||
    !Number.isInteger(parsed.tombstoneCount) ||
    parsed.tombstoneCount < 0 ||
    (parsed.tombstoneCount === 0 && parsed.latestCompletedAt !== null) ||
    (parsed.tombstoneCount > 0 && (
      !parsed.latestCompletedAt ||
      Number.isNaN(Date.parse(parsed.latestCompletedAt))
    ))
  ) {
    throw new Error("Invalid independent account-deletion ledger checkpoint.");
  }
  return parsed;
}

/**
 * Reads the immutable objects, current aggregate, and checkpoint directly from
 * the independent destination. All three views must agree before restoration.
 */
export async function fetchVerifiedAccountDeletionLedger(
  config: AccountDeletionLedgerConfig,
): Promise<VerifiedAccountDeletionLedger> {
  if (normalizedProjectOrigin(config.sourceSupabaseUrl) === normalizedProjectOrigin(config.destinationSupabaseUrl)) {
    throw new Error("Account-deletion ledger destination must be independent from the production Supabase project.");
  }
  const client = config.clientFactory
    ? config.clientFactory(config.destinationSupabaseUrl, config.destinationServiceRoleKey)
    : createClient(config.destinationSupabaseUrl, config.destinationServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
  });
  await assertPrivateBucket(client, config.bucketName, "Account-deletion ledger destination");
  const genesis = await downloadBytes(client, config.bucketName, TOMBSTONE_LEDGER_GENESIS_PATH);
  parseLedgerGenesis(genesis.bytes);
  const immutableBefore = await loadAppendOnlyLedgerState(client, config.bucketName);
  const current = await downloadBytes(client, config.bucketName, CURRENT_TOMBSTONE_LEDGER_PATH);
  const currentDocument = parseAccountDeletionTombstones(current.bytes);
  const checkpointBytes = await downloadBytes(client, config.bucketName, TOMBSTONE_LEDGER_CHECKPOINT_PATH);
  const checkpoint = parseLedgerCheckpoint(checkpointBytes.bytes);
  const immutableAfter = await loadAppendOnlyLedgerState(client, config.bucketName);
  const genesisAfter = await downloadBytes(client, config.bucketName, TOMBSTONE_LEDGER_GENESIS_PATH);
  parseLedgerGenesis(genesisAfter.bytes);
  const expectedLatestCompletedAt = immutableBefore.tombstones.reduce<string | null>(
    (latest, tombstone) => latest === null || Date.parse(tombstone.completedAt) > Date.parse(latest)
      ? tombstone.completedAt
      : latest,
    null,
  );
  if (
    sha256Bytes(genesis.bytes) !== sha256Bytes(genesisAfter.bytes) ||
    immutableBefore.immutableSetSha256 !== immutableAfter.immutableSetSha256 ||
    !sameTombstones(immutableBefore.tombstones, immutableAfter.tombstones) ||
    !sameTombstones(immutableBefore.tombstones, currentDocument.tombstones) ||
    checkpoint.genesisSha256 !== sha256Bytes(genesis.bytes) ||
    checkpoint.currentLedgerSha256 !== sha256Bytes(current.bytes) ||
    checkpoint.immutableObjectCount !== immutableBefore.objectCount ||
    checkpoint.immutableSetSha256 !== immutableBefore.immutableSetSha256 ||
    checkpoint.tombstoneCount !== immutableBefore.tombstones.length ||
    checkpoint.latestCompletedAt !== expectedLatestCompletedAt
  ) {
    throw new Error("The independent account-deletion ledger is stale, tampered, or changed during verification.");
  }
  return {
    bytes: current.bytes,
    sha256: sha256Bytes(current.bytes),
    genesisBytes: genesis.bytes,
    genesisSha256: sha256Bytes(genesis.bytes),
    checkpointBytes: checkpointBytes.bytes,
    checkpointSha256: sha256Bytes(checkpointBytes.bytes),
    tombstones: immutableBefore.tombstones,
    checkpoint,
  };
}

function storageObjectSetsMatch(first: StoredObject[], second: StoredObject[]): boolean {
  if (first.length !== second.length) return false;
  return first.every((object, index) => (
    object.path === second[index]?.path && object.contentType === second[index]?.contentType
  ));
}

async function exportReconciledSourceEvidence(input: {
  sourceClient: SupabaseClient;
  sourceBucketName: string;
  backupRoot: string;
  databasePath: string;
  attempt: number;
}): Promise<BackupStorageEvidence> {
  const objectsBefore = await collectStoredObjectPaths(
    input.sourceClient,
    input.sourceBucketName,
    "",
  );
  const storageRoot = path.join(input.backupRoot, "supabase-source-evidence");
  await fs.promises.mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const contentTypes = new Map<string, string>();
  for (const object of objectsBefore) {
    const remote = await downloadBytes(input.sourceClient, input.sourceBucketName, object.path);
    const destination = resolveContainedPath(storageRoot, object.path);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(destination, remote.bytes, { mode: 0o600 });
    contentTypes.set(object.path, normalizeContentType(remote.contentType || object.contentType, object.path));
  }
  const objectsAfter = await collectStoredObjectPaths(
    input.sourceClient,
    input.sourceBucketName,
    "",
  );
  if (!storageObjectSetsMatch(objectsBefore, objectsAfter)) {
    throw new Error("Source-evidence Storage changed while the backup snapshot was being captured.");
  }

  const files = (await listBackupFiles(storageRoot)).map((file) => ({
    ...file,
    contentType: contentTypes.get(file.path) ?? contentTypeForPath(file.path),
  }));
  const references = listSupabaseEvidenceReferences(input.databasePath);
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  for (const reference of references) {
    const file = filesByPath.get(reference.objectPath);
    if (!file) {
      throw new Error(`Database-referenced source evidence is missing from Storage: ${reference.objectPath}`);
    }
    if (reference.byteSize !== null && reference.byteSize !== file.bytes) {
      throw new Error(`Database and Storage evidence byte sizes disagree: ${reference.objectPath}`);
    }
    const databaseMimeType = reference.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
    if (databaseMimeType && databaseMimeType !== file.contentType) {
      throw new Error(`Database and Storage evidence MIME types disagree: ${reference.objectPath}`);
    }
  }
  const referencePaths = new Set(references.map((reference) => reference.objectPath));
  return {
    provider: "supabase",
    bucket: input.sourceBucketName,
    path: path.basename(storageRoot),
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
    databaseReferenceCount: references.length,
    orphanPaths: files
      .map((file) => file.path)
      .filter((filePath) => !referencePaths.has(filePath))
      .sort((first, second) => first.localeCompare(second)),
    reconciliationAttempts: input.attempt,
  };
}

async function createReconciledBackup(input: {
  config: OffsiteBackupConfig;
  sourceClient: SupabaseClient;
  sourceBucketName: string;
  backupRoot: string;
  priorTombstones: AccountDeletionTombstone[];
}): Promise<{ manifest: Awaited<ReturnType<typeof verifyDataBackup>>; tombstones: AccountDeletionTombstone[] }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_RECONCILIATION_ATTEMPTS; attempt += 1) {
    try {
      await fs.promises.rm(input.backupRoot, { recursive: true, force: true });
      await createDataBackup({
        sourceDatabase: input.config.databasePath,
        sourceEvidence: input.config.evidencePath,
        backupRoot: input.backupRoot,
      });
      const backupDatabase = path.join(input.backupRoot, "pint-path.sqlite");
      const storageEvidence = await exportReconciledSourceEvidence({
        sourceClient: input.sourceClient,
        sourceBucketName: input.sourceBucketName,
        backupRoot: input.backupRoot,
        databasePath: backupDatabase,
        attempt,
      });
      const tombstones = normalizeTombstones([
        ...input.priorTombstones,
        ...listAccountDeletionTombstones(input.config.databasePath),
      ]);
      await finalizeBackupSupplementalData({
        backupRoot: input.backupRoot,
        storageEvidence,
        deletionTombstones: tombstones,
      });
      return { manifest: await verifyDataBackup(input.backupRoot), tombstones };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RECONCILIATION_ATTEMPTS) continue;
    }
  }
  throw new Error(
    `Could not capture a reconciled database/evidence snapshot after ${MAX_RECONCILIATION_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function runOffsiteBackup(config: OffsiteBackupConfig): Promise<{
  backupId: string;
  objectCount: number;
  bytes: number;
  sourceEvidenceObjects: number;
  deletionTombstones: number;
  prunedBackups: number;
}> {
  assertIndependentDestination(config);
  if (!Number.isInteger(config.retentionDays) || config.retentionDays < 7 || config.retentionDays > 30) {
    throw new Error("Off-site backup retention must be between 7 and 30 days.");
  }
  const now = new Date();
  const backupId = backupIdFromDate(now);
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pint-path-offsite-"));
  const backupRoot = path.join(temporaryRoot, "payload");
  const sourceBucketName = config.sourceEvidenceBucketName || DEFAULT_SOURCE_EVIDENCE_BUCKET;
  let destinationClient: SupabaseClient | null = null;
  const uploadedPaths: string[] = [];

  try {
    const sourceClient = createStorageClient(config, config.sourceSupabaseUrl, config.sourceServiceRoleKey);
    destinationClient = createStorageClient(
      config,
      config.destinationSupabaseUrl,
      config.destinationServiceRoleKey,
    );
    await assertPrivateBucket(sourceClient, sourceBucketName, "Source evidence");
    await assertPrivateBucket(destinationClient, config.bucketName, "Off-site backup destination");
    await assertBackupDestinationCapabilities(destinationClient, config.bucketName);
    const priorTombstones = await loadAppendOnlyTombstones(destinationClient, config.bucketName);
    const captured = await createReconciledBackup({
      config,
      sourceClient,
      sourceBucketName,
      backupRoot,
      priorTombstones,
    });
    const completeTombstones = await ensureAppendOnlyTombstones({
      client: destinationClient,
      bucketName: config.bucketName,
      tombstones: captured.tombstones,
      now,
    });
    const manifest = await finalizeBackupSupplementalData({
      backupRoot,
      storageEvidence: captured.manifest.storageEvidence!,
      deletionTombstones: completeTombstones,
    });
    await verifyDataBackup(backupRoot);

    const files = await listBackupFiles(backupRoot);
    const contentTypes = new Map(
      (manifest.storageEvidence?.files ?? []).map((file) => [
        `${manifest.storageEvidence!.path}/${file.path}`,
        file.contentType,
      ]),
    );
    for (const file of files) {
      const bytes = await fs.promises.readFile(path.join(backupRoot, file.path));
      const objectPath = `${backupId}/${file.path}`;
      const { error } = await destinationClient.storage.from(config.bucketName).upload(
        objectPath,
        bytes,
        { contentType: contentTypes.get(file.path) ?? contentTypeForPath(file.path), upsert: false },
      );
      if (error) throw error;
      uploadedPaths.push(objectPath);
    }

    for (const file of files) {
      const { data: remoteFile, error: downloadError } = await destinationClient.storage
        .from(config.bucketName)
        .download(`${backupId}/${file.path}`);
      if (downloadError || !remoteFile) {
        throw downloadError ?? new Error(`Off-site verification failed for ${file.path}.`);
      }
      const remoteBytes = Buffer.from(await remoteFile.arrayBuffer());
      if (remoteBytes.length !== file.bytes || sha256Bytes(remoteBytes) !== file.sha256) {
        throw new Error(`Off-site checksum verification failed for ${file.path}.`);
      }
      const expectedContentType = contentTypes.get(file.path);
      if (expectedContentType) {
        const actualContentType = remoteFile.type?.split(";", 1)[0]?.trim().toLowerCase();
        if (!actualContentType || actualContentType !== expectedContentType) {
          throw new Error(`Off-site MIME verification failed for ${file.path}.`);
        }
      }
    }

    const prunedBackups = await pruneExpiredBackups(
      destinationClient,
      config.bucketName,
      now,
      config.retentionDays,
      backupId,
    );
    const currentLedger = await downloadBytes(
      destinationClient,
      config.bucketName,
      CURRENT_TOMBSTONE_LEDGER_PATH,
    );
    const currentGenesis = await downloadBytes(
      destinationClient,
      config.bucketName,
      TOMBSTONE_LEDGER_GENESIS_PATH,
    );
    const currentCheckpoint = await downloadBytes(
      destinationClient,
      config.bucketName,
      TOMBSTONE_LEDGER_CHECKPOINT_PATH,
    );
    const latest = Buffer.from(`${JSON.stringify({
      backupId,
      createdAt: manifest.createdAt,
      deletionTombstoneGenesis: TOMBSTONE_LEDGER_GENESIS_PATH,
      deletionTombstoneGenesisSha256AtBackup: sha256Bytes(currentGenesis.bytes),
      deletionTombstoneLedger: CURRENT_TOMBSTONE_LEDGER_PATH,
      deletionTombstoneLedgerSha256AtBackup: sha256Bytes(currentLedger.bytes),
      deletionTombstoneCheckpoint: TOMBSTONE_LEDGER_CHECKPOINT_PATH,
      deletionTombstoneCheckpointSha256AtBackup: sha256Bytes(currentCheckpoint.bytes),
    }, null, 2)}\n`);
    const { error: latestError } = await destinationClient.storage.from(config.bucketName).upload(
      "latest.json",
      latest,
      { contentType: "application/json", upsert: true },
    );
    if (latestError) throw latestError;

    return {
      backupId,
      objectCount: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      sourceEvidenceObjects: manifest.storageEvidence?.fileCount ?? 0,
      deletionTombstones: completeTombstones.length,
      prunedBackups,
    };
  } catch (error) {
    if (destinationClient && uploadedPaths.length > 0) {
      try {
        for (let index = 0; index < uploadedPaths.length; index += 100) {
          const { error: cleanupError } = await destinationClient.storage
            .from(config.bucketName)
            .remove(uploadedPaths.slice(index, index + 100));
          if (cleanupError) throw cleanupError;
        }
      } catch (cleanupError) {
        logger.warn("Could not fully remove a partial off-site backup", {
          backupId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
    throw error;
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function scheduleOffsiteBackups(
  config: OffsiteBackupConfig & { intervalHours: number },
): { stop: () => Promise<void>; runNow: () => Promise<void> } {
  let stopped = false;
  let activeRun: Promise<void> | null = null;
  const execute = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (activeRun) return activeRun;
    const pending = (async () => {
    let leaseAcquired = false;
    const startedAt = new Date().toISOString();
    try {
      leaseAcquired = config.acquireLease ? await config.acquireLease() : true;
      if (!leaseAcquired) return;
      config.onStatus?.({ state: "running", startedAt, completedAt: null });
      const result = await runOffsiteBackup(config);
      config.onStatus?.({
        state: "succeeded",
        startedAt,
        completedAt: new Date().toISOString(),
        ...result,
      });
      logger.info("Off-site production backup completed", result);
    } catch (error) {
      config.onStatus?.({
        state: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? redactSecrets(error.message).slice(0, 300) : "Off-site backup failed",
      });
      logger.error("Off-site production backup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (leaseAcquired) await config.releaseLease?.();
    }
    })();
    activeRun = pending.finally(() => {
      activeRun = null;
    });
    return activeRun;
  };

  const initialTimer = setTimeout(() => void execute(), 30_000);
  initialTimer.unref();
  const interval = setInterval(() => void execute(), config.intervalHours * 60 * 60 * 1000);
  interval.unref();
  return {
    async stop() {
      if (stopped) {
        await activeRun;
        return;
      }
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
      await activeRun;
    },
    runNow: execute,
  };
}
