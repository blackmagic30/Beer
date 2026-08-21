import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(".");

function normalized(filename: string): string {
  return fs.readFileSync(path.join(projectRoot, filename), "utf8")
    .replaceAll(/\s+/g, " ");
}

function expectInOrder(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    expect(index, `missing or misordered marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("permanent-staging Supabase cutover ordering", () => {
  it.each([
    [
      "docs/postgres-migration-execution-status.md",
      [
        "acknowledged_pending_runtime_proof",
        "After the atomic Supabase replacement, deploy",
        "Only after those deployment and consumer proofs pass",
      ],
    ],
    [
      "docs/permanent-staging-supabase-key-containment.md",
      [
        "perform at most one all-or-nothing",
        "After that exact atomic replacement completes, deploy",
        "Only then approve the protected legacy-cutover workflow",
      ],
    ],
    [
      "docs/protected-provider-mutation-operations.md",
      [
        "one atomic skipDeploys=true mutation",
        "Then run staging worker activate, which independently authenticates the full prepare→quiesce→ fenced-upload→restore chain",
        "Run the active deployment phase once at one replica and require both its activation terminal and sibling full-chain prerequisite verification",
        "Only then run Permanent staging Supabase legacy-key cutover",
      ],
    ],
    [
      "docs/full-scale-postgres-migration-runbook.md",
      [
        "Supabase publishable/secret-key replacement under its own approval",
        "After every planned provider/runtime operation, deploy the exact same candidate once more",
        "Only then run protected canary-B/legacy-disable/old-key-denial",
      ],
    ],
    [
      "docs/launch-9-readiness-gates.md",
      [
        "atomic Railway upsert",
        "After every planned provider/runtime operation, deploy the exact same current-main build once more",
        "Only then run the protected replacement-canary/ legacy-disable/old-key-denial workflow",
      ],
    ],
    [
      "PROD_FOLLOWUPS.md",
      [
        "Atomically replace the Supabase publishable/secret pair",
        "then deploy the exact same current-main build",
        "before running the protected legacy disable and old-key-denial workflow",
      ],
    ],
  ])("keeps replacement, deployment proof, and cutover ordered in %s", (
    filename,
    markers,
  ) => {
    const source = normalized(filename as string).replaceAll("`", "");
    expectInOrder(source, markers as string[]);
  });

  it("requires both authenticated predecessor artifacts before secret custody", () => {
    const workflow = normalized(
      ".github/workflows/permanent-staging-supabase-legacy-cutover.yml",
    );
    expectInOrder(workflow, [
      "replacement_run_id:",
      "deployment_run_id:",
      "scripts/verify-github-permanent-staging-deployment.mjs",
      "PINTPATH_SUPABASE_STAGING_SECRETS_READ_TOKEN",
      "execute-protected-permanent-staging-supabase-cutover.ts",
    ]);
  });

  it("serializes replacement, deployment, and cutover without cancellation", () => {
    for (const filename of [
      ".github/workflows/permanent-staging-provider-mutation.yml",
      ".github/workflows/deploy-permanent-staging.yml",
      ".github/workflows/permanent-staging-supabase-legacy-cutover.yml",
    ]) {
      const workflow = normalized(filename);
      expect(workflow).toContain(
        "concurrency: group: pintpath-permanent-staging-key-rollout queue: max cancel-in-progress: false",
      );
    }

    const runtimeVariableWorkflow = normalized(
      ".github/workflows/configure-runtime-variable.yml",
    );
    expect(runtimeVariableWorkflow).toContain(
      "inputs.target == 'permanent-staging' && 'pintpath-permanent-staging-key-rollout'",
    );
    expect(runtimeVariableWorkflow).toContain(
      "queue: max cancel-in-progress: false",
    );
    expect(runtimeVariableWorkflow).toContain(
      "reject-permanent-staging-supabase-key-bypass:",
    );
    expect(runtimeVariableWorkflow).toContain(
      "inputs.variable_name != 'SUPABASE_ANON_KEY' && inputs.variable_name != 'SUPABASE_SERVICE_ROLE_KEY'",
    );
  });
});
