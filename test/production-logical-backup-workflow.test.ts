import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const workflowPath = path.resolve(
  ".github/workflows/production-logical-backup.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");

function jobSource(name: string, nextName: string): string {
  const start = workflow.indexOf(`  ${name}:\n`);
  const end = workflow.indexOf(`  ${nextName}:\n`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe("production logical-backup workflow", () => {
  it("schedules a non-cancelling daily backup and monthly restore mode", () => {
    expect(workflow).toContain('- cron: "15 14 * * *"');
    expect(workflow).toContain('- cron: "45 15 1 * *"');
    expect(workflow).toContain("- backup-only");
    expect(workflow).toContain("- backup-and-restore-drill");
    expect(workflow).toContain("group: production-logical-backup");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("permissions:\n  contents: read");
  });

  it("keeps all data-bearing work on the protected private-network runner", () => {
    const backup = jobSource("logical-backup", "restore-drill");
    const restore = jobSource("restore-drill", "alert");
    for (const source of [backup, restore]) {
      expect(source).toContain(
        "runs-on: [self-hosted, linux, x64, pintpath-production-backup]",
      );
      expect(source).not.toContain("ubuntu-latest");
      expect(source).not.toContain("ubuntu-24.04");
    }
    expect(backup).toContain("environment: production-backup");
    expect(restore).toContain("environment: production-restore-drill");
    expect(workflow).not.toContain("persist-credentials: true");
  });

  it("fails closed until every runner, secret, tool, provider, and hash pin exists", () => {
    for (const required of [
      'test "$PINTPATH_PRODUCTION_BACKUP_RUNNER_READY" = "true"',
      '[[ "$PINTPATH_PRODUCTION_BACKUP_EPHEMERAL_RUNNER_POLICY_SHA256" =~ ^[a-f0-9]{64}$ ]]',
      "scripts/verify-production-backup-volatile-work-root.mjs verify",
      'test "$(node --version)" = "v22.23.2"',
      'test "$(corepack npm --version)" = "10.9.8"',
      'test -n "$BACKUP_DATABASE_URL"',
      'test -n "$RUNTIME_DATABASE_URL"',
      'test -n "$RUNTIME_ROOT_CA_PEM"',
      'test -n "$POSTGRES_ROOT_CA_PEM"',
      'test -n "$OFFSITE_SERVICE_ROLE_KEY"',
      'test -n "$POSTGRES_LOGICAL_WORM_RECOVERY_ACCOUNT_ID"',
      'test -n "$POSTGRES_LOGICAL_WORM_FORBIDDEN_ACCOUNT_IDS"',
      '[[ "$value" =~ ^[a-f0-9]{64}$ ]]',
      "PINTPATH_POSTGRES_OCI_RUNTIME_PROFILE: pintpath-postgres-17.10-operational-oci-linux-amd64-v1",
      "PINTPATH_POSTGRES_OCI_EGRESS_POLICY_SHA256:",
      "PINTPATH_POSTGRES_LOGICAL_RESTORE_ROOT_CA_DER_SHA256:",
      'test -x /usr/local/libexec/pintpath/docker-static-29.7.2',
      "PG_DUMP_FILE: /usr/local/bin/pg_dump",
      "PG_RESTORE_FILE: /usr/local/bin/pg_restore",
    ]) expect(workflow).toContain(required);
    expect(workflow).toContain("corepack npm ci --ignore-scripts");
    expect(workflow).toContain("--transport-profile=railway-stock-localhost-ca-v1");
  });

  it("executes PostgreSQL only through the frozen digest-pinned OCI worker", () => {
    expect(workflow.match(/node --frozen-intrinsics --disable-proto=throw --import tsx/g))
      .toHaveLength(3);
    expect(workflow).toContain("scripts/backup-postgres-logical.ts");
    expect(workflow.match(/scripts\/restore-postgres-logical\.ts/g)).toHaveLength(2);
    expect(workflow).toContain(
      "EXPECTED_PG_DUMP_SHA256: fb3b6f653eae3eb4709c83117355dd9e033dd96332167c4042981ce37aefa6df",
    );
    expect(workflow).toContain(
      "EXPECTED_PG_RESTORE_SHA256: 6d408461d62238fb4bc0e92831d56bf40bcbd16f2e524addd19efe4909bda7b5",
    );
    expect(workflow).not.toContain("PINTPATH_PRODUCTION_PG_DUMP_FILE");
    expect(workflow).not.toContain("PINTPATH_PRODUCTION_PG_RESTORE_FILE");
    expect(workflow).not.toContain("db:postgres:backup:logical --");
    expect(workflow).not.toContain("db:postgres:restore:logical --");
  });

  it("uses separate least-privilege secret scopes", () => {
    const backup = jobSource("logical-backup", "restore-drill");
    const restore = jobSource("restore-drill", "alert");
    const backupJobEnv = backup.slice(0, backup.indexOf("    steps:"));
    const restoreJobEnv = restore.slice(0, restore.indexOf("    steps:"));
    expect(backupJobEnv).not.toContain("secrets.");
    expect(restoreJobEnv).not.toContain("secrets.");
    expect(backup).toContain(
      "secrets.PINTPATH_PRODUCTION_BACKUP_DATABASE_URL",
    );
    expect(backup).toContain(
      "secrets.PINTPATH_OPERATIONAL_COPY_SERVICE_ROLE_KEY",
    );
    expect(backup).toContain(
      "secrets.PINTPATH_PRODUCTION_WORM_RECOVERY_ACCOUNT_ID",
    );
    expect(restore).toContain(
      "secrets.PINTPATH_DISPOSABLE_RESTORE_DATABASE_URL",
    );
    expect(restore).not.toContain(
      "secrets.PINTPATH_PRODUCTION_BACKUP_DATABASE_URL",
    );
    expect(restore).toContain(
      "secrets.PINTPATH_PRODUCTION_POSTGRES_ROOT_CA_PEM",
    );
    expect(restore).not.toContain(
      "secrets.PINTPATH_PRODUCTION_WORM_RECOVERY_ACCOUNT_ID",
    );
  });

  it("creates, uploads, verifies, and retains the exact logical and WORM set", () => {
    expect(workflow).toContain("scripts/backup-postgres-logical.ts");
    for (const command of [
      "db:postgres:backup:logical:offsite",
      "db:postgres:backup:logical:worm",
    ]) expect(workflow).toContain(`corepack npm run --silent ${command} --`);
    expect(workflow).toContain(
      "--runtime-root-ca-file=\"$PINTPATH_BACKUP_WORK_ROOT/railway-postgres-root-ca.pem\"",
    );
    expect(workflow).toContain(
      "--expected-runtime-root-ca-der-sha256=\"$EXPECTED_ROOT_CA_DER_SHA256\"",
    );
    expect(workflow).toContain("offsite.successStateSha256");
    expect(workflow).toContain(
      "offsite.manifestSha256 !== backup.manifestSha256",
    );
    expect(workflow).toContain(
      "worm.manifestSha256 !== backup.manifestSha256",
    );
    expect(workflow).toContain("now - completedAt > 7_200_000");
    expect(workflow).toContain("retainUntil - now < 29 * 86_400_000");
    expect(workflow).toContain("retention-days: 30");
    expect(workflow.match(/if-no-files-found: error/g)).toHaveLength(2);
  });

  it("retrieves the just-attested copy into a monthly pinned empty target", () => {
    const restore = jobSource("restore-drill", "alert");
    expect(restore).toContain("needs.logical-backup.outputs.success_state_sha256");
    expect(restore).toContain("db:postgres:backup:logical:retrieve");
    expect(restore).toContain(
      "--runtime-root-ca-file=\"$PINTPATH_RESTORE_WORK_ROOT/production-runtime-root-ca.pem\"",
    );
    expect(restore).toContain(
      "--expected-runtime-root-ca-der-sha256=\"$EXPECTED_RUNTIME_ROOT_CA_DER_SHA256\"",
    );
    expect(restore).toContain(
      "PINTPATH_POSTGRES_OCI_RESTORE_ROOT_CA_FILE=%s\\n",
    );
    expect(restore).toContain("$work_root/restore-root-ca.pem");
    expect(restore).not.toContain(
      "--runtime-root-ca-file=\"$PINTPATH_RESTORE_WORK_ROOT/restore-root-ca.pem\"",
    );
    expect(restore).toContain("scripts/restore-postgres-logical.ts inspect-target");
    expect(restore).toContain("scripts/restore-postgres-logical.ts restore");
    expect(restore).toContain(
      'test "$RESTORE_TARGET_NETWORK_POLICY" = "isolated-no-production-route"',
    );
    expect(restore).toContain(
      'test "$RESTORE_TARGET_GENERATION" = "$(date -u +%Y-%m)"',
    );
    expect(restore).toContain(
      'test "$target_url_sha256" = "$EXPECTED_RESTORE_TARGET_URL_SHA256"',
    );
    expect(restore).toContain(
      'test "$target_url_sha256" != "$runtime_url_sha256"',
    );
    expect(restore).toContain("target.disposableTarget!==true");
    expect(restore).toContain("target.privateSchemasAbsent!==true");
    expect(restore).toContain(
      "target.targetIdentitySha256===retrieval.sourceDatabaseIdentitySha256",
    );
    expect(restore).toContain('v.sourceStateBindingStatus!=="exact-match"');
    expect(restore).toContain("retention-days: 90");
  });

  it("pages with metadata only and never embeds production credentials", () => {
    const alert = workflow.slice(workflow.indexOf("  alert:\n"));
    expect(alert).toContain("environment: production-backup-alerts");
    expect(alert).toContain(
      "secrets.PINTPATH_PRODUCTION_BACKUP_ALERT_WEBHOOK_URL",
    );
    expect(alert).toContain("pintpath-production-logical-backup-failed");
    expect(alert).not.toContain("PINTPATH_PRODUCTION_BACKUP_DATABASE_URL");
    expect(alert).not.toContain("PINTPATH_OPERATIONAL_COPY_SERVICE_ROLE_KEY");
    expect(alert).not.toContain("PINTPATH_DISPOSABLE_RESTORE_DATABASE_URL");
    expect(workflow).not.toMatch(/postgres(?:ql)?:\/\/[^$<{\s]+/i);
    expect(workflow).not.toMatch(/(?:sb_secret_|eyJ[A-Za-z0-9_-]{20})/);
  });

  it("uses immutable action pins and deterministic volatile private cleanup", () => {
    expect(workflow.match(/actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/g))
      .toHaveLength(2);
    expect(workflow.match(/actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/g))
      .toHaveLength(2);
    expect(workflow.match(/actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g))
      .toHaveLength(2);
    expect(workflow).not.toContain("rm -rf");
    expect(workflow).not.toContain("$RUNNER_TEMP/pintpath-production");
    expect(workflow.match(/verify-production-backup-volatile-work-root\.mjs prepare/g))
      .toHaveLength(2);
    expect(workflow.match(/verify-production-backup-volatile-work-root\.mjs cleanup/g))
      .toHaveLength(2);
    expect(workflow).toContain('--operation=backup');
    expect(workflow).toContain('--operation=restore');
    expect(workflow).toContain('--run-id="$GITHUB_RUN_ID"');
    expect(workflow).toContain('--run-attempt="$GITHUB_RUN_ATTEMPT"');
    expect(workflow).toContain('--exported-work-root="${PINTPATH_BACKUP_WORK_ROOT:-}"');
    expect(workflow).toContain('--exported-work-root="${PINTPATH_RESTORE_WORK_ROOT:-}"');
  });
});
