import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const executableExtensions = new Set([
  ".cjs",
  ".cts",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".mts",
  ".php",
  ".plist",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xcconfig",
  ".yaml",
  ".yml",
]);
const ignoredPathSegments = new Set([
  ".gradle",
  ".swiftpm",
  "build",
  "DerivedData",
  "node_modules",
]);
const quotedApiKeyHeaderPattern = /["']apikey["']/i;
const bareApiKeyHeaderPattern = /\bapikey\s*:/i;
const caseInsensitiveBareApiKeySurfacePattern = /\bapikey\s*:/i;
const supabaseEndpointPattern =
  /supabase\.co|\/(?:auth|storage|rest|functions|realtime|graphql)\/v1/i;
const supabaseSdkImportPattern =
  /from\s+["']@supabase\/supabase-js["']|require\s*\(\s*["']@supabase\/supabase-js["']\s*\)|import\s*\(\s*["']@supabase\/supabase-js["']\s*\)/;
const supabaseBrowserGlobalPattern =
  /\b(?:window|globalThis)(?:\??\.supabase|\?\.\[\s*["']supabase["']\s*\]|\[\s*["']supabase["']\s*\])/;
const bracketedSupabaseCreateClientPattern =
  /\bsupabase\s*(?:\?\.)?\[\s*["']createClient["']\s*\]/;
const transitiveSupabaseCredentialBoundaryPattern =
  /\b(?:createSupabasePostgresLogicalOffsiteStorage|createSupabasePostgresLogicalOffsiteRetrievalStorage|createSupabasePrivateStorageRecoveryBoundary|probeOffsiteBackupReadiness|probePostgresLogicalOffsiteReadiness|scheduleOffsiteBackups|appendAccountDeletionTombstone|exportPostgresMigrationLedgerAuthority)\b|\bnew\s+(?:AdminService|AdminServiceConstructor|BusinessService)\s*\(/;

const trackedExecutableSources = execFileSync(
  "git",
  [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ],
  { cwd: root },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((filename) => executableExtensions.has(path.extname(filename)))
  .filter((filename) => !filename.split("/").some((segment) => ignoredPathSegments.has(segment)))
  .filter((filename) => !filename.startsWith("test/"))
  .filter((filename) => !filename.includes("/src/test/") && !filename.includes("/src/androidTest/"))
  .sort();

function relativePathsMatching(pattern: RegExp): string[] {
  return trackedExecutableSources
    .filter((filename) => pattern.test(read(filename)))
    .sort();
}

function hasManualApiKeyHeader(source: string): boolean {
  return quotedApiKeyHeaderPattern.test(source) || bareApiKeyHeaderPattern.test(source);
}

function bareApiKeySurfaceCounts(): string[] {
  const counts: string[] = [];
  for (const filename of trackedExecutableSources) {
    const count = read(filename).match(/\bapikey\s*:/gi)?.length ?? 0;
    if (count > 0) counts.push(`${filename}:bare-apikey-header-surface:${count}`);
  }
  return counts.sort();
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("Supabase key consumer compatibility inventory", () => {
  it("keeps every direct SDK client creation on the two reviewed factories", () => {
    expect(supabaseSdkImportPattern.test('import("@supabase/supabase-js")')).toBe(true);
    const mixedTypeAndRuntimeImport = [
      'import type { SupabaseClient } from "@supabase/supabase-js";',
      'const { createClient: makeClient } = await import("@supabase/supabase-js");',
      'makeClient("https://example.invalid", "key");',
    ].join("\n");
    expect(mixedTypeAndRuntimeImport.replace(
      /^import type \{ SupabaseClient \} from "@supabase\/supabase-js";\s*$/gm,
      "",
    )).toMatch(supabaseSdkImportPattern);
    for (const expression of [
      'window["supabase"]["createClient"]("url", "key")',
      "globalThis?.['supabase']?.['createClient']('url', 'key')",
    ]) expect(supabaseBrowserGlobalPattern.test(expression)).toBe(true);
    expect(bracketedSupabaseCreateClientPattern.test(
      'supabase["createClient"]("url", "key")',
    )).toBe(true);
    expect(relativePathsMatching(/\bcreateClient\s*\(/)).toEqual([
      "src/lib/supabase-client.ts",
      "viewer/business.js",
    ]);

    expect(relativePathsMatching(supabaseBrowserGlobalPattern)).toEqual([
      "viewer/business.js",
    ]);
    expect(relativePathsMatching(bracketedSupabaseCreateClientPattern)).toEqual([]);

    expect(relativePathsMatching(supabaseSdkImportPattern)).toEqual([
      "scripts/cleanup-duplicate-venues.ts",
      "src/lib/offsite-backup-download.ts",
      "src/lib/offsite-backup.ts",
      "src/lib/postgres-logical-offsite-retrieval.ts",
      "src/lib/postgres-logical-offsite.ts",
      "src/lib/postgres-private-storage-recovery.ts",
      "src/lib/stage-restored-source-evidence.ts",
      "src/lib/supabase-client.ts",
      "src/modules/admin/admin.service.ts",
      "src/modules/business/business.service.ts",
    ]);
    expect(read("src/lib/supabase-client.ts")).toContain(
      'import { createClient, type SupabaseClient } from "@supabase/supabase-js";',
    );
    for (const filename of relativePathsMatching(supabaseSdkImportPattern)
      .filter((filename) => filename !== "src/lib/supabase-client.ts")) {
      const source = read(filename);
      expect(source).toMatch(
        /^import type \{ SupabaseClient \} from "@supabase\/supabase-js";/m,
      );
      const withoutReviewedTypeImport = source.replace(
        /^import type \{ SupabaseClient \} from "@supabase\/supabase-js";\s*$/gm,
        "",
      );
      expect(withoutReviewedTypeImport, filename).not.toMatch(supabaseSdkImportPattern);
    }
    expect(relativePathsMatching(/@supabase\/ssr/)).toEqual([]);

    expect(relativePathsMatching(/supabase-client(?:\.js)?["']/)).toEqual([
      "scripts/cleanup-duplicate-venues.ts",
      "scripts/discover-menu-sources.ts",
      "scripts/import-melbourne-venues.ts",
      "scripts/provider-readiness-check.ts",
      "src/lib/offsite-backup-download.ts",
      "src/lib/offsite-backup.ts",
      "src/lib/postgres-logical-offsite-retrieval.ts",
      "src/lib/postgres-logical-offsite.ts",
      "src/lib/postgres-private-storage-recovery.ts",
      "src/modules/admin/admin.service.ts",
      "src/modules/business/business.service.ts",
    ]);
  });

  it("fails closed when a new manual apikey transport appears outside the reviewed set", () => {
    for (const spelling of ['"apikey"', '"ApiKey"', "apikey:", "ApiKey:", "APIKEY:"]) {
      expect(hasManualApiKeyHeader(spelling)).toBe(true);
    }
    expect(trackedExecutableSources
      .filter((filename) => hasManualApiKeyHeader(read(filename)))
      .sort()).toEqual([
      ".github/workflows/venue-directory-refresh.yml",
      "apps/android/app/src/main/java/au/pintpath/beermap/data/BeerMapApiClient.kt",
      "apps/ios/BeerMap/Services/BeerMapAPI.swift",
      "scripts/deliver-monthly-reports.ts",
      "scripts/discover-menu-sources.ts",
      "scripts/execute-protected-permanent-staging-supabase-cutover.ts",
      "scripts/import-melbourne-venues.ts",
      "scripts/production-smoke-check.mjs",
      "scripts/staging-supabase-key-canary.ts",
      "src/app.ts",
      "src/lib/account-deletion-notification.ts",
      "src/lib/monthly-report-delivery.ts",
      "src/lib/postgres-logical-offsite.ts",
      "src/lib/supabase-client.ts",
      "src/modules/admin/admin.service.ts",
      "src/modules/business/business.service.ts",
      "supabase/config.toml",
      "viewer/business.js",
    ]);

    expect(bareApiKeySurfaceCounts()).toEqual([
      ".github/workflows/venue-directory-refresh.yml:bare-apikey-header-surface:2",
      "scripts/deliver-monthly-reports.ts:bare-apikey-header-surface:1",
      "scripts/discover-menu-sources.ts:bare-apikey-header-surface:1",
      "scripts/execute-protected-permanent-staging-supabase-cutover.ts:bare-apikey-header-surface:4",
      "scripts/import-melbourne-venues.ts:bare-apikey-header-surface:3",
      "scripts/production-smoke-check.mjs:bare-apikey-header-surface:2",
      "scripts/staging-supabase-key-canary.ts:bare-apikey-header-surface:5",
      "src/app.ts:bare-apikey-header-surface:2",
      "src/lib/account-deletion-notification.ts:bare-apikey-header-surface:1",
      "src/lib/monthly-report-delivery.ts:bare-apikey-header-surface:1",
      "src/lib/postgres-logical-offsite.ts:bare-apikey-header-surface:2",
      "src/lib/supabase-client.ts:bare-apikey-header-surface:1",
      "src/modules/admin/admin.service.ts:bare-apikey-header-surface:1",
      "src/modules/business/business.service.ts:bare-apikey-header-surface:2",
    ]);

    expect(caseInsensitiveBareApiKeySurfacePattern.test("APIKEY:")).toBe(true);
    expect(relativePathsMatching(caseInsensitiveBareApiKeySurfacePattern)).toEqual([
      ".github/workflows/venue-directory-refresh.yml",
      "scripts/deliver-monthly-reports.ts",
      "scripts/discover-menu-sources.ts",
      "scripts/execute-protected-permanent-staging-supabase-cutover.ts",
      "scripts/import-melbourne-venues.ts",
      "scripts/production-smoke-check.mjs",
      "scripts/staging-supabase-key-canary.ts",
      "src/app.ts",
      "src/lib/account-deletion-notification.ts",
      "src/lib/monthly-report-delivery.ts",
      "src/lib/postgres-logical-offsite.ts",
      "src/lib/supabase-client.ts",
      "src/modules/admin/admin.service.ts",
      "src/modules/business/business.service.ts",
    ]);

    expect(read(".github/workflows/venue-directory-refresh.yml").match(/redirect: "error"/g))
      .toHaveLength(2);
    expect(read("apps/android/app/src/main/java/au/pintpath/beermap/data/BeerMapApiClient.kt"))
      .toContain("instanceFollowRedirects = false");
    expect(read("apps/ios/BeerMap/Services/BeerMapAPI.swift"))
      .toContain("completionHandler(nil)");
    for (const filename of [
      "scripts/execute-protected-permanent-staging-supabase-cutover.ts",
      "scripts/production-smoke-check.mjs",
      "scripts/staging-supabase-key-canary.ts",
      "src/lib/postgres-logical-offsite.ts",
      "src/modules/business/business.service.ts",
      "viewer/business.js",
    ]) {
      expect(read(filename), filename).toContain('redirect: "error"');
    }
  });

  it("classifies every executable Supabase endpoint and target surface", () => {
    for (const endpoint of [
      "/auth/v1",
      "/storage/v1",
      "/rest/v1",
      "/functions/v1",
      "/realtime/v1",
      "/graphql/v1",
    ]) expect(supabaseEndpointPattern.test(endpoint)).toBe(true);
    expect(relativePathsMatching(supabaseEndpointPattern)).toEqual([
      ".github/workflows/production-logical-backup.yml",
      ".github/workflows/venue-directory-refresh.yml",
      "apps/android/app/src/main/java/au/pintpath/beermap/data/BeerMapApiClient.kt",
      "apps/android/app/src/main/java/au/pintpath/beermap/ui/features/BeerMapApp.kt",
      "apps/ios/BeerMap/Services/BeerMapAPI.swift",
      "scripts/attest-postgres-logical-backup-offsite.ts",
      "scripts/backup-data-offsite.ts",
      "scripts/check-production-deploy-guard.mjs",
      "scripts/download-offsite-backup.ts",
      "scripts/execute-protected-permanent-staging-supabase-cutover.ts",
      "scripts/import-melbourne-venues.ts",
      "scripts/lib/permanent-staging-cost-policy.ts",
      "scripts/postgres-migration.ts",
      "scripts/production-smoke-check.mjs",
      "scripts/promote-reviewed-price-data.ts",
      "scripts/prove-postgres-account-deletion-recovery.ts",
      "scripts/provider-readiness-check.ts",
      "scripts/rehearse-data-restore.ts",
      "scripts/retrieve-postgres-logical-offsite.ts",
      "scripts/staging-supabase-key-canary.ts",
      "src/app.ts",
      "src/config/env.ts",
      "src/lib/offsite-backup-download.ts",
      "src/lib/postgres-logical-offsite-retrieval.ts",
      "src/lib/postgres-logical-offsite.ts",
      "src/lib/supabase-key-format.ts",
      "supabase/config.toml",
      "viewer/config.example.js",
    ]);
  });

  it("pins transitive credential-bearing operator entrypoints before library transport", () => {
    expect(relativePathsMatching(transitiveSupabaseCredentialBoundaryPattern)).toEqual([
      "scripts/attest-postgres-logical-backup-offsite.ts",
      "scripts/benchmark-menu-ocr.ts",
      "scripts/capture-postgres-private-storage-recovery.ts",
      "scripts/deliver-monthly-reports.ts",
      "scripts/generate-monthly-reports.ts",
      "scripts/postgres-migration.ts",
      "scripts/promote-reviewed-price-data.ts",
      "scripts/prove-postgres-account-deletion-recovery.ts",
      "scripts/publish-source-ingestion-map-base.ts",
      "scripts/retrieve-postgres-logical-offsite.ts",
      "scripts/seed-pintpath-fake-data.ts",
      "src/app.ts",
      "src/db/postgres-migration-ledger.ts",
      "src/lib/offsite-backup.ts",
      "src/lib/postgres-logical-offsite-retrieval.ts",
      "src/lib/postgres-logical-offsite.ts",
      "src/lib/postgres-private-storage-recovery.ts",
    ]);
    expect(relativePathsMatching(
      /\b(?:runOffsiteBackup|runBackup|scheduleOffsiteBackups|downloadOffsiteBackup|fetchVerifiedAccountDeletionLedger|stageRestoredSourceEvidence|exportPostgresMigrationLedgerAuthority|probePostgresLogicalOffsiteReadiness)\s*[()]/,
    )).toEqual([
      "scripts/backup-data-offsite.ts",
      "scripts/download-offsite-backup.ts",
      "scripts/postgres-migration.ts",
      "scripts/prove-postgres-account-deletion-recovery.ts",
      "scripts/rehearse-data-restore.ts",
      "src/app.ts",
      "src/db/postgres-migration-ledger.ts",
      "src/lib/offsite-backup-download.ts",
      "src/lib/offsite-backup.ts",
      "src/lib/postgres-logical-offsite.ts",
      "src/lib/stage-restored-source-evidence.ts",
    ]);

    for (const filename of [
      "scripts/attest-postgres-logical-backup-offsite.ts",
      "scripts/backup-data-offsite.ts",
      "scripts/capture-postgres-private-storage-recovery.ts",
      "scripts/cleanup-duplicate-venues.ts",
      "scripts/discover-menu-sources.ts",
      "scripts/download-offsite-backup.ts",
      "scripts/import-melbourne-venues.ts",
      "scripts/postgres-migration.ts",
      "scripts/promote-reviewed-price-data.ts",
      "scripts/prove-postgres-account-deletion-recovery.ts",
      "scripts/publish-source-ingestion-map-base.ts",
      "scripts/rehearse-data-restore.ts",
      "scripts/restore-postgres-private-storage-recovery.ts",
      "scripts/retrieve-postgres-logical-offsite.ts",
      "scripts/validate-production-supabase-transport.ts",
    ]) {
      const source = read(filename);
      expect(source, filename).toContain("supabase-key-format.js");
      expect(source, filename).toMatch(
        /assertSupabase(?:Server|Public)ApiKey\(|assertExactSupabaseOrigin\(/,
      );
    }
    expect(read("scripts/prove-postgres-account-deletion-recovery.ts"))
      .toContain("assertPostgresLogicalOffsiteDestinationPins");

    for (const [filename, transportNeedle] of [
      ["scripts/attest-postgres-logical-backup-offsite.ts", "dependencies.createStorage({"],
      ["scripts/backup-data-offsite.ts", "await dependencies.runBackup({"],
      ["scripts/capture-postgres-private-storage-recovery.ts", "dependencies.createStorage({"],
      ["scripts/cleanup-duplicate-venues.ts", "const client = createServerSupabaseClient("],
      ["scripts/discover-menu-sources.ts", "const supabase = createServerSupabaseClient("],
      ["scripts/download-offsite-backup.ts", "await downloadOffsiteBackup({"],
      ["scripts/import-melbourne-venues.ts", "const supabase = createServerSupabaseClient("],
      ["scripts/postgres-migration.ts", "dependencies.exportLedger ?? exportPostgresMigrationLedgerAuthority"],
      ["scripts/promote-reviewed-price-data.ts", "new AdminServiceConstructor("],
      ["scripts/prove-postgres-account-deletion-recovery.ts", "dependencies.appendAndFetchVerifiedLedger("],
      ["scripts/publish-source-ingestion-map-base.ts", "new AdminService("],
      ["scripts/rehearse-data-restore.ts", "await fetchVerifiedAccountDeletionLedger({"],
      ["scripts/restore-postgres-private-storage-recovery.ts", "dependencies.createStorage({"],
      ["scripts/retrieve-postgres-logical-offsite.ts", "dependencies.createStorage({"],
    ] as const) {
      const source = read(filename);
      const validationIndex = Math.max(
        source.lastIndexOf("assertSupabaseServerApiKey("),
        source.lastIndexOf("assertSupabasePublicApiKey("),
      );
      expect(validationIndex, filename).toBeGreaterThan(-1);
      expect(validationIndex, filename).toBeLessThan(source.indexOf(transportNeedle));
      if (
        filename !== "scripts/capture-postgres-private-storage-recovery.ts"
        && filename !== "scripts/import-melbourne-venues.ts"
        && filename !== "scripts/promote-reviewed-price-data.ts"
        && filename !== "scripts/restore-postgres-private-storage-recovery.ts"
      ) {
        const originValidationIndex = source.lastIndexOf("assertExactSupabaseOrigin(");
        expect(originValidationIndex, filename).toBeGreaterThan(-1);
        expect(originValidationIndex, filename).toBeLessThan(source.indexOf(transportNeedle));
      }
    }
    const captureSource = read("scripts/capture-postgres-private-storage-recovery.ts");
    const captureMain = captureSource.slice(
      captureSource.indexOf("export async function runPostgresPrivateStorageCaptureCli("),
    );
    const captureOriginIndex = captureMain.indexOf(
      "resolvePostgresPrivateStorageCaptureOrigin(",
    );
    expect(captureOriginIndex).toBeGreaterThan(-1);
    expect(captureMain).toContain("sourceSupabaseUrl !== expectedOrigin");
    expect(captureOriginIndex).toBeLessThan(
      captureMain.indexOf("secret(dependencies,"),
    );
    expect(captureOriginIndex).toBeLessThan(
      captureMain.indexOf("dependencies.createStorage({"),
    );
    const restoreSource = read("scripts/restore-postgres-private-storage-recovery.ts");
    const restoreMain = restoreSource.slice(
      restoreSource.indexOf("export async function runPostgresPrivateStorageRestoreCli("),
    );
    expect(restoreMain.indexOf("dependencies.assertDestinationOriginApproved("))
      .toBeLessThan(restoreMain.indexOf("secret(dependencies, targetConnectionUrlFile)"));
    expect(restoreMain.indexOf("dependencies.assertDestinationOriginApproved("))
      .toBeLessThan(restoreMain.indexOf("secret(dependencies, serviceRoleKeyFile)"));
    expect(restoreSource).not.toContain("bcdefghijklmnopqrstu");
    expect(restoreSource).toContain(
      "pintpath-private-storage-disposable-authority/v1",
    );
    const stageSource = read("scripts/stage-restored-source-evidence.ts");
    expect(stageSource).not.toContain("stageRestoredSourceEvidence");
    expect(stageSource).not.toContain("bbfibbadwjxzrcdncavy");
    expect(stageSource).toContain(
      "Restore-staging evidence transport is unavailable until a reviewed disposable-project authority is registered.",
    );
    const publisherSource = read("scripts/publish-source-ingestion-map-base.ts");
    const publisherMain = publisherSource.slice(
      publisherSource.indexOf("async function main()"),
    );
    expect(publisherMain).toMatch(
      /const supabaseAuthority = assertPublishMapBaseSupabaseBoundary\(\s*process\.env,\s*!options\.dryRun,\s*\)/,
    );
    expect(publisherMain).toMatch(
      /const adminService = options\.dryRun\s*\? null\s*: new AdminService\(/,
    );
    expect(publisherMain.indexOf("assertPublishMapBaseSupabaseBoundary("))
      .toBeLessThan(publisherMain.indexOf("new AdminService("));
    const importerMain = read("scripts/import-melbourne-venues.ts").slice(
      read("scripts/import-melbourne-venues.ts").indexOf("async function main()"),
    );
    expect(importerMain.indexOf("assertSupabaseProjectTarget("))
      .toBeLessThan(importerMain.indexOf("fetchExistingVenues()"));
    const cleanupSource = read("scripts/cleanup-duplicate-venues.ts");
    const cleanupEnvironmentBoundary = cleanupSource.slice(
      cleanupSource.indexOf("function requiredEnvironment("),
      cleanupSource.indexOf("function normalizeName("),
    );
    expect(cleanupEnvironmentBoundary).toContain("assertExactSupabaseOrigin(");
    expect(cleanupEnvironmentBoundary).toContain("assertSupabaseServerApiKey(");
    const cleanupMain = cleanupSource.slice(
      cleanupSource.indexOf("async function main()"),
    );
    const cleanupUrlIndex = cleanupMain.indexOf(
      'requiredEnvironment("SUPABASE_URL")',
    );
    const cleanupKeyIndex = cleanupMain.indexOf(
      'requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY")',
    );
    const cleanupClientIndex = cleanupMain.indexOf(
      "createServerSupabaseClient(supabaseUrl, supabaseServiceRoleKey)",
    );
    expect(cleanupUrlIndex).toBeGreaterThan(-1);
    expect(cleanupKeyIndex).toBeGreaterThan(cleanupUrlIndex);
    expect(cleanupClientIndex).toBeGreaterThan(cleanupKeyIndex);
    const discoverySource = read("scripts/discover-menu-sources.ts");
    const discoverySupabaseBoundary = discoverySource.slice(
      discoverySource.indexOf("async function loadSupabaseVenues("),
      discoverySource.indexOf("function tableExists("),
    );
    const discoveryOriginIndex = discoverySupabaseBoundary.indexOf(
      "assertExactSupabaseOrigin(",
    );
    const discoveryServerKeyIndex = discoverySupabaseBoundary.indexOf(
      "assertSupabaseServerApiKey(",
    );
    const discoveryPublicKeyIndex = discoverySupabaseBoundary.indexOf(
      "assertSupabasePublicApiKey(",
    );
    const discoveryClientIndex = discoverySupabaseBoundary.indexOf(
      "createServerSupabaseClient(supabaseUrl, supabaseKey)",
    );
    expect(discoveryOriginIndex).toBeGreaterThan(-1);
    expect(discoveryServerKeyIndex).toBeGreaterThan(discoveryOriginIndex);
    expect(discoveryPublicKeyIndex).toBeGreaterThan(discoveryOriginIndex);
    expect(discoveryClientIndex).toBeGreaterThan(discoveryServerKeyIndex);
    expect(discoveryClientIndex).toBeGreaterThan(discoveryPublicKeyIndex);
    const discoveryMain = discoverySource.slice(
      discoverySource.indexOf("async function main()"),
    );
    expect(discoveryMain).toContain(
      "...(await loadSupabaseVenues(limit, environmentTarget))",
    );
    const promoterSource = read("scripts/promote-reviewed-price-data.ts");
    const promoterApply = promoterSource.slice(
      promoterSource.indexOf("async function runApply("),
      promoterSource.indexOf("async function runQuarantine("),
    );
    const promoterTargetIndex = promoterApply.indexOf(
      "assertExactSupabaseProjectTarget(",
    );
    const promoterKeyIndex = promoterApply.indexOf(
      "const serviceRoleKey = requiredEnvironment(",
    );
    const promoterConstructorIndex = promoterApply.indexOf(
      "new AdminServiceConstructor(",
    );
    expect(promoterTargetIndex).toBeGreaterThan(-1);
    expect(promoterKeyIndex).toBeGreaterThan(promoterTargetIndex);
    expect(promoterConstructorIndex).toBeGreaterThan(promoterKeyIndex);

    for (const filename of [
      "scripts/attest-postgres-logical-backup-offsite.ts",
      "scripts/backup-data-offsite.ts",
      "scripts/cleanup-duplicate-venues.ts",
      "scripts/discover-menu-sources.ts",
      "scripts/postgres-migration.ts",
      "scripts/promote-reviewed-price-data.ts",
      "scripts/prove-postgres-account-deletion-recovery.ts",
      "scripts/publish-source-ingestion-map-base.ts",
      "scripts/rehearse-data-restore.ts",
      "scripts/validate-production-supabase-transport.ts",
    ]) {
      expect(read(filename), filename).toContain("https://auth.pintpath.au");
    }
    for (const filename of [
      "scripts/attest-postgres-logical-backup-offsite.ts",
      "scripts/backup-data-offsite.ts",
      "scripts/download-offsite-backup.ts",
      "scripts/postgres-migration.ts",
      "scripts/prove-postgres-account-deletion-recovery.ts",
      "scripts/rehearse-data-restore.ts",
      "scripts/retrieve-postgres-logical-offsite.ts",
    ]) {
      expect(read(filename), filename).toContain(
        "https://hfbmhdxrwtihukmixxta.supabase.co",
      );
    }
    const keyFormatSource = read("src/lib/supabase-key-format.ts");
    expect(keyFormatSource).toContain(
      'PRODUCTION_SUPABASE_STORAGE_ORIGIN = "https://jxpubqlmqnnqwadmjgyk.supabase.co"',
    );
    expect(keyFormatSource).toContain(
      'PERMANENT_STAGING_SUPABASE_ORIGIN = "https://bbfibbadwjxzrcdncavy.supabase.co"',
    );
    for (const filename of [
      "scripts/cleanup-duplicate-venues.ts",
      "scripts/discover-menu-sources.ts",
      "scripts/import-melbourne-venues.ts",
    ]) {
      const source = read(filename);
      expect(source, filename).toContain('from "../src/lib/redact.js"');
      expect(source, filename).toContain("redactKnownSecretValues(");
    }
    const backupCliSource = read("scripts/backup-data-offsite.ts");
    expect(backupCliSource).toContain('failureCode: "backup_failed"');
    expect(backupCliSource).not.toContain("throw error");
    const restoreRehearsalSource = read("scripts/rehearse-data-restore.ts");
    expect(restoreRehearsalSource).toContain("redactKnownSecretValues(");
    expect(restoreRehearsalSource).toContain(
      'throw new Error("Restore rehearsal failed.")',
    );
  });

  it("pins the installed and browser dependency surfaces to Supabase JS 2.112.3", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
    };
    const packageLock = JSON.parse(read("package-lock.json")) as {
      packages?: Record<string, { dependencies?: Record<string, string>; version?: string }>;
    };
    expect(packageJson.dependencies?.["@supabase/supabase-js"]).toBe("2.112.3");
    expect(packageLock.packages?.[""]?.dependencies?.["@supabase/supabase-js"])
      .toBe("2.112.3");
    expect(packageLock.packages?.["node_modules/@supabase/supabase-js"]?.version)
      .toBe("2.112.3");

    const browserSdkUrl =
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.3/dist/umd/supabase.min.js";
    const browserSdkIntegrity =
      "sha384-l8ah+VgaWtk1mvOe9VC+OirC6qHFF4yH7l7mKRidV9MSti3E9F463bMp6ZVN4kuC";
    const browserPages = relativePathsMatching(/@supabase\/supabase-js@2\.112\.3\/dist\/umd\/supabase\.min\.js/)
      .filter((filename) => filename.startsWith("viewer/") && filename.endsWith(".html"));
    expect(browserPages).toEqual([
      "viewer/account.html",
      "viewer/auth/callback.html",
      "viewer/resend-confirmation.html",
      "viewer/reset-password.html",
      "viewer/stats.html",
    ]);
    for (const filename of browserPages) {
      const source = read(filename);
      expect(source).toContain(`src="${browserSdkUrl}"`);
      expect(source).toContain(`integrity="${browserSdkIntegrity}"`);
      expect(source).toContain('crossorigin="anonymous"');
      expect(source).toContain('referrerpolicy="no-referrer"');
    }

    const appSource = read("src/app.ts");
    expect(appSource.match(new RegExp(browserSdkUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")))
      .toHaveLength(2);
  });
});
