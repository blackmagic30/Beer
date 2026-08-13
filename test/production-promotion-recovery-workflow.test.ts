import fs from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = fs.readFileSync(
  ".github/workflows/attest-production-promotion-recovery.yml",
  "utf8",
);
const pitrWorkflow = fs.readFileSync(
  ".github/workflows/observe-production-post-promotion-pitr.yml",
  "utf8",
);
const policy = JSON.parse(fs.readFileSync(
  "ops/railway/production-promotion-recovery-policy.json",
  "utf8",
)) as Record<string, unknown>;
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};

describe("protected production promotion-recovery workflow", () => {
  it("uses the exact protected check, environment, shared rollout lock, and artifact", () => {
    expect(workflow).toContain("name: Attest Pint Path protected production promotion recovery");
    expect(workflow).toContain("name: Attest protected production promotion and recovery");
    expect(workflow).toContain("environment: production-promotion-recovery");
    expect(workflow).toContain("group: pintpath-production-rollout");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("name: pintpath-production-promotion-recovery-${{ inputs.candidate_sha }}");
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
    expect(workflow).toContain("PINTPATH_PROMOTION_RECOVERY_REVIEWER_ONE_PUBLIC_KEY_BASE64");
    expect(workflow).toContain("PINTPATH_PROMOTION_RECOVERY_REVIEWER_TWO_PUBLIC_KEY_BASE64");
    expect(workflow).not.toMatch(/railway\s+(up|deploy|redeploy|variables|scale)/i);
    expect(workflow).not.toContain("supabase db");
  });

  it("keeps the attestor, PITR observer, verifier, and contract executable", () => {
    expect(packageJson.scripts["production:promotion-recovery:attest"]).toBe(
      "tsx scripts/attest-production-promotion-recovery.ts",
    );
    expect(packageJson.scripts["production:promotion-recovery:pitr:observe"]).toBe(
      "tsx scripts/observe-production-post-promotion-pitr.ts",
    );
    expect(packageJson.scripts["production:promotion-recovery:receipt:verify"]).toBe(
      "tsx scripts/verify-production-promotion-recovery-receipt.ts",
    );
    expect(packageJson.scripts["production:promotion-recovery:contract:check"]).toContain(
      "test/production-promotion-recovery.test.ts",
    );
    expect(pitrWorkflow).toContain("name: Observe exact production post-promotion PITR");
    expect(pitrWorkflow).toContain("environment: production-promotion-recovery");
    expect(pitrWorkflow).toContain("group: pintpath-production-rollout");
    expect(pitrWorkflow).toContain("PINTPATH_RAILWAY_PITR_METADATA_TOKEN");
    expect(pitrWorkflow).toContain("production:promotion-recovery:pitr:observe");
    expect(pitrWorkflow).not.toContain("PINTPATH_RAILWAY_PITR_ENABLE_TOKEN");
  });
});
