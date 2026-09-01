import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_LIST_BYTES = 64 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN = /^[^\r\n\0]{16,4096}$/;

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function expectedArchiveUrl(repository, artifactId) {
  return `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`;
}

export function githubArtifactMetadataExact(
  artifact,
  { repository, expectedName, expectedRunId },
) {
  return record(artifact)
    && Number.isSafeInteger(artifact.id)
    && artifact.id > 0
    && artifact.name === expectedName
    && artifact.expired === false
    && Number.isSafeInteger(artifact.size_in_bytes)
    && artifact.size_in_bytes > 1
    && artifact.size_in_bytes <= MAX_ARCHIVE_BYTES
    && DIGEST.test(artifact.digest)
    && artifact.archive_download_url === expectedArchiveUrl(
      repository,
      artifact.id,
    )
    && record(artifact.workflow_run)
    && String(artifact.workflow_run.id) === expectedRunId;
}

async function boundedArchive(response, expectedBytes) {
  if (!response.ok || !response.body || response.status !== 200) {
    throw new Error("artifact_download_invalid");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > expectedBytes || total > MAX_ARCHIVE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("artifact_download_invalid");
    }
    chunks.push(next.value);
  }
  if (total !== expectedBytes) throw new Error("artifact_download_invalid");
  return Buffer.concat(chunks);
}

function exactExpectedEntries(expectedEntries) {
  return Array.isArray(expectedEntries)
    && expectedEntries.length > 0
    && expectedEntries.length <= 8
    && expectedEntries.every((entry) => typeof entry === "string"
      && ENTRY.test(entry))
    && new Set(expectedEntries).size === expectedEntries.length;
}

function listArchiveEntries(archivePath, runCommand) {
  const source = runCommand(
    "/usr/bin/unzip",
    ["-Z1", archivePath],
    {
      encoding: "utf8",
      maxBuffer: MAX_LIST_BYTES,
      shell: false,
      timeout: 10_000,
    },
  );
  if (typeof source !== "string" || source.length === 0
    || source.includes("\0")) throw new Error("artifact_archive_invalid");
  const entries = source.trimEnd().split("\n");
  if (entries.length === 0 || entries.some((entry) => !ENTRY.test(entry))
    || new Set(entries).size !== entries.length) {
    throw new Error("artifact_archive_invalid");
  }
  return entries;
}

function requireRegularEntries(archivePath, entries, runCommand) {
  const source = runCommand(
    "/usr/bin/unzip",
    ["-Z", "-l", archivePath],
    {
      encoding: "utf8",
      maxBuffer: MAX_LIST_BYTES,
      shell: false,
      timeout: 10_000,
    },
  );
  if (typeof source !== "string" || source.includes("\0")) {
    throw new Error("artifact_archive_invalid");
  }
  const lines = source.split("\n").map((line) => line.trimStart());
  for (const entry of entries) {
    const matches = lines.filter((line) => line.endsWith(` ${entry}`));
    if (matches.length !== 1 || !matches[0].startsWith("-")) {
      throw new Error("artifact_archive_invalid");
    }
  }
}

function removeTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  const prefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(prefix)
    || !path.basename(resolved).startsWith("pintpath-github-artifact-")) {
    throw new Error("temporary_directory_invalid");
  }
  fs.rmSync(resolved, { recursive: true, force: false });
}

export async function downloadGithubArtifactBundle({
  artifact,
  repository,
  expectedName,
  expectedRunId,
  expectedEntries,
  token,
  fetchImpl = fetch,
  runCommand = execFileSync,
}) {
  if (!githubArtifactMetadataExact(artifact, {
    repository,
    expectedName,
    expectedRunId,
  }) || !exactExpectedEntries(expectedEntries) || !TOKEN.test(token)) {
    throw new Error("artifact_authority_invalid");
  }
  const response = await fetchImpl(artifact.archive_download_url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  const archive = await boundedArchive(response, artifact.size_in_bytes);
  if (`sha256:${sha256(archive)}` !== artifact.digest) {
    archive.fill(0);
    throw new Error("artifact_digest_mismatch");
  }

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pintpath-github-artifact-"),
  );
  fs.chmodSync(directory, 0o700);
  const archivePath = path.join(directory, "artifact.zip");
  const result = new Map();
  try {
    fs.writeFileSync(archivePath, archive, {
      flag: "wx",
      mode: 0o600,
    });
    const entries = listArchiveEntries(archivePath, runCommand);
    const expected = [...expectedEntries].sort();
    if (JSON.stringify([...entries].sort()) !== JSON.stringify(expected)) {
      throw new Error("artifact_entries_invalid");
    }
    requireRegularEntries(archivePath, entries, runCommand);
    for (const entry of expectedEntries) {
      const bytes = runCommand(
        "/usr/bin/unzip",
        ["-p", archivePath, entry],
        {
          encoding: null,
          maxBuffer: MAX_ENTRY_BYTES,
          shell: false,
          timeout: 10_000,
        },
      );
      if (!Buffer.isBuffer(bytes) || bytes.length <= 1
        || bytes.length > MAX_ENTRY_BYTES) {
        throw new Error("artifact_entry_invalid");
      }
      result.set(entry, Buffer.from(bytes));
    }
  } finally {
    archive.fill(0);
    removeTemporaryDirectory(directory);
  }
  return result;
}

export const githubArtifactBundleInternals = {
  boundedArchive,
  exactExpectedEntries,
  expectedArchiveUrl,
  listArchiveEntries,
  requireRegularEntries,
  sha256,
};
