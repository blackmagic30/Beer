import fs from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = fs.readFileSync(
  ".github/workflows/attest-production-promotion-recovery.yml",
  "utf8",
);
const policy = JSON.parse(
  fs.readFileSync(
    "ops/railway/production-promotion-recovery-policy.json",
    "utf8",
  ),
) as Record<string, unknown>;
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};

function stepContaining(source: string, needle: string): string {
  const position = source.indexOf(needle);
  expect(position).toBeGreaterThanOrEqual(0);
  const start = source.lastIndexOf("\n      - name:", position);
  const end = source.indexOf("\n      - name:", position + needle.length);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, end < 0 ? source.length : end);
}

describe("protected production promotion-recovery workflow", () => {
  it("uses the exact protected check, environment, shared rollout lock, and artifact", () => {
    expect(workflow).toContain(
      "name: Attest Pint Path protected production promotion recovery",
    );
    expect(workflow).toContain(
      "name: Attest protected production promotion and recovery",
    );
    expect(workflow).toContain("environment: production-promotion-recovery");
    expect(workflow).toContain("group: pintpath-production-rollout");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain(
      "name: pintpath-production-promotion-recovery-${{ inputs.candidate_sha }}",
    );
    expect(policy).toMatchObject({
      activationState: "GITHUB_ENVIRONMENT_PROTECTED",
      githubEnvironment: "production-promotion-recovery",
      requiredCheck: "Attest protected production promotion and recovery",
    });
  });

  it("materializes the trusted deploy-scale-close chain and does not mutate providers", () => {
    expect(workflow).toContain("--phase promotion-recovery");
    expect(workflow).toContain("--stage deploy");
    expect(workflow).toContain("--stage scale");
    expect(workflow).toContain("--stage close");
    expect(workflow).toContain("--production-scale-receipt");
    expect(workflow).toContain(
      "PINTPATH_PROMOTION_RECOVERY_REVIEWER_ONE_PUBLIC_KEY_BASE64",
    );
    expect(workflow).toContain(
      "PINTPATH_PROMOTION_RECOVERY_REVIEWER_TWO_PUBLIC_KEY_BASE64",
    );
    expect(workflow).not.toMatch(
      /railway\s+(up|deploy|redeploy|variables|scale)/i,
    );
    expect(workflow).not.toContain("supabase db");
  });

  it("consumes recovery evidence only from the exact named activation run", () => {
    expect(workflow).toContain("activation_run_id:");
    expect(workflow).toContain(
      "ACTIVATION_RUN_ID: ${{ inputs.activation_run_id }}",
    );
    expect(workflow).toContain(
      '[[ "$ACTIVATION_RUN_ID" =~ ^[1-9][0-9]{0,19}$ ]]',
    );
    const activationDownloadStep = stepContaining(
      workflow,
      "run-id: ${{ inputs.activation_run_id }}",
    );
    expect(activationDownloadStep).toContain(
      "name: pintpath-production-promotion-recovery-activation-${{ inputs.candidate_sha }}",
    );
    const activationDownload = workflow.indexOf(
      "name: pintpath-production-promotion-recovery-activation-${{ inputs.candidate_sha }}",
    );
    const activationVerification = workflow.indexOf(
      "scripts/verify-production-promotion-recovery-activation.mjs",
    );
    const attestation = workflow.indexOf(
      "npm run --silent production:promotion-recovery:attest --",
    );
    expect(activationDownload).toBeGreaterThanOrEqual(0);
    expect(activationVerification).toBeGreaterThan(activationDownload);
    expect(attestation).toBeGreaterThan(activationVerification);

    const reviewedInventory = stepContaining(workflow, "approval-one.json");
    expect(reviewedInventory).toContain("approval-two.json");
    for (const filename of [
      "logical-restore-receipt.json",
      "private-storage-capture-receipt.json",
      "private-storage-recovery-manifest.json",
      "private-storage-restore-receipt.json",
      "deletion-replay-first-receipt.json",
      "deletion-replay-second-receipt.json",
    ])
      expect(reviewedInventory).not.toContain(filename);

    const attestationStep = stepContaining(
      workflow,
      "npm run --silent production:promotion-recovery:attest --",
    );
    for (const argument of [
      "--logical-worm-retrieval-receipt",
      "--logical-restore-receipt",
      "--private-storage-capture-receipt",
      "--private-storage-recovery-manifest",
      "--private-storage-restore-receipt",
      "--deletion-replay-first-receipt",
      "--deletion-replay-second-receipt",
    ]) {
      expect(attestationStep).toContain(argument);
      expect(attestationStep).toMatch(
        new RegExp(`${argument} \\\"\\$activation_input/`),
      );
    }
    expect(workflow).toContain(
      "$activation_authority/activation-github-authority.json",
    );
  });

  it("keeps the attestor, in-activation PITR observer, verifier, and contract executable", () => {
    expect(packageJson.scripts["production:promotion-recovery:attest"]).toBe(
      "tsx scripts/attest-production-promotion-recovery.ts",
    );
    expect(
      packageJson.scripts["production:promotion-recovery:pitr:observe"],
    ).toBe("tsx scripts/observe-production-post-promotion-pitr.ts");
    expect(
      packageJson.scripts["production:promotion-recovery:receipt:verify"],
    ).toBe("tsx scripts/verify-production-promotion-recovery-receipt.ts");
    expect(
      packageJson.scripts["production:promotion-recovery:contract:check"],
    ).toContain("test/production-promotion-recovery.test.ts");
    expect(fs.existsSync(
      ".github/workflows/observe-production-post-promotion-pitr.yml",
    )).toBe(false);
    const activation = fs.readFileSync(
      ".github/workflows/activate-production-promotion-recovery.yml",
      "utf8",
    );
    expect(activation).toContain("PINTPATH_RAILWAY_PITR_METADATA_TOKEN");
    expect(activation).toContain("production:promotion-recovery:pitr:observe");
    expect(activation).toContain("production-deployment-receipt.json");
    expect(activation).toContain("logical-backup-manifest.json");
    expect(activation).not.toContain("PINTPATH_RAILWAY_PITR_ENABLE_TOKEN");
  });
});
