import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  createDataBackup,
  listBackupFiles,
  sha256Bytes,
  verifyDataBackup,
} from "./data-backup.js";
import { logger } from "./logger.js";
import { redactSecrets } from "./redact.js";

interface OffsiteBackupConfig {
  databasePath: string;
  evidencePath: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  bucketName: string;
  retentionDays: number;
  onStatus?: (status: {
    state: "running" | "succeeded" | "failed";
    startedAt: string;
    completedAt: string | null;
    backupId?: string;
    objectCount?: number;
    bytes?: number;
    prunedBackups?: number;
    error?: string;
  }) => void;
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
  return "application/octet-stream";
}

async function collectStoredObjectPaths(
  client: SupabaseClient,
  bucketName: string,
  prefix: string,
): Promise<string[]> {
  const paths: string[] = [];
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
        paths.push(objectPath);
      } else {
        paths.push(...await collectStoredObjectPaths(client, bucketName, objectPath));
      }
    }
    if (entries.length < 100) break;
    offset += entries.length;
  }
  return paths;
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
    const objectPaths = await collectStoredObjectPaths(client, bucketName, entry.name);
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

export async function runOffsiteBackup(config: OffsiteBackupConfig): Promise<{
  backupId: string;
  objectCount: number;
  bytes: number;
  prunedBackups: number;
}> {
  const now = new Date();
  const backupId = backupIdFromDate(now);
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pint-path-offsite-"));
  const backupRoot = path.join(temporaryRoot, "payload");
  let client: SupabaseClient | null = null;
  const uploadedPaths: string[] = [];

  try {
    const manifest = await createDataBackup({
      sourceDatabase: config.databasePath,
      sourceEvidence: config.evidencePath,
      backupRoot,
    });
    await verifyDataBackup(backupRoot);

    client = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const files = await listBackupFiles(backupRoot);
    for (const file of files) {
      const bytes = await fs.promises.readFile(path.join(backupRoot, file.path));
      const objectPath = `${backupId}/${file.path}`;
      const { error } = await client.storage.from(config.bucketName).upload(
        objectPath,
        bytes,
        { contentType: contentTypeForPath(file.path), upsert: false },
      );
      if (error) throw error;
      uploadedPaths.push(objectPath);
    }

    for (const file of files) {
      const { data: remoteFile, error: downloadError } = await client.storage
        .from(config.bucketName)
        .download(`${backupId}/${file.path}`);
      if (downloadError || !remoteFile) {
        throw downloadError ?? new Error(`Off-site verification failed for ${file.path}.`);
      }
      const remoteBytes = Buffer.from(await remoteFile.arrayBuffer());
      if (remoteBytes.length !== file.bytes || sha256Bytes(remoteBytes) !== file.sha256) {
        throw new Error(`Off-site checksum verification failed for ${file.path}.`);
      }
    }

    const prunedBackups = await pruneExpiredBackups(
      client,
      config.bucketName,
      now,
      config.retentionDays,
      backupId,
    );
    const latest = Buffer.from(`${JSON.stringify({ backupId, createdAt: manifest.createdAt }, null, 2)}\n`);
    const { error: latestError } = await client.storage.from(config.bucketName).upload(
      "latest.json",
      latest,
      { contentType: "application/json", upsert: true },
    );
    if (latestError) throw latestError;

    return {
      backupId,
      objectCount: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      prunedBackups,
    };
  } catch (error) {
    if (client && uploadedPaths.length > 0) {
      try {
        for (let index = 0; index < uploadedPaths.length; index += 100) {
          const { error: cleanupError } = await client.storage
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

export function scheduleOffsiteBackups(config: OffsiteBackupConfig & { intervalHours: number }): void {
  let running = false;
  const execute = async () => {
    if (running) return;
    running = true;
    const startedAt = new Date().toISOString();
    config.onStatus?.({ state: "running", startedAt, completedAt: null });
    try {
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
      running = false;
    }
  };

  const initialTimer = setTimeout(() => void execute(), 30_000);
  initialTimer.unref();
  const interval = setInterval(() => void execute(), config.intervalHours * 60 * 60 * 1000);
  interval.unref();
}
