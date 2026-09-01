import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  downloadGithubArtifactBundle,
  githubArtifactMetadataExact,
} from "../scripts/lib/github-artifact-bundle.mjs";

const repository = "blackmagic30/Beer";
const name = "pintpath-test-artifact";
const runId = "123";
const token = "test-token-with-sufficient-length";
const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-bundle-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function zip(entries: Record<string, string>, options: { symlink?: string } = {}) {
  const directory = temporaryDirectory();
  for (const [leaf, source] of Object.entries(entries)) {
    fs.writeFileSync(path.join(directory, leaf), source, { mode: 0o600 });
  }
  if (options.symlink) {
    fs.symlinkSync("closeout.json", path.join(directory, options.symlink));
  }
  const archive = path.join(directory, "artifact.zip");
  const leaves = [
    ...Object.keys(entries),
    ...(options.symlink ? [options.symlink] : []),
  ];
  execFileSync("/usr/bin/zip", [
    "-q",
    "-j",
    ...(options.symlink ? ["-y"] : []),
    archive,
    ...leaves,
  ], { cwd: directory, shell: false });
  return fs.readFileSync(archive);
}

function artifact(archive: Buffer, overrides: Record<string, unknown> = {}) {
  const id = 456;
  return {
    id,
    name,
    expired: false,
    size_in_bytes: archive.length,
    digest: `sha256:${crypto.createHash("sha256").update(archive).digest("hex")}`,
    archive_download_url:
      `https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`,
    workflow_run: { id: Number(runId) },
    ...overrides,
  };
}

function fetchArchive(archive: Buffer) {
  return async () => new Response(archive, {
    status: 200,
    headers: { "content-type": "application/zip" },
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("bounded GitHub artifact bundles", () => {
  it("downloads only the exact regular flat entries after checking API digest", async () => {
    const archive = zip({
      "closeout.json": "{\"ok\":true}\n",
      "provider-evidence.json": "{\"state\":\"SAFE_ONE_FINAL\"}\n",
    });
    const metadata = artifact(archive);
    expect(githubArtifactMetadataExact(metadata, {
      repository,
      expectedName: name,
      expectedRunId: runId,
    })).toBe(true);
    const result = await downloadGithubArtifactBundle({
      artifact: metadata,
      repository,
      expectedName: name,
      expectedRunId: runId,
      expectedEntries: ["closeout.json", "provider-evidence.json"],
      token,
      fetchImpl: fetchArchive(archive) as typeof fetch,
    });
    expect(result.get("closeout.json")?.toString("utf8"))
      .toBe("{\"ok\":true}\n");
  });

  it("rejects a digest mismatch before inspecting archive entries", async () => {
    const archive = zip({ "closeout.json": "{}\n" });
    const metadata = artifact(archive, { digest: `sha256:${"0".repeat(64)}` });
    await expect(downloadGithubArtifactBundle({
      artifact: metadata,
      repository,
      expectedName: name,
      expectedRunId: runId,
      expectedEntries: ["closeout.json"],
      token,
      fetchImpl: fetchArchive(archive) as typeof fetch,
    })).rejects.toThrow("artifact_digest_mismatch");
  });

  it("rejects extra entries, nested paths, duplicate expectations, and symlinks", async () => {
    const extra = zip({ "closeout.json": "{}\n", "extra.json": "{}\n" });
    await expect(downloadGithubArtifactBundle({
      artifact: artifact(extra),
      repository,
      expectedName: name,
      expectedRunId: runId,
      expectedEntries: ["closeout.json"],
      token,
      fetchImpl: fetchArchive(extra) as typeof fetch,
    })).rejects.toThrow("artifact_entries_invalid");

    const linked = zip(
      { "closeout.json": "{}\n" },
      { symlink: "provider-evidence.json" },
    );
    await expect(downloadGithubArtifactBundle({
      artifact: artifact(linked),
      repository,
      expectedName: name,
      expectedRunId: runId,
      expectedEntries: ["closeout.json", "provider-evidence.json"],
      token,
      fetchImpl: fetchArchive(linked) as typeof fetch,
    })).rejects.toThrow("artifact_archive_invalid");
  });

  it("rejects substituted metadata URLs, run identities, and expired rows", () => {
    const archive = zip({ "closeout.json": "{}\n" });
    for (const overrides of [
      { expired: true },
      { workflow_run: { id: 999 } },
      { archive_download_url: "https://example.com/artifact.zip" },
    ]) {
      expect(githubArtifactMetadataExact(artifact(archive, overrides), {
        repository,
        expectedName: name,
        expectedRunId: runId,
      })).toBe(false);
    }
  });
});
