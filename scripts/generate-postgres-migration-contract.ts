import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";

import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  POSTGRES_MIGRATION_CONTRACT_KIND,
  POSTGRES_MIGRATION_CONTRACT_VERSION,
  POSTGRES_MIGRATION_SOURCE_SCHEMA_VERSION,
  inspectPostgresMigrationSchema,
  type PostgresMigrationContract,
  type PostgresMigrationConversion,
  type PostgresMigrationTableContract,
} from "../src/db/postgres-migration-schema.js";

const contractPath = path.resolve(process.cwd(), "src/db/postgres-migration-contract.ts");

const BOOLEAN_COLUMNS = new Set([
  "account_deletion_completion_outbox.secret_purge_checkpoint_pending",
  "account_privacy_settings.email_updates_enabled",
  "account_privacy_settings.optional_analytics_enabled",
  "account_privacy_settings.product_research_enabled",
  "account_privacy_settings.venue_report_inclusion_enabled",
  "accounts.is_over_18_verified",
  "age_verifications.is_over_18",
  "missions.active",
  "missions.sponsor_flag",
  "pint_point_drink_records.is_alcoholic",
  "profiles.is_over_18_verified",
  "submission_items.is_happy_hour_price",
  "submission_items.requires_catalog_approval",
  "submissions.fraud_flagged",
  "submissions.points_eligible_by_location",
  "venue_beers.in_stock",
  "venue_beers.on_tap",
  "venue_happy_hours.active",
  "venue_price_records.is_happy_hour_price",
  "venue_profiles.accepts_pint_path_codes",
  "venue_profiles.active",
  "venue_profiles.featured_special_eligible",
  "venue_profiles.highlighted_name",
  "venue_profiles.intro_trial_ever_claimed",
  "venue_profiles.promoted",
  "venue_profiles.tier_manual_override",
  "venue_specials.active",
  "venue_specials.exclusive",
]);

const JSON_ARRAY_COLUMNS = new Set([
  "account_preferences.preferred_beers_json",
  "account_preferences.preferred_suburbs_json",
  "account_preferences.preferred_use_cases_json",
  "admin_ingestion_queue.extracted_beers_json",
  "admin_ingestion_queue.review_beers_json",
  "venue_happy_hours.days_of_week_json",
  "venue_happy_hours.happy_hour_beers_json",
  "venue_profiles.venue_tags_json",
  "venue_specials.days_of_week_json",
]);

const JSON_OBJECT_COLUMNS = new Set([
  "account_deletion_requests.result_summary_json",
  "account_reward_vouchers.metadata_json",
  "admin_ingestion_queue.crawler_feedback_json",
  "discount_redemptions.metadata_json",
  "events.metadata_json",
  "free_pint_reward_codes.metadata_json",
  "free_pint_reward_redemptions.metadata_json",
  "migration_quarantined_records.payload_json",
  "pint_point_drink_records.metadata_json",
  "pint_point_ledger.metadata_json",
  "saved_items.metadata_json",
  "security_audit_log.metadata_json",
  "stripe_webhook_events.payload_json",
  "submissions.ocr_summary_json",
  "submissions.pending_venue_json",
  "system_state.value_json",
  "user_activity_events.metadata_json",
  "venue_monthly_reports.data_json",
  "venue_pending_changes.payload_json",
  "venue_profiles.opening_hours_json",
]);

const CALENDAR_MONTH_COLUMNS = new Set([
  "contribution_ledger.month_key",
  "leaderboard_prize_awards.month_key",
  "leaderboard_prize_campaigns.month_key",
  "venue_monthly_reports.month",
]);

const LOCAL_TIME_COLUMNS = new Set([
  "venue_happy_hours.end_time",
  "venue_happy_hours.start_time",
  "venue_specials.end_time",
  "venue_specials.start_time",
]);

const FLOAT64_COLUMNS = new Set([
  "submissions.distance_to_venue_meters",
  "submissions.upload_accuracy_meters",
  "submissions.upload_latitude",
  "submissions.upload_longitude",
  "venue_location_cache.latitude",
  "venue_location_cache.longitude",
]);

const EXTRA_UTC_INSTANT_COLUMNS = new Set([
  "venue_profiles.subscription_current_period_end",
]);

function conversionFor(tableName: string, columnName: string, declaredType: string): PostgresMigrationConversion {
  const qualifiedName = `${tableName}.${columnName}`;
  if (BOOLEAN_COLUMNS.has(qualifiedName)) return "boolean";
  if (JSON_ARRAY_COLUMNS.has(qualifiedName)) return "json-array";
  if (JSON_OBJECT_COLUMNS.has(qualifiedName)) return "json-object";
  if (CALENDAR_MONTH_COLUMNS.has(qualifiedName)) return "calendar-month";
  if (LOCAL_TIME_COLUMNS.has(qualifiedName)) return "local-time";
  if (FLOAT64_COLUMNS.has(qualifiedName)) return "float64";
  if (EXTRA_UTC_INSTANT_COLUMNS.has(qualifiedName) || /_(?:after|at|until)$/.test(columnName)) {
    return "utc-instant";
  }
  if (declaredType === "BLOB") return "binary";
  if (declaredType === "INTEGER") return "integer";
  if (declaredType === "REAL") return "decimal";
  if (declaredType === "TEXT") return "text";
  throw new Error(`Unsupported declared SQLite type for ${qualifiedName}.`);
}

function topologicalOrder(tables: readonly PostgresMigrationTableContract[]): string[] {
  const pending = new Map(tables.map((table) => [table.name, table]));
  const ordered: string[] = [];
  while (pending.size > 0) {
    const ready = Array.from(pending.values())
      .filter((table) => table.dependencies.every((dependency) => !pending.has(dependency)))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    if (ready.length === 0) throw new Error("SQLite source schema contains a foreign-key cycle.");
    for (const table of ready) {
      pending.delete(table.name);
      ordered.push(table.name);
    }
  }
  return ordered;
}

export function generatePostgresMigrationContract(): PostgresMigrationContract {
  const database = new BetterSqlite3(":memory:");
  try {
    initializeDatabaseSchema(database);
    const inspection = inspectPostgresMigrationSchema(database);
    const tables: PostgresMigrationTableContract[] = inspection.descriptor.tables.map((table) => ({
      name: table.name,
      dependencies: Array.from(new Set(table.foreignKeys.map((foreignKey) => foreignKey.table)))
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
      columns: table.columns.map((column) => {
        if (!["BLOB", "INTEGER", "REAL", "TEXT"].includes(column.type)) {
          throw new Error(`Unsupported declared SQLite type in ${table.name}.${column.name}.`);
        }
        return [
          column.name,
          column.type as "BLOB" | "INTEGER" | "REAL" | "TEXT",
          conversionFor(table.name, column.name, column.type),
          column.notnull === 0 && column.pk === 0,
          column.pk,
        ] as const;
      }),
    }));
    const jsonColumns = tables.flatMap((table) => table.columns)
      .filter((column) => column[2] === "json-array" || column[2] === "json-object").length;
    if (BOOLEAN_COLUMNS.size !== 28 || jsonColumns !== 29) {
      throw new Error("Reviewed boolean/JSON conversion inventory is incomplete.");
    }
    return {
      kind: POSTGRES_MIGRATION_CONTRACT_KIND,
      version: POSTGRES_MIGRATION_CONTRACT_VERSION,
      sourceSchemaVersion: POSTGRES_MIGRATION_SOURCE_SCHEMA_VERSION,
      expectedSchemaFingerprint: inspection.fingerprint,
      expectedCounts: inspection.counts,
      importOrder: topologicalOrder(tables),
      tables,
    };
  } finally {
    database.close();
  }
}

export function serializePostgresMigrationContractSource(contract: PostgresMigrationContract): string {
  return `import type { PostgresMigrationContract } from "./postgres-migration-schema.js";\n\n` +
    `// Generated by scripts/generate-postgres-migration-contract.ts. Do not edit by hand.\n` +
    `// Every SQLite source column has an explicit, reviewed conversion.\n` +
    `export const POSTGRES_MIGRATION_CONTRACT = ${JSON.stringify(contract, null, 2)} as const satisfies PostgresMigrationContract;\n`;
}

export function checkPostgresMigrationContract(): boolean {
  const expected = serializePostgresMigrationContractSource(generatePostgresMigrationContract());
  return fs.existsSync(contractPath) && fs.readFileSync(contractPath, "utf8") === expected;
}

export function writePostgresMigrationContract(): string {
  fs.writeFileSync(
    contractPath,
    serializePostgresMigrationContractSource(generatePostgresMigrationContract()),
    { mode: 0o600 },
  );
  return contractPath;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const argument = process.argv[2] ?? "--print";
  if (argument === "--print") {
    process.stdout.write(serializePostgresMigrationContractSource(generatePostgresMigrationContract()));
  } else if (argument === "--write") {
    process.stdout.write(`${writePostgresMigrationContract()}\n`);
  } else if (argument === "--check") {
    if (!checkPostgresMigrationContract()) {
      console.error("Postgres migration contract is stale; regenerate and review it.");
      process.exitCode = 1;
    }
  } else {
    console.error("Expected --print, --write, or --check.");
    process.exitCode = 2;
  }
}
