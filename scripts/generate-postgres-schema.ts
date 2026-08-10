import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import {
  sha256PostgresMigrationContract,
  type PostgresMigrationConversion,
  type PostgresMigrationTableContract,
} from "../src/db/postgres-migration-schema.js";

const sourceSchemaPath = path.resolve(process.cwd(), "src/db/schema.sql");
const databaseModulePath = path.resolve(process.cwd(), "src/db/database.ts");
const outputSchemaPath = path.resolve(process.cwd(), "src/db/postgres-schema.sql");
const supabaseMigrationsDirectory = path.resolve(process.cwd(), "supabase/migrations");
const supabaseMigrationSuffix = "_create_pintpath_postgres_runtime.sql";

interface TableDefinition {
  name: string;
  sql: string;
  dependencies: Set<string>;
}

const postgresTypeByConversion = {
  binary: "bytea",
  boolean: "boolean",
  "calendar-month": "text",
  decimal: "numeric",
  float64: "double precision",
  integer: "bigint",
  "json-array": "jsonb",
  "json-object": "jsonb",
  "local-time": "time without time zone",
  text: "text",
  "utc-instant": "timestamptz",
} as const satisfies Record<PostgresMigrationConversion, string>;

function readCreateStatements(sql: string, pattern: RegExp): string[] {
  return Array.from(sql.matchAll(pattern), (match) => match[0].trim());
}

function parseTableDefinitions(sql: string): TableDefinition[] {
  const statements = readCreateStatements(
    sql,
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+[a-z0-9_]+\s*\([\s\S]*?\n\);/gi,
  );
  return statements.map((statement) => {
    const name = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)/i.exec(statement)?.[1];
    if (!name) throw new Error("Unable to parse SQLite table name.");
    return {
      name,
      sql: statement,
      dependencies: new Set(
        Array.from(statement.matchAll(/REFERENCES\s+([a-z0-9_]+)/gi), (match) => match[1]!),
      ),
    };
  });
}

function orderTablesByForeignKeys(tables: readonly TableDefinition[]): TableDefinition[] {
  const pending = new Map(tables.map((table) => [table.name, table]));
  const ordered: TableDefinition[] = [];
  while (pending.size > 0) {
    const ready = Array.from(pending.values())
      .filter((table) => Array.from(table.dependencies).every((dependency) => !pending.has(dependency)))
      .sort((first, second) => first.name.localeCompare(second.name));
    if (ready.length === 0) {
      throw new Error(`Postgres schema contains a foreign-key cycle: ${Array.from(pending.keys()).join(", ")}`);
    }
    for (const table of ready) {
      pending.delete(table.name);
      ordered.push(table);
    }
  }
  return ordered;
}

function splitTopLevelSqlList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let state: "normal" | "single" | "double" = "normal";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (state === "single") {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        state = "normal";
      }
      continue;
    }
    if (state === "double") {
      if (character === '"' && next === '"') {
        index += 1;
      } else if (character === '"') {
        state = "normal";
      }
      continue;
    }
    if (character === "'") {
      state = "single";
    } else if (character === '"') {
      state = "double";
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) throw new Error("SQLite table DDL contains unbalanced parentheses.");
    } else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (state !== "normal" || depth !== 0) {
    throw new Error("SQLite table DDL contains an unterminated quote or unbalanced parentheses.");
  }
  parts.push(value.slice(start));
  return parts;
}

function appendColumnConstraint(definition: string, constraint: string): string {
  const trimmed = definition.trimEnd();
  return `${trimmed} ${constraint}${definition.slice(trimmed.length)}`;
}

function convertSqliteTableDdl(
  table: TableDefinition,
  contract: PostgresMigrationTableContract,
): string {
  const openingMatch = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+[a-z0-9_]+\s*\(/i.exec(table.sql);
  const closingIndex = table.sql.lastIndexOf("\n);");
  if (!openingMatch || closingIndex < openingMatch.index + openingMatch[0].length) {
    throw new Error(`Unable to split SQLite table DDL for ${table.name}.`);
  }
  const contractColumns = new Map(contract.columns.map((column) => [column[0], column]));
  const seenColumns = new Set<string>();
  const bodyStart = openingMatch.index + openingMatch[0].length;
  const convertedParts = splitTopLevelSqlList(table.sql.slice(bodyStart, closingIndex)).map((part) => {
    const columnMatch = /^(\s*)([a-z0-9_]+)\s+(BLOB|INTEGER|REAL|TEXT)\b/i.exec(part);
    if (!columnMatch) return part;
    const columnName = columnMatch[2]!;
    const column = contractColumns.get(columnName);
    if (!column) {
      throw new Error(`Postgres migration contract is missing ${table.name}.${columnName}.`);
    }
    const [, declaredType, conversion] = column;
    if (columnMatch[3]!.toUpperCase() !== declaredType) {
      throw new Error(
        `Postgres migration contract type mismatch for ${table.name}.${columnName}: `
        + `${declaredType} does not match ${columnMatch[3]!.toUpperCase()}.`,
      );
    }
    if (seenColumns.has(columnName)) {
      throw new Error(`SQLite table DDL repeats ${table.name}.${columnName}.`);
    }
    seenColumns.add(columnName);

    let converted = `${columnMatch[1]}${columnName} ${postgresTypeByConversion[conversion]}`
      + part.slice(columnMatch[0].length);
    if (conversion === "boolean") {
      converted = converted
        .replace(/\bDEFAULT\s+0\b/gi, "DEFAULT false")
        .replace(/\bDEFAULT\s+1\b/gi, "DEFAULT true")
        .replace(
          new RegExp(`\\b${columnName}\\s+IN\\s*\\(\\s*0\\s*,\\s*1\\s*\\)`, "gi"),
          `${columnName} IN (false, true)`,
        );
      if (/\bDEFAULT\s+[01]\b/i.test(converted)) {
        throw new Error(`Boolean default was not converted for ${table.name}.${columnName}.`);
      }
    } else if (conversion === "json-array" || conversion === "json-object") {
      const defaultConversion = conversion === "json-array"
        ? {
            sourcePattern: /\bDEFAULT\s+'\[\]'/i,
            targetSql: "DEFAULT '[]'::jsonb",
          }
        : {
            sourcePattern: /\bDEFAULT\s+'\{\}'/i,
            targetSql: "DEFAULT '{}'::jsonb",
          };
      converted = converted.replace(
        defaultConversion.sourcePattern,
        defaultConversion.targetSql,
      );
      converted = appendColumnConstraint(
        converted,
        `CHECK (jsonb_typeof(${columnName}) = '${conversion === "json-array" ? "array" : "object"}')`,
      );
    } else if (conversion === "calendar-month") {
      converted = appendColumnConstraint(
        converted,
        `CHECK (${columnName} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')`,
      );
    }
    return converted;
  });

  const missingColumns = contract.columns
    .map((column) => column[0])
    .filter((columnName) => !seenColumns.has(columnName));
  if (missingColumns.length > 0 || seenColumns.size !== contract.columns.length) {
    throw new Error(
      `SQLite table DDL and migration contract columns differ for ${table.name}: ${missingColumns.join(", ")}.`,
    );
  }

  const header = table.sql.slice(0, bodyStart)
    .replace(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/gi, "CREATE TABLE");
  return `${header}${convertedParts.join(",")}${table.sql.slice(closingIndex)}`
    .replace(
      /\bjulianday\(\s*([a-z0-9_]+)\s*\)\s+IS\s+NOT\s+NULL\b/gi,
      "$1 IS NOT NULL",
    );
}

function convertSqliteIndexDdl(statement: string): string {
  switch (indexName(statement)) {
    case "idx_missions_admin_active_score":
      return `CREATE INDEX idx_missions_admin_active_score
  ON missions ((points * multiplier) DESC, updated_at DESC, id ASC)
  INCLUDE (venue_name)
  WHERE active;`;
    case "idx_missions_venue_updated_id":
      return `CREATE INDEX idx_missions_venue_updated_id
  ON missions (venue_id, updated_at DESC, id ASC)
  INCLUDE (venue_name);`;
    case "idx_contribution_ledger_created_points":
      return `CREATE INDEX idx_contribution_ledger_created_points
  ON contribution_ledger (created_at)
  INCLUDE (points);`;
    case "idx_auth_sessions_retention_revoked":
      return `CREATE INDEX idx_auth_sessions_retention_revoked
  ON auth_sessions (revoked_at, token_hash COLLATE "C")
  WHERE revoked_at IS NOT NULL;`;
    case "idx_auth_sessions_retention_expired":
      return `CREATE INDEX idx_auth_sessions_retention_expired
  ON auth_sessions (expires_at, token_hash COLLATE "C");`;
    case "idx_revoked_provider_sessions_retention":
      return `CREATE INDEX idx_revoked_provider_sessions_retention
  ON revoked_provider_sessions (
    revoked_at,
    user_id COLLATE "C",
    provider_session_id_hash COLLATE "C"
  )
  WHERE reason IN ('password_reset_completed', 'all_app_sessions_revoked');`;
    case "idx_submissions_reviewed_location_retention":
      return `CREATE INDEX idx_submissions_reviewed_location_retention
  ON submissions (reviewed_at, id COLLATE "C")
  WHERE reviewed_at IS NOT NULL
    AND status NOT IN ('pending', 'needs_more_evidence', 'disputed')
    AND (
      upload_latitude IS NOT NULL
      OR upload_longitude IS NOT NULL
      OR upload_accuracy_meters IS NOT NULL
      OR upload_location_captured_at IS NOT NULL
    );`;
    case "idx_submissions_venue_created_id":
      return `CREATE INDEX idx_submissions_venue_created_id
  ON submissions (venue_id, created_at DESC, id COLLATE "C");`;
    case "idx_migration_quarantined_records_retention":
      return `CREATE INDEX idx_migration_quarantined_records_retention
  ON migration_quarantined_records (quarantined_at, id COLLATE "C")
  WHERE payload_json <> '{"redactedAfterRetention":true}'::jsonb;`;
    case "idx_account_deletion_notification_events_retention":
      return `CREATE INDEX idx_account_deletion_notification_events_retention
  ON account_deletion_notification_events (received_at, event_id COLLATE "C")
  INCLUDE (request_id);`;
    case "idx_venue_profiles_duplicate_name":
      return `CREATE INDEX idx_venue_profiles_duplicate_name
  ON venue_profiles (
    lower(btrim(name)),
    lower(btrim(COALESCE(suburb, ''))),
    venue_id COLLATE "C"
  )
  INCLUDE (name, suburb)
  WHERE active;`;
    case "idx_venue_location_cache_duplicate_name":
      return `CREATE INDEX idx_venue_location_cache_duplicate_name
  ON venue_location_cache (
    lower(btrim(venue_name)),
    lower(btrim(COALESCE(suburb, ''))),
    venue_id COLLATE "C"
  )
  INCLUDE (venue_name, suburb);`;
    case "idx_venue_price_records_duplicate_name":
      return `CREATE INDEX idx_venue_price_records_duplicate_name
  ON venue_price_records (
    lower(btrim(venue_name)),
    lower(btrim(COALESCE(suburb, ''))),
    venue_id COLLATE "C",
    id COLLATE "C"
  )
  INCLUDE (venue_name, suburb);`;
    case "idx_venue_price_records_venue_normalized_beer":
      return `CREATE INDEX idx_venue_price_records_venue_normalized_beer
  ON venue_price_records (venue_id, normalized_beer_id)
  WHERE normalized_beer_id IS NOT NULL;`;
    case "idx_venue_price_records_venue_beer_name":
      return `CREATE INDEX idx_venue_price_records_venue_beer_name
  ON venue_price_records (venue_id, lower(btrim(beer_name)));`;
    case "idx_wrong_price_reports_venue_created_id":
      return `CREATE INDEX idx_wrong_price_reports_venue_created_id
  ON wrong_price_reports (venue_id, created_at DESC, id COLLATE "C");`;
  }
  return statement
    .replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/gi, "CREATE $1INDEX")
    .replace(/\s+COLLATE\s+NOCASE\b/gi, "");
}

function extractAdditionalIndexes(databaseModule: string): string[] {
  const block = /function\s+ensureIndexes\([\s\S]*?database\.exec\(`([\s\S]*?)`\);\n}/.exec(databaseModule)?.[1];
  if (!block) throw new Error("Unable to find ensureIndexes SQL in src/db/database.ts.");
  return readCreateStatements(
    block,
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+[a-z0-9_]+[\s\S]*?;/gi,
  );
}

function indexName(statement: string): string {
  const name = /CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z0-9_]+)/i.exec(statement)?.[1];
  if (!name) throw new Error("Unable to parse index name.");
  return name;
}

function compatibilityFunctions(): string {
  return String.raw`
CREATE OR REPLACE FUNCTION pintpath_app.json_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$ SELECT true $$;

CREATE OR REPLACE FUNCTION pintpath_app.json_extract(value jsonb, sqlite_path text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  path_parts text[];
  extracted jsonb;
BEGIN
  IF sqlite_path = '$' THEN
    extracted := value;
  ELSIF sqlite_path !~ '^\$\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$' THEN
    RETURN NULL;
  ELSE
    path_parts := string_to_array(substr(sqlite_path, 3), '.');
    extracted := value #> path_parts;
  END IF;
  IF extracted IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(extracted) = 'string' THEN RETURN extracted #>> '{}'; END IF;
  RETURN extracted::text;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION pintpath_app.json_each(document jsonb, sqlite_path text DEFAULT '$')
RETURNS TABLE(key text, value text, type text)
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  target jsonb;
  path_parts text[];
BEGIN
  IF sqlite_path = '$' THEN
    target := document;
  ELSIF sqlite_path ~ '^\$\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$' THEN
    path_parts := string_to_array(substr(sqlite_path, 3), '.');
    target := document #> path_parts;
  ELSE
    RETURN;
  END IF;
  IF jsonb_typeof(target) = 'array' THEN
    RETURN QUERY
      SELECT (entry.ordinality - 1)::text,
             CASE WHEN jsonb_typeof(entry.element) = 'string' THEN entry.element #>> '{}' ELSE entry.element::text END,
             CASE jsonb_typeof(entry.element) WHEN 'string' THEN 'text' WHEN 'number' THEN 'real' ELSE jsonb_typeof(entry.element) END
      FROM jsonb_array_elements(target) WITH ORDINALITY AS entry(element, ordinality);
  ELSIF jsonb_typeof(target) = 'object' THEN
    RETURN QUERY
      SELECT entry.object_key,
             CASE WHEN jsonb_typeof(entry.element) = 'string' THEN entry.element #>> '{}' ELSE entry.element::text END,
             CASE jsonb_typeof(entry.element) WHEN 'string' THEN 'text' WHEN 'number' THEN 'real' ELSE jsonb_typeof(entry.element) END
      FROM jsonb_each(target) AS entry(object_key, element);
  END IF;
EXCEPTION WHEN others THEN
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION pintpath_app.instr(value text, fragment text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$ SELECT strpos(value, fragment) $$;

CREATE OR REPLACE FUNCTION pintpath_app.julianday(value timestamptz, modifier text DEFAULT NULL)
RETURNS double precision
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  parsed timestamptz;
BEGIN
  parsed := value;
  IF modifier IS NOT NULL THEN parsed := parsed + modifier::interval; END IF;
  RETURN extract(epoch FROM parsed) / 86400.0 + 2440587.5;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION pintpath_app.datetime(value timestamptz)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$ SELECT value $$;

CREATE OR REPLACE FUNCTION pintpath_app.strftime(format text, value timestamptz, modifier text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  parsed timestamptz;
  year_start date;
  first_monday date;
  sqlite_week integer;
BEGIN
  parsed := value;
  IF modifier IS NOT NULL THEN parsed := parsed + modifier::interval; END IF;
  year_start := date_trunc('year', parsed AT TIME ZONE 'UTC')::date;
  first_monday := year_start + ((8 - extract(isodow FROM year_start)::integer) % 7);
  sqlite_week := CASE
    WHEN (parsed AT TIME ZONE 'UTC')::date < first_monday THEN 0
    ELSE (((parsed AT TIME ZONE 'UTC')::date - first_monday) / 7) + 1
  END;
  RETURN CASE format
    WHEN '%Y-%m-%dT%H:%M:%fZ' THEN to_char(parsed AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    WHEN '%Y-W%W' THEN to_char(parsed AT TIME ZONE 'UTC', 'YYYY') || '-W' || lpad(sqlite_week::text, 2, '0')
    WHEN '%Y-%m' THEN to_char(parsed AT TIME ZONE 'UTC', 'YYYY-MM')
    ELSE NULL
  END;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
`;
}

function validationTriggers(): string {
  return String.raw`
CREATE OR REPLACE FUNCTION pintpath_app.clear_account_references_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pintpath_app, pg_catalog
AS $$
BEGIN
  UPDATE pint_point_drink_records SET voided_by_user_id = NULL WHERE voided_by_user_id = OLD.id;
  UPDATE venue_claim_requests SET reviewed_by = NULL WHERE reviewed_by = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER clear_added_account_references_before_delete
BEFORE DELETE ON accounts
FOR EACH ROW EXECUTE FUNCTION pintpath_app.clear_account_references_before_delete();
`;
}

function securityBoundary(tableNames: readonly string[]): string {
  return tableNames.map((tableName) => `
ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${tableName}_runtime_all ON ${tableName}
  FOR ALL TO pintpath_runtime USING (true) WITH CHECK (true);
CREATE POLICY ${tableName}_migrator_select ON ${tableName}
  FOR SELECT TO pintpath_migrator USING (true);
CREATE POLICY ${tableName}_migrator_insert ON ${tableName}
  FOR INSERT TO pintpath_migrator WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ${tableName} TO pintpath_runtime;
GRANT SELECT, INSERT ON ${tableName} TO pintpath_migrator;`).join("\n");
}

function operationsSecurityBoundary(): string {
  return ["migration_runs", "migration_chunks"].map((tableName) => `
ALTER TABLE pintpath_ops.${tableName} ENABLE ROW LEVEL SECURITY;
ALTER TABLE pintpath_ops.${tableName} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${tableName}_migrator_select ON pintpath_ops.${tableName}
  FOR SELECT TO pintpath_migrator USING (true);
CREATE POLICY ${tableName}_migrator_insert ON pintpath_ops.${tableName}
  FOR INSERT TO pintpath_migrator WITH CHECK (true);
CREATE POLICY ${tableName}_migrator_update ON pintpath_ops.${tableName}
  FOR UPDATE TO pintpath_migrator USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON pintpath_ops.${tableName} TO pintpath_migrator;`).join("\n");
}

function logicalBackupSecurityBoundary(tableNames: readonly string[]): string {
  const targets = [
    ...tableNames.map((tableName) => ({
      schemaName: "pintpath_app",
      tableName,
    })),
    { schemaName: "pintpath_app", tableName: "schema_metadata" },
    { schemaName: "pintpath_ops", tableName: "migration_chunks" },
    { schemaName: "pintpath_ops", tableName: "migration_runs" },
  ].sort((left, right) => {
    const leftName = `${left.schemaName}.${left.tableName}`;
    const rightName = `${right.schemaName}.${right.tableName}`;
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  const targetValues = targets
    .map(({ schemaName, tableName }) => `      ('${schemaName}', '${tableName}')`)
    .join(",\n");
  const policies = targets.map(({ schemaName, tableName }) => `
CREATE POLICY ${tableName}_logical_backup_select ON ${schemaName}.${tableName}
  AS PERMISSIVE
  FOR SELECT TO PUBLIC
  USING (CURRENT_USER = ('pintpath_logical_backup_d' || (SELECT database.oid::text
    FROM pg_catalog.pg_database AS database
    WHERE database.datname = pg_catalog.current_database())));`).join("\n");

  const policyInventoryGuard = `DO $$
DECLARE
  runtime_role_oid oid;
  migrator_role_oid oid;
  private_policy_count integer;
  exact_base_policy_count integer;
  exact_backup_policy_count integer;
BEGIN
  SELECT pg_catalog.to_regrole('pintpath_runtime')::oid,
         pg_catalog.to_regrole('pintpath_migrator')::oid
    INTO STRICT runtime_role_oid, migrator_role_oid;

  SELECT count(*)::integer INTO private_policy_count
  FROM pg_catalog.pg_policy AS policy
  JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops']);

  SELECT count(*)::integer INTO exact_base_policy_count
  FROM pg_catalog.pg_policy AS policy
  JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
    AND policy.polpermissive
    AND (
      (
        namespace.nspname = 'pintpath_app'
        AND relation.relname <> 'schema_metadata'
        AND (
          (
            policy.polname = (relation.relname || '_runtime_all')::name
            AND policy.polroles = ARRAY[runtime_role_oid]::oid[]
            AND policy.polcmd = '*'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
          OR (
            policy.polname = (relation.relname || '_migrator_select')::name
            AND policy.polroles = ARRAY[migrator_role_oid]::oid[]
            AND policy.polcmd = 'r'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            AND policy.polwithcheck IS NULL
          )
          OR (
            policy.polname = (relation.relname || '_migrator_insert')::name
            AND policy.polroles = ARRAY[migrator_role_oid]::oid[]
            AND policy.polcmd = 'a'
            AND policy.polqual IS NULL
            AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
        )
      )
      OR (
        namespace.nspname = 'pintpath_app'
        AND relation.relname = 'schema_metadata'
        AND (
          (
            policy.polname = 'schema_metadata_runtime_read'::name
            AND policy.polroles = ARRAY[runtime_role_oid]::oid[]
            AND policy.polcmd = 'r'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            AND policy.polwithcheck IS NULL
          )
          OR (
            policy.polname = 'schema_metadata_migrator_select'::name
            AND policy.polroles = ARRAY[migrator_role_oid]::oid[]
            AND policy.polcmd = 'r'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            AND policy.polwithcheck IS NULL
          )
          OR (
            policy.polname = 'schema_metadata_migrator_update'::name
            AND policy.polroles = ARRAY[migrator_role_oid]::oid[]
            AND policy.polcmd = 'w'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
        )
      )
      OR (
        namespace.nspname = 'pintpath_ops'
        AND relation.relname = ANY(ARRAY['migration_chunks', 'migration_runs'])
        AND (
          (
            policy.polname = (relation.relname || '_migrator_select')::name
            AND policy.polroles = ARRAY[migrator_role_oid]::oid[]
            AND policy.polcmd = 'r'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            AND policy.polwithcheck IS NULL
          )
          OR (
            policy.polname = (relation.relname || '_migrator_insert')::name
            AND policy.polroles = ARRAY[migrator_role_oid]::oid[]
            AND policy.polcmd = 'a'
            AND policy.polqual IS NULL
            AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
          OR (
            policy.polname = (relation.relname || '_migrator_update')::name
            AND policy.polroles = ARRAY[migrator_role_oid]::oid[]
            AND policy.polcmd = 'w'
            AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
            AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) = 'true'
          )
        )
      )
    );

  SELECT count(*)::integer INTO exact_backup_policy_count
  FROM pg_catalog.pg_policy AS policy
  JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
    AND policy.polname = (relation.relname || '_logical_backup_select')::name
    AND policy.polroles = ARRAY[0]::oid[]
    AND policy.polcmd = 'r'
    AND policy.polpermissive
    AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = $policy$(CURRENT_USER = ('pintpath_logical_backup_d'::text || ( SELECT (database.oid)::text AS oid
   FROM pg_database database
  WHERE (database.datname = current_database()))))$policy$
    AND policy.polwithcheck IS NULL;

  IF private_policy_count <> 236
     OR exact_base_policy_count <> 177
     OR exact_backup_policy_count <> 59 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Pint Path schema bootstrap produced a non-canonical private policy inventory.',
      DETAIL = 'Required: exactly 177 runtime/migrator policies plus 59 portable logical-backup policies, with no extras or omissions.';
  END IF;
END
$$;`;

  return `-- The reusable backup group is scoped to this database OID. PostgreSQL
-- role names are cluster-global, so the OID binding prevents a login for one
-- database from assuming another database's reviewed backup role.
DO $$
DECLARE
  database_oid oid;
  database_oid_text text;
  backup_role_name text;
  backup_role_oid oid;
  executor_is_superuser boolean;
  role_exists boolean;
  target record;
BEGIN
  SELECT database.oid, database.oid::text
    INTO STRICT database_oid, database_oid_text
  FROM pg_catalog.pg_database AS database
  WHERE database.datname = pg_catalog.current_database();

  IF database_oid = 0::oid
     OR database_oid_text !~ '^[1-9][0-9]{0,9}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Refusing Pint Path schema bootstrap because the current database OID is not canonical.';
  END IF;
  backup_role_name := 'pintpath_logical_backup_d' || database_oid_text;

  SELECT role.rolsuper INTO STRICT executor_is_superuser
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = current_user;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles AS role
    WHERE role.rolname LIKE (backup_role_name || '\\_v%') ESCAPE '\\'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Refusing Pint Path schema bootstrap because the current database login namespace is not empty.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = backup_role_name
  ) INTO role_exists;

  -- PostgreSQL 17 makes a non-superuser CREATEROLE principal an ADMIN-only
  -- child of each role it creates. That cluster-global authority cannot be
  -- revoked by the creator, so leave the portable policies inert instead of
  -- weakening the zero-child backup-group contract.
  IF NOT role_exists AND NOT executor_is_superuser THEN
    RETURN;
  END IF;

  IF NOT role_exists THEN
    EXECUTE pg_catalog.format(
      'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      backup_role_name
    );
  END IF;

  SELECT role.oid INTO STRICT backup_role_oid
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = backup_role_name;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role
    WHERE role.oid = backup_role_oid
      AND (
        role.rolcanlogin
        OR role.rolsuper
        OR role.rolcreatedb
        OR role.rolcreaterole
        OR role.rolinherit
        OR role.rolreplication
        OR role.rolbypassrls
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.member = role.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.roleid = role.oid
        )
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_db_role_setting AS setting
          WHERE setting.setrole = role.oid
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_database AS granted_database
          CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
            granted_database.datacl,
            pg_catalog.acldefault('d', granted_database.datdba)
          )) AS privilege
          WHERE privilege.grantee = role.oid
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_proc AS routine
          CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )) AS privilege
          WHERE privilege.grantee = role.oid
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_namespace AS namespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
            namespace.nspacl,
            pg_catalog.acldefault('n', namespace.nspowner)
          )) AS privilege
          WHERE privilege.grantee = role.oid
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class AS relation
          CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
            relation.relacl,
            pg_catalog.acldefault(
              (CASE WHEN relation.relkind = 'S' THEN 'S' ELSE 'r' END)::"char",
              relation.relowner
            )
          )) AS privilege
          WHERE privilege.grantee = role.oid
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
          WHERE attribute.attnum > 0
            AND NOT attribute.attisdropped
            AND attribute.attacl IS NOT NULL
            AND privilege.grantee = role.oid
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_shdepend AS dependency
          WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
            AND dependency.refobjid = role.oid
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = pg_catalog.format(
        'Refusing Pint Path schema bootstrap because scoped role %I is unsafe or already active.',
        backup_role_name
      ),
      DETAIL = 'Required: safe NOLOGIN NOINHERIT role with no parents, children, settings, ACLs, or ownership before bootstrap grants.';
  END IF;

  EXECUTE pg_catalog.format(
    'GRANT USAGE ON SCHEMA pintpath_app, pintpath_ops TO %I',
    backup_role_name
  );
  FOR target IN
    SELECT * FROM (VALUES
${targetValues}
    ) AS inventory(schema_name, table_name)
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON %I.%I TO %I',
      target.schema_name,
      target.table_name,
      backup_role_name
    );
  END LOOP;

  -- The reviewed generated inventory currently has no sequences. SELECT is
  -- the only sequence privilege pg_dump may receive if that inventory changes.
  EXECUTE pg_catalog.format(
    'GRANT SELECT ON ALL SEQUENCES IN SCHEMA pintpath_app, pintpath_ops TO %I',
    backup_role_name
  );

  IF (
    SELECT count(*)
    FROM pg_catalog.pg_shdepend AS dependency
    WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND dependency.refobjid = backup_role_oid
  ) <> 61 OR (
    SELECT count(*)
    FROM pg_catalog.pg_shdepend AS dependency
    WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND dependency.refobjid = backup_role_oid
      AND dependency.dbid = database_oid
      AND dependency.objsubid = 0
      AND dependency.deptype = 'a'
      AND (
        (
          dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
          AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_namespace AS namespace
            WHERE namespace.oid = dependency.objid
              AND namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
          )
        )
        OR (
          dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
          AND EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class AS relation
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            WHERE relation.oid = dependency.objid
              AND namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
              AND relation.relkind IN ('r', 'p')
          )
        )
      )
  ) <> 61 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Pint Path schema bootstrap produced unexpected scoped-role dependencies.';
  END IF;
END
$$;
${policies}

${policyInventoryGuard}`;
}

export function generatePostgresSchema(input: {
  sqliteSchema: string;
  databaseModule: string;
}): string {
  const tables = orderTablesByForeignKeys(parseTableDefinitions(input.sqliteSchema));
  const contractTableByName = new Map<string, PostgresMigrationTableContract>(
    POSTGRES_MIGRATION_CONTRACT.tables.map((table) => [table.name, table]),
  );
  if (
    tables.length !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
    || contractTableByName.size !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
  ) {
    throw new Error(
      "SQLite schema and reviewed Postgres migration contract do not contain the expected table count.",
    );
  }
  for (const table of tables) {
    const contractTable = contractTableByName.get(table.name);
    if (!contractTable) {
      throw new Error(`Postgres migration contract is missing source table ${table.name}.`);
    }
    const sourceDependencies = [...table.dependencies].sort();
    const contractDependencies = [...contractTable.dependencies].sort();
    if (JSON.stringify(sourceDependencies) !== JSON.stringify(contractDependencies)) {
      throw new Error(`Foreign-key dependencies differ for source table ${table.name}.`);
    }
  }
  for (const contractTableName of contractTableByName.keys()) {
    if (!tables.some((table) => table.name === contractTableName)) {
      throw new Error(`Postgres migration contract contains unknown table ${contractTableName}.`);
    }
  }
  const contractColumnCount = POSTGRES_MIGRATION_CONTRACT.tables.reduce(
    (total, table) => total + table.columns.length,
    0,
  );
  if (contractColumnCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns) {
    throw new Error("Reviewed Postgres migration contract contains an unexpected column count.");
  }
  const baseIndexes = readCreateStatements(
    input.sqliteSchema,
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+[a-z0-9_]+[\s\S]*?;/gi,
  );
  const indexByName = new Map<string, string>();
  for (const statement of [...baseIndexes, ...extractAdditionalIndexes(input.databaseModule)]) {
    indexByName.set(indexName(statement), statement);
  }
  if (indexByName.size !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.explicitIndexes) {
    throw new Error(
      `SQLite schema exposes ${indexByName.size} explicit indexes; reviewed contract expects `
      + `${POSTGRES_MIGRATION_CONTRACT.expectedCounts.explicitIndexes}.`,
    );
  }
  const body = [
    ...tables.map((table) => convertSqliteTableDdl(table, contractTableByName.get(table.name)!)),
    ...Array.from(indexByName.values())
      .sort((first, second) => indexName(first).localeCompare(indexName(second)))
      .map(convertSqliteIndexDdl),
  ].join("\n\n");
  const sourceChecksum = crypto.createHash("sha256").update(input.sqliteSchema).digest("hex");
  const contractChecksum = sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT);
  const schemaMetadataEntries = [
    ["schema_version", "1"],
    ["import_state", "empty"],
    ["source_schema_sha256", sourceChecksum],
    ["migration_contract_sha256", contractChecksum],
    ["migration_candidate_sha", ""],
    ["migration_manifest_sha256", ""],
    ["migration_plan_sha256", ""],
    ["migration_run_sha256", ""],
    ["source_schema_fingerprint", ""],
    ["source_schema_version", "0"],
    ["source_snapshot_sha256", ""],
    ["target_ddl_sha256", ""],
  ] as const;
  if (new Set(schemaMetadataEntries.map(([key]) => key)).size !== schemaMetadataEntries.length) {
    throw new Error("Generated Postgres schema metadata contains duplicate keys.");
  }
  const schemaMetadataValues = schemaMetadataEntries
    .map(([key, value]) => `  ('${key}', '${value}')`)
    .join(",\n");
  return `-- Generated by scripts/generate-postgres-schema.ts. Do not edit by hand.
-- Canonical SQLite schema SHA-256: ${sourceChecksum}
-- Reviewed migration contract SHA-256: ${contractChecksum}
-- The application and operations schemas are intentionally outside the Supabase Data API.

BEGIN;

-- Create least-privilege group roles once. Catalog validation keeps reruns
-- fail-closed without provider-restricted ALTER ROLE attribute changes.
DO $$
DECLARE
  role_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS roles
    WHERE roles.rolname = 'pintpath_runtime'
  ) THEN
    CREATE ROLE pintpath_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS roles
    WHERE roles.rolname = 'pintpath_migrator'
  ) THEN
    CREATE ROLE pintpath_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  FOREACH role_name IN ARRAY ARRAY['pintpath_runtime', 'pintpath_migrator'] LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS roles
      WHERE roles.rolname = role_name
        AND (
          roles.rolcanlogin
          OR roles.rolsuper
          OR roles.rolcreatedb
          OR roles.rolcreaterole
          OR NOT roles.rolinherit
          OR roles.rolreplication
          OR roles.rolbypassrls
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = pg_catalog.format(
          'Refusing Pint Path schema bootstrap because role %I has unsafe attributes.',
          role_name
        ),
        DETAIL = 'Required attributes: NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS.',
        HINT = 'Have a cluster administrator harden or recreate the role, then rerun this migration.';
    END IF;
  END LOOP;

END
$$;

CREATE SCHEMA pintpath_app;
CREATE SCHEMA pintpath_ops;
REVOKE ALL ON SCHEMA pintpath_app FROM PUBLIC;
REVOKE ALL ON SCHEMA pintpath_ops FROM PUBLIC;
GRANT USAGE ON SCHEMA pintpath_app TO pintpath_runtime;
GRANT USAGE ON SCHEMA pintpath_app TO pintpath_migrator;
GRANT USAGE ON SCHEMA pintpath_ops TO pintpath_migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA pintpath_app REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA pintpath_app REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA pintpath_app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA pintpath_ops REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA pintpath_ops REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA pintpath_ops REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
SET LOCAL search_path = pintpath_app, pg_catalog;

${compatibilityFunctions()}

${body}

CREATE TABLE schema_metadata (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE pintpath_ops.migration_runs (
  run_id text PRIMARY KEY,
  source_snapshot_sha256 text NOT NULL CHECK (length(source_snapshot_sha256) = 64),
  source_schema_fingerprint text NOT NULL CHECK (length(source_schema_fingerprint) = 64),
  contract_sha256 text NOT NULL CHECK (length(contract_sha256) = 64),
  manifest_sha256 text NOT NULL CHECK (length(manifest_sha256) = 64),
  target_ddl_sha256 text NOT NULL CHECK (length(target_ddl_sha256) = 64),
  source_schema_version integer NOT NULL,
  candidate_commit_sha text NOT NULL,
  target_binding_sha256 text NOT NULL CHECK (length(target_binding_sha256) = 64),
  expected_environment text NOT NULL CHECK (expected_environment IN ('permanent-staging', 'production')),
  approval_reference_sha256 text NOT NULL CHECK (length(approval_reference_sha256) = 64),
  operator_id_sha256 text NOT NULL CHECK (length(operator_id_sha256) = 64),
  verifier_id_sha256 text CHECK (verifier_id_sha256 IS NULL OR length(verifier_id_sha256) = 64),
  status text NOT NULL CHECK (status IN ('planned', 'importing', 'verifying', 'ready', 'failed')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  receipt_sha256 text CHECK (receipt_sha256 IS NULL OR length(receipt_sha256) = 64),
  failure_code text
);

CREATE UNIQUE INDEX migration_runs_source_target_unique
  ON pintpath_ops.migration_runs (source_snapshot_sha256, target_binding_sha256);

CREATE TABLE pintpath_ops.migration_chunks (
  run_id text NOT NULL REFERENCES pintpath_ops.migration_runs(run_id) ON DELETE CASCADE,
  table_name text NOT NULL,
  chunk_ordinal integer NOT NULL CHECK (chunk_ordinal >= 0),
  row_count integer NOT NULL CHECK (row_count >= 0),
  source_transformed_sha256 text NOT NULL CHECK (length(source_transformed_sha256) = 64),
  target_sha256 text NOT NULL CHECK (length(target_sha256) = 64),
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, table_name, chunk_ordinal)
);

INSERT INTO schema_metadata (key, value) VALUES
${schemaMetadataValues};

${validationTriggers()}

${securityBoundary(tables.map((table) => table.name))}

${operationsSecurityBoundary()}

ALTER TABLE schema_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_metadata FORCE ROW LEVEL SECURITY;
CREATE POLICY schema_metadata_runtime_read ON schema_metadata
  FOR SELECT TO pintpath_runtime USING (true);
CREATE POLICY schema_metadata_migrator_select ON schema_metadata
  FOR SELECT TO pintpath_migrator USING (true);
CREATE POLICY schema_metadata_migrator_update ON schema_metadata
  FOR UPDATE TO pintpath_migrator USING (true) WITH CHECK (true);
GRANT SELECT ON schema_metadata TO pintpath_runtime;
GRANT SELECT, UPDATE ON schema_metadata TO pintpath_migrator;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pintpath_app FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pintpath_ops FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pintpath_app TO pintpath_runtime;

${logicalBackupSecurityBoundary(tables.map((table) => table.name))}

COMMIT;
`;
}

export function writeGeneratedPostgresSchema(): string {
  const generated = generatePostgresSchema({
    sqliteSchema: fs.readFileSync(sourceSchemaPath, "utf8"),
    databaseModule: fs.readFileSync(databaseModulePath, "utf8"),
  });
  fs.writeFileSync(outputSchemaPath, generated, { mode: 0o600 });
  const matchingMigrations = fs.readdirSync(supabaseMigrationsDirectory)
    .filter((fileName) => fileName.endsWith(supabaseMigrationSuffix));
  if (matchingMigrations.length !== 1) {
    throw new Error(
      `Expected exactly one Supabase Postgres runtime migration, found ${matchingMigrations.length}. `
      + "Create it first with `supabase migration new create_pintpath_postgres_runtime`.",
    );
  }
  const migrationPath = path.join(supabaseMigrationsDirectory, matchingMigrations[0]!);
  fs.writeFileSync(migrationPath, generated, { mode: 0o600 });
  return outputSchemaPath;
}

function generatedPostgresSchemaArtifacts(): { generated: string; migrationPath: string } {
  const generated = generatePostgresSchema({
    sqliteSchema: fs.readFileSync(sourceSchemaPath, "utf8"),
    databaseModule: fs.readFileSync(databaseModulePath, "utf8"),
  });
  const matchingMigrations = fs.readdirSync(supabaseMigrationsDirectory)
    .filter((fileName) => fileName.endsWith(supabaseMigrationSuffix));
  if (matchingMigrations.length !== 1) {
    throw new Error(
      `Expected exactly one Supabase Postgres runtime migration, found ${matchingMigrations.length}.`,
    );
  }
  return {
    generated,
    migrationPath: path.join(supabaseMigrationsDirectory, matchingMigrations[0]!),
  };
}

export function checkGeneratedPostgresSchema(): boolean {
  const { generated, migrationPath } = generatedPostgresSchemaArtifacts();
  if (
    fs.readFileSync(outputSchemaPath, "utf8") !== generated
    || fs.readFileSync(migrationPath, "utf8") !== generated
  ) {
    throw new Error(
      "Generated Postgres schema artifacts are stale; run npm run db:postgres:schema:generate and review the diff.",
    );
  }
  return true;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 1 && arguments_[0] === "--check") {
    checkGeneratedPostgresSchema();
    console.log("Generated Postgres schema artifacts are current.");
  } else if (arguments_.length === 0) {
    const generatedPath = writeGeneratedPostgresSchema();
    console.log(`Generated ${path.relative(process.cwd(), generatedPath)}.`);
  } else {
    throw new Error("Only --check is supported.");
  }
}
