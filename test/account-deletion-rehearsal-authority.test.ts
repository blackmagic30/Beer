import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runAccountDeletionRehearsalAuthorityVerification } from
  "../scripts/verify-github-account-deletion-rehearsal-authority.mjs";

const repository = "blackmagic30/Beer";
const candidate = "a".repeat(40);
const activationRunId = "123";
const recoveryRunId = "456";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("account-deletion cleanup authority", () => {
  it("binds the immutable first activation attempt after a GitHub rerun", async () => {
    const directory = fs.mkdtempSync(path.join(
      os.tmpdir(),
      "pintpath-account-deletion-authority-",
    ));
    temporaryDirectories.push(directory);
    const terminal = path.join(directory, "cleanup-arm.json");
    fs.writeFileSync(terminal, `${JSON.stringify({
      schemaVersion: "pintpath-account-deletion-rehearsal-cleanup-arm/v1",
      candidateSha: candidate,
      activationRunId,
      projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
      environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
      serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
      cleanupRequired: true,
      disarmCondition:
        "SAFE_ONE_PREACTIVATION_OR_SAFE_ONE_FINAL_OR_QUARANTINED_ZERO",
      secretMaterialIncluded: false,
    }, null, 2)}\n`, { mode: 0o600 });

    const requested: string[] = [];
    const output: string[] = [];
    const code = await runAccountDeletionRehearsalAuthorityVerification([
      "--mode", "cleanup",
      "--candidate-sha", candidate,
      "--activation-run-id", activationRunId,
      "--activation-terminal-file", terminal,
      "--evidence-dir", directory,
    ], {
      env: {
        GITHUB_REPOSITORY: repository,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: recoveryRunId,
        GITHUB_TOKEN: "test-token-with-sufficient-length", // security-scan allow: synthetic GitHub authority fixture
        GITHUB_WORKFLOW_REF:
          `${repository}/.github/workflows/`
          + "reconcile-permanent-staging-account-deletion-rehearsal.yml@refs/heads/main",
      },
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        return new Response(JSON.stringify({
          id: Number(activationRunId),
          repository: { full_name: repository },
          head_sha: candidate,
          event: "workflow_dispatch",
          run_attempt: 1,
          path: ".github/workflows/permanent-staging-account-deletion-rehearsal.yml@main",
          status: "completed",
        }), { status: 200 });
      },
      writeDurable: (_target: string, _leaf: string, source: string) =>
        crypto.createHash("sha256").update(source).digest("hex"),
      writeOutput: (source: string) => output.push(source),
    });

    expect(code).toBe(0);
    expect(requested).toEqual([
      `https://api.github.com/repos/${repository}/actions/runs/`
        + `${activationRunId}/attempts/1`,
    ]);
    expect(JSON.parse(output.join(""))).toMatchObject({
      outcome: "authorized",
      mode: "cleanup",
      candidateSha: candidate,
    });
  });
});
