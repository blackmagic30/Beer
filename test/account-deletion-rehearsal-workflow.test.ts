import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (filename: string) => fs.readFileSync(path.join(root, filename), "utf8");

describe("account-deletion rehearsal workflows", () => {
  const main = read(".github/workflows/permanent-staging-account-deletion-rehearsal.yml");
  const reconcile = read(
    ".github/workflows/reconcile-permanent-staging-account-deletion-rehearsal.yml");
  const runbook = read("docs/permanent-staging-account-deletion-rehearsal.md");

  it("arms cleanup before any mutation and uses the dedicated no-soak scale path", () => {
    const armUpload = main.indexOf("Retain the authority and cleanup arm before any mutation");
    const scaleEnvironment = main.indexOf("environment: permanent-staging-scale-evidence");
    expect(armUpload).toBeGreaterThan(-1);
    expect(scaleEnvironment).toBeGreaterThan(armUpload);
    expect(main).not.toContain("scale_evidence_run_id");
    expect(main).not.toContain("staging:load:soak");
    expect(main).toContain("--operation prepare-two");
    expect(main).toContain("--operation converge-one");
    expect(main).toContain("--prerequisite-file \"$RUNNER_TEMP/safe/terminal.json\"");
    expect(main).toContain(
      "pintpath-account-deletion-rehearsal-attempt-converge-one-${{ inputs.candidate_sha }}-${{ github.run_id }}",
    );
    expect(main).toContain(
      "pintpath-account-deletion-rehearsal-attempt-apply-safe-${{ inputs.candidate_sha }}-${{ github.run_id }}",
    );
    expect(main).not.toMatch(/run:\s*\|[\s\S]*railway service scale/);
  });

  it("orders activation, active proof, unconditional cleanup, safe proof, and converge", () => {
    const scale = main.indexOf("  scale-safe-to-two:");
    const activate = main.indexOf("  store-activation:");
    const active = main.indexOf("  apply-active-config:");
    const cleanup = main.indexOf("  store-cleanup:");
    const safe = main.indexOf("  apply-safe-config:");
    const converge = main.indexOf("  converge-safe-to-one:");
    expect(scale).toBeLessThan(activate);
    expect(activate).toBeLessThan(active);
    expect(active).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(safe);
    expect(safe).toBeLessThan(converge);
    expect(main).toContain("if: always() && needs.verify-prerequisites.result == 'success'");
    expect(main).toContain("SAFE_ONE_FINAL");
    expect(main).not.toContain("  emergency-zero:");
    expect(main).toContain("account-deletion:rehearsal:state:classify");
    expect(main).toContain("inventory-github-account-deletion-rehearsal-attempts.mjs");
    expect(main).toContain("finalize-account-deletion-rehearsal-closeout.mjs");
    expect(main).toContain(".attemptArmCount == 6");
  });

  it("reclassifies before containment and closes only from live terminal proof", () => {
    expect(reconcile).toContain("  converge-safe-to-one:");
    expect(reconcile).toContain("--operation converge-one");
    expect(reconcile).toContain("  classify-before-containment:");
    expect(reconcile).toContain("QUARANTINED_ZERO_PENDING_CLEANUP");
    expect(reconcile).toContain("ACTIVATION_STORED_SAFE_TWO");
    expect(reconcile).toContain("CLEANUP_STORED_ACTIVE_TWO");
    expect((reconcile.match(/CLEANUP_STAGED_ACTIVE_TWO/g) ?? [])).toHaveLength(2);
    expect(reconcile).toContain("SAFE_ONE_FINAL");
    expect(reconcile).not.toContain("SAFE_TWO_REDEPLOYED");
    expect(reconcile).toContain("railway:staging:account-deletion:quarantine:protected");
    expect(reconcile).toContain("decision=manual");
    expect(reconcile).toContain("decision=quarantine_retry_1");
    expect(reconcile).toContain("decision=quarantine_retry_2");
    expect(reconcile).toContain("quarantine-zero-retry-1");
    expect(reconcile).toContain("quarantine-zero-retry-2");
    expect(reconcile).toContain("Re-inventory the global ladder immediately before arming containment");
    expect((reconcile.match(/if quarantine_ladder_unstarted &&/g) ?? []).length)
      .toBeGreaterThanOrEqual(4);
    expect(reconcile).toMatch(
      /SAFE_ONE_FINAL\)[\s\S]{0,180}else\n\s+select_quarantine_slot/,
    );
    expect(reconcile).toMatch(
      /CLEANUP_STORED_SAFE_TWO\)[\s\S]{0,180}if quarantine_ladder_unstarted &&/,
    );
    expect(reconcile).toMatch(
      /ACTIVATION_STORED_SAFE_TWO\|ACTIVE_TWO\)[\s\S]{0,180}if quarantine_ladder_unstarted &&/,
    );
    expect((reconcile.match(/\.attempts\["quarantine-zero"\] == null/g) ?? [])
      .length).toBeGreaterThanOrEqual(5);
    expect((reconcile.match(/\.attempts\["quarantine-zero-retry-1"\] == null/g)
      ?? []).length).toBeGreaterThanOrEqual(6);
    expect((reconcile.match(/\.attempts\["quarantine-zero-retry-2"\] == null/g)
      ?? []).length).toBeGreaterThanOrEqual(9);
    expect(reconcile).toContain(".attempts[\"apply-safe\"] == null");
    expect(reconcile).toContain(".attempts[\"cleanup-contained-zero\"] == null");
    expect(reconcile).toContain("finalize-account-deletion-rehearsal-closeout.mjs");
    expect(reconcile).toContain("--mode reconcile");
    expect(reconcile).toContain("--attempt-inventory-file");
    expect(reconcile).toContain("Require final state to match all containment history");
    expect(reconcile).toContain('.attempts["cleanup-contained-zero"]');
    expect(reconcile).toContain('$state == "QUARANTINED_ZERO"');
    expect(reconcile).not.toContain("ref: ${{ needs.bind-and-classify.outputs.candidate_sha }}");
    expect(reconcile).not.toContain("ref: \"${{ needs.bind-and-classify.outputs.candidate_sha }}\"");
  });

  it("neutralizes expected one-shot mutation failures but never retries an arm", () => {
    expect((reconcile.match(/continue-on-error: true/g) ?? []).length)
      .toBeGreaterThanOrEqual(5);
    for (const operation of [
      "apply-safe",
      "converge-one",
    ]) {
      expect(reconcile).toContain(
        `pintpath-account-deletion-rehearsal-attempt-${operation}-`,
      );
    }
    expect(reconcile).toContain(
      "pintpath-account-deletion-rehearsal-attempt-${{ steps.operation.outputs.name }}-",
    );
    expect(reconcile).toContain("quarantine) operation=quarantine-zero");
    expect(reconcile).toContain(
      "quarantine_retry_1) operation=quarantine-zero-retry-1",
    );
    expect(reconcile).toContain(
      "quarantine_retry_2) operation=quarantine-zero-retry-2",
    );
    expect(reconcile).toContain("cleanup_contained_zero) operation=cleanup-contained-zero");
    expect(reconcile).toContain("Re-inventory immediately before arming cleanup");
    expect(reconcile).toContain("Re-inventory immediately before arming safe redeploy");
    expect(reconcile).toContain("Re-inventory immediately before arming converge");
    expect(reconcile).not.toContain("retry-max-attempts");
    expect(reconcile).not.toContain("retryAllowed: true");
    const converge = reconcile.slice(
      reconcile.indexOf("  converge-safe-to-one:"),
      reconcile.indexOf("  classify-before-containment:"),
    );
    expect(converge).not.toContain("PINTPATH_RAILWAY_STAGING_DEPLOY_TOKEN");
  });

  it("pins all external actions and a shared non-cancelling concurrency group", () => {
    for (const workflow of [main, reconcile]) {
      expect(workflow).toContain("group: pintpath-permanent-staging-key-rollout");
      expect(workflow).toContain("cancel-in-progress: false");
      expect(workflow).not.toMatch(/uses:\s+[^\s@]+@(main|master|v\d+)\s*$/m);
    }
  });

  it("documents the bounded staging-only manual fail-closed procedure", () => {
    expect(runbook).toContain("STAGING-ONLY, MANUAL DISPATCH, FAIL CLOSED");
    expect(runbook).toContain("48d8c6cd-1c66-4148-874b-20877f48e1a5");
    expect(runbook).toContain("a4e0f507-d6d3-4df9-a818-ad92c0071a35");
    expect(runbook).toContain("6816c4a2-e392-4ee5-826f-2584cb599ec0");
    expect(runbook).toContain("asia-southeast1-eqsg3a");
    expect(runbook).toContain("quarantine-zero-retry-2");
    expect(runbook).toContain("MANUAL_FAIL_CLOSED");
    expect(runbook).toMatch(
      /permanent-staging Beer\s+service in that region to 0 replicas/,
    );
    expect(runbook).toContain("Do not change production");
    expect(runbook).toContain("2026-11-29T00:00:00Z");
  });
});
