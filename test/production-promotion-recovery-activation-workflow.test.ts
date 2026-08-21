import fs from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = fs.readFileSync(
  ".github/workflows/activate-production-promotion-recovery.yml",
  "utf8",
);
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const activationCreator = fs.readFileSync(
  "scripts/create-production-promotion-recovery-activation-receipt.mjs",
  "utf8",
);
const activationVerifier = fs.readFileSync(
  "scripts/verify-production-promotion-recovery-activation.mjs",
  "utf8",
);

function job(name: string): string {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker, workflow.indexOf("jobs:\n"));
  expect(start).toBeGreaterThanOrEqual(0);
  const next = /^  [a-z][a-z0-9-]*:\n/gm;
  next.lastIndex = start + marker.length;
  const end = next.exec(workflow)?.index ?? workflow.length;
  return workflow.slice(start, end);
}

function step(source: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n      - name:", start + marker.length);
  return source.slice(start, end < 0 ? source.length : end);
}

describe("protected production promotion-recovery activation workflow", () => {
  it("is an exact-current-main four-job protected topology with two network-scoped JIT runners", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/\n\s{2}(?:pull_request|push|schedule):/);
    expect(workflow).toContain("group: pintpath-production-rollout");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow.match(/^  [a-z][a-z0-9-]*:\n/gm)).toEqual([
      "  production-capture:\n",
      "  disposable-recover:\n",
      "  cleanup:\n",
      "  finalize:\n",
    ]);

    const capture = job("production-capture");
    const recover = job("disposable-recover");
    const cleanup = job("cleanup");
    const finalize = job("finalize");
    expect(capture).toContain(
      "runs-on: [self-hosted, linux, x64, pintpath-production-backup]",
    );
    expect(recover).toContain(
      "runs-on: [self-hosted, linux, x64, pintpath-disposable-recovery]",
    );
    expect(recover).toContain("needs: production-capture");
    expect(cleanup).toContain(
      "needs: [production-capture, disposable-recover]",
    );
    expect(cleanup).toContain("if: ${{ always() }}");
    expect(cleanup).toContain(
      "environment: production-promotion-recovery-cleanup",
    );
    expect(finalize).toContain(
      "needs: [production-capture, disposable-recover, cleanup]",
    );
    expect(finalize).toContain("if: ${{ always() }}");
    expect(capture).toContain(
      "environment: production-promotion-recovery-activation",
    );
    expect(recover).toContain(
      "environment: production-promotion-recovery-activation",
    );
    for (const source of [capture, recover, cleanup, finalize]) {
      expect(source).toContain("persist-credentials: false");
      expect(source).toContain("ref: ${{ inputs.candidate_sha }}");
    }
    expect(workflow).toContain("test \"${{ github.run_attempt }}\" = '1'");
  });

  it("keeps raw recovery bytes on separate verified tmpfs runners and never in GitHub artifacts", () => {
    const capture = job("production-capture");
    const recover = job("disposable-recover");
    expect(
      capture.match(
        /verify-production-backup-volatile-work-root\.mjs prepare/g,
      ),
    ).toHaveLength(1);
    expect(
      recover.match(
        /verify-production-backup-volatile-work-root\.mjs prepare/g,
      ),
    ).toHaveLength(1);
    expect(capture).toContain("--operation=backup");
    expect(recover).toContain("--operation=recovery");
    expect(capture).not.toContain(
      "PINTPATH_RECOVERY_TARGET_RESTORE_DATABASE_URL",
    );
    expect(capture).not.toContain("PINTPATH_RECOVERY_TARGET_REDIS_URL");
    expect(recover).not.toContain("PINTPATH_PRODUCTION_BACKUP_DATABASE_URL");
    expect(recover).not.toContain(
      "PINTPATH_PRODUCTION_STORAGE_SERVICE_ROLE_KEY",
    );
    expect(recover).not.toContain(
      "PINTPATH_OPERATIONAL_COPY_RECOVERY_SERVICE_ROLE_KEY",
    );

    const captureUpload = step(
      capture,
      "Upload receipt-only capture authority",
    );
    const precleanupUpload = step(recover, "Upload precleanup receipt set");
    for (const upload of [captureUpload, precleanupUpload]) {
      expect(upload).not.toMatch(
        /pintpath-postgres\.dump|captured-recovery-set|retrieved-recovery-set|deletion-authority/,
      );
      expect(upload).toContain("if-no-files-found: error");
    }
    expect(captureUpload).toContain("logical-worm-result.json");
    expect(captureUpload).toContain("private-storage-worm-receipt.json");
    expect(recover).toContain("db:postgres:backup:logical:worm:retrieve");
    expect(recover).toContain("db:postgres:recovery-bundle:worm:retrieve");
    expect(
      recover.indexOf("db:postgres:backup:logical:worm:retrieve"),
    ).toBeLessThan(recover.indexOf("db:postgres:restore:logical -- restore"));
    expect(
      recover.indexOf("db:postgres:recovery-bundle:worm:retrieve"),
    ).toBeLessThan(
      recover.indexOf("db:postgres:restore:private-storage-recovery"),
    );
    expect(workflow).not.toContain("rm -rf");
  });

  it("uses independent reader-only WORM retrieval, distinct DB roles, double replay, real app smoke, and Storage purge", () => {
    for (const alias of [
      "db:postgres:backup:logical:worm:retrieve",
      "db:postgres:recovery-bundle:worm:retrieve",
      "db:postgres:restore:logical",
      "db:postgres:restore:private-storage-recovery",
      "db:postgres:deletion:replay",
      "production:promotion-recovery:recovered-smoke",
      "db:postgres:restore:private-storage-purge",
    ]) {
      expect(packageJson.scripts[alias]).toBeTypeOf("string");
      expect(packageJson.scripts[alias]).toContain("--frozen-intrinsics");
      expect(workflow).toContain(`npm run --silent ${alias} --`);
    }
    expect(
      packageJson.scripts["db:postgres:backup:logical:worm:retrieve"],
    ).toBe(
      "node --frozen-intrinsics --disable-proto=throw --import tsx scripts/retrieve-postgres-logical-worm.ts",
    );
    const recover = job("disposable-recover");
    const replay = step(
      recover,
      "Replay deletion tombstones twice and prove idempotency",
    );
    expect(replay).toContain("for pass in first second; do");
    expect(replay).toContain("deletion-replay-$pass-receipt.json");
    for (const role of [
      "restore-database-url",
      "restore-migrator-database-url",
      "restore-maintenance-database-url",
      "restore-runtime-database-url",
    ])
      expect(recover).toContain(role);
    expect(recover).toContain(
      "restore_files=(restore-database-url restore-migrator-database-url restore-maintenance-database-url restore-runtime-database-url)",
    );
    expect(recover).toContain(
      "PINTPATH_POSTGRES_OCI_RESTORE_ROOT_CA_FILE=%s\\n",
    );

    const smoke = step(
      recover,
      "Verify the real recovered app and Redis boundary",
    );
    expect(smoke).toContain("--app-port 43117");
    expect(smoke).toContain("hashCompiledApplicationArtifact");
    expect(smoke).toContain("hashRuntimeDependencyArtifact");
    expect(smoke).toContain("--expected-runtime-dependency-artifact-sha256");
    expect(
      smoke.match(/--expected-runtime-dependency-artifact-sha256/g),
    ).toHaveLength(1);
    expect(smoke.match(/runtime_dependency_artifact_sha=/g)).toHaveLength(1);
    expect(smoke).toContain(
      '--runtime-stage-root "$PINTPATH_RECOVERY_WORK_ROOT"',
    );
    expect(smoke.match(/--runtime-stage-root/g)).toHaveLength(1);
    expect(smoke).toContain("--redis-url-file");
    expect(smoke).toContain("--redis-sentinel-file");
    expect(smoke).toContain("--supabase-publishable-key-file");
    expect(smoke).toContain("--source-evidence-signing-secret-file");
    expect(recover).toContain("PINTPATH_RECOVERY_TARGET_REDIS_URL");
    expect(recover).toContain("PINTPATH_RECOVERY_TARGET_REDIS_SENTINEL");
    expect(recover).toContain("PINTPATH_RECOVERY_SUPABASE_TEST_USER_PASSWORD");
    expect(recover).toContain("randomBytes(48)");
    expect(
      recover.indexOf("Verify the real recovered app and Redis boundary"),
    ).toBeLessThan(
      recover.indexOf("Purge only the restored private Storage object set"),
    );
  });

  it("runs independent per-run Railway and Supabase absence reconciliation even when recovery fails", () => {
    const recover = job("disposable-recover");
    const cleanup = job("cleanup");
    expect(recover).not.toContain("RECOVERY_RAILWAY_TEARDOWN_AUTHORITY");
    expect(recover).not.toContain("RECOVERY_SUPABASE_TEARDOWN_AUTHORITY");
    const railway = step(cleanup, "Reconcile exact Railway project absence");
    const supabase = step(cleanup, "Reconcile exact Supabase project absence");
    expect(railway).toContain("if: ${{ always() }}");
    expect(supabase).toContain("if: ${{ always() }}");
    expect(railway).toContain("railway:promotion-recovery:teardown:protected");
    expect(supabase).toContain("supabase:restore:teardown:protected");
    expect(cleanup).toContain("PINTPATH_RECOVERY_RAILWAY_READ_TOKEN");
    expect(cleanup).toContain("PINTPATH_RECOVERY_RAILWAY_DELETE_TOKEN");
    expect(cleanup).toContain("PINTPATH_RECOVERY_SUPABASE_READ_TOKEN");
    expect(cleanup).toContain("PINTPATH_RECOVERY_SUPABASE_DELETE_TOKEN");
    expect(cleanup).toContain(
      "PINTPATH_RECOVERY_RAILWAY_TEARDOWN_AUTHORITY_BASE64",
    );
    expect(cleanup).toContain(
      "PINTPATH_RECOVERY_SUPABASE_TEARDOWN_AUTHORITY_BASE64",
    );
    expect(cleanup).toContain("$GITHUB_RUN_ID");
    expect(supabase).toContain("cleanup_mode=emergency");
    expect(supabase).toContain("cleanup_mode=orderly");
    expect(supabase).toContain("storage-purge-receipt.json");
    expect(
      step(cleanup, "Upload both independent cleanup terminals"),
    ).toContain("if: ${{ always() }}");
  });

  it("finalizes only a green orderly path into the exact 18-leaf and 20-file evidence contract", () => {
    const recover = job("disposable-recover");
    const finalize = job("finalize");
    expect(recover).toContain(
      "test \"$(find \"$evidence\" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')\" = '16'",
    );
    const prerequisite = step(
      finalize,
      "Require successful capture, recovery, and both cleanup terminals",
    );
    expect(prerequisite).toContain("needs.production-capture.result");
    expect(prerequisite).toContain("needs.disposable-recover.result");
    expect(prerequisite).toContain("needs.cleanup.result");
    const creator = step(
      finalize,
      "Create and verify the exact activation receipt",
    );
    expect(creator).toContain(
      "--frozen-intrinsics --disable-proto=throw --import tsx",
    );
    expect(creator).toContain("activation-receipt.json");
    expect(creator).toContain("tested-commit-sha.txt");
    expect(creator).toContain(
      "PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_FILES.length",
    );
    expect(activationCreator).toContain(
      '"logical-worm-retrieval-receipt.json"',
    );
    const leaves =
      /PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_EVIDENCE = Object\.freeze\(\[([\s\S]*?)\]\);/
        .exec(activationCreator)?.[1]
        ?.match(/"[^"]+"/g) ?? [];
    expect(leaves).toHaveLength(18);
    expect(activationVerifier).toContain('"activation-receipt.json"');
    expect(activationVerifier).toContain('"tested-commit-sha.txt"');
    const finalUpload = step(
      finalize,
      "Upload exact production promotion-recovery activation",
    );
    expect(finalUpload).toContain(
      "name: pintpath-production-promotion-recovery-activation-${{ inputs.candidate_sha }}",
    );
    expect(finalUpload).toContain("${{ env.PINTPATH_FINAL_ROOT }}/activation");
    expect(finalUpload).toContain("if-no-files-found: error");
  });

  it("uses only the production runner for PITR and operational-copy proof", () => {
    const capture = job("production-capture");
    const recover = job("disposable-recover");
    expect(capture).toContain("production:promotion-recovery:pitr:observe");
    expect(capture).toContain("production-deployment-receipt.json");
    expect(capture).toContain("production-scale-receipt.json");
    expect(capture).toContain("closed-route-receipt.json");
    expect(capture).toContain("logical-backup-manifest.json");
    expect(capture).toContain("db:postgres:backup:logical:retrieve");
    expect(recover).not.toContain("db:postgres:backup:logical:retrieve");
    expect(recover).not.toContain("PINTPATH_OPERATIONAL_COPY_SERVICE_ROLE_KEY");
    expect(recover).not.toContain(
      "PINTPATH_OPERATIONAL_COPY_RECOVERY_SERVICE_ROLE_KEY",
    );
  });
});
