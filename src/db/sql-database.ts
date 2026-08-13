import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";

import type BetterSqlite3 from "better-sqlite3";
import {
  Pool,
  TypeOverrides,
  types as postgresTypes,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from "pg";

export const POSTGRES_APPLICATION_SCHEMA = "pintpath_app";
export const POSTGRES_OPERATIONS_SCHEMA = "pintpath_ops";

export interface SqlRunResult {
  changes: number;
}

export type SqlBindings = readonly unknown[] | Readonly<Record<string, unknown>>;

export interface SqlStatement {
  run(...bindings: unknown[]): Promise<SqlRunResult>;
  get<Row extends QueryResultRow = QueryResultRow>(...bindings: unknown[]): Promise<Row | undefined>;
  all<Row extends QueryResultRow = QueryResultRow>(...bindings: unknown[]): Promise<Row[]>;
}

export interface SqlPoolMetrics {
  dialect: "sqlite" | "postgres";
  totalConnections: number;
  idleConnections: number;
  waitingRequests: number;
  completedQueries: number;
  failedQueries: number;
  transactionFailures: number;
  lastQueryDurationMs: number | null;
}

export interface SqlDatabase {
  readonly dialect: "sqlite" | "postgres";
  prepare(sql: string): SqlStatement;
  exec(sql: string): Promise<void>;
  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result>;
  close(): Promise<void>;
  metrics(): SqlPoolMetrics;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<Result>(work: () => Result | Promise<Result>): Promise<Result> {
    let release: (() => void) | undefined;
    const predecessor = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await work();
    } finally {
      release?.();
    }
  }
}

function normalizeBindings(bindings: unknown[]): SqlBindings {
  if (
    bindings.length === 1 &&
    bindings[0] !== null &&
    typeof bindings[0] === "object" &&
    !Array.isArray(bindings[0]) &&
    !Buffer.isBuffer(bindings[0]) &&
    !(bindings[0] instanceof Date)
  ) {
    return bindings[0] as Readonly<Record<string, unknown>>;
  }
  return bindings;
}

export class AsyncSqliteDatabase implements SqlDatabase {
  readonly dialect = "sqlite" as const;
  private readonly mutex = new AsyncMutex();
  private readonly transactionContext = new AsyncLocalStorage<{ nextSavepoint: number }>();
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;
  private lastQueryDurationMs: number | null = null;
  private closed = false;

  constructor(private readonly database: BetterSqlite3.Database) {}

  private async execute<Result>(work: () => Result): Promise<Result> {
    if (this.closed) throw new Error("Database is closed.");
    const run = async () => {
      const startedAt = performance.now();
      try {
        const result = work();
        this.completedQueries += 1;
        return result;
      } catch (error) {
        this.failedQueries += 1;
        throw error;
      } finally {
        this.lastQueryDurationMs = performance.now() - startedAt;
      }
    };
    return this.transactionContext.getStore() ? run() : this.mutex.runExclusive(run);
  }

  prepare(sql: string): SqlStatement {
    const statement = this.database.prepare(sql);
    return {
      run: async (...bindings) => this.execute(() => {
        const result = statement.run(...bindings);
        return { changes: result.changes };
      }),
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) => this.execute(
        () => statement.get(...bindings) as Row | undefined,
      ),
      all: async <Row extends QueryResultRow>(...bindings: unknown[]) => this.execute(
        () => statement.all(...bindings) as Row[],
      ),
    };
  }

  async exec(sql: string): Promise<void> {
    await this.execute(() => this.database.exec(sql));
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      const activeTransaction = this.transactionContext.getStore();
      if (activeTransaction) {
        const savepoint = `pintpath_nested_${activeTransaction.nextSavepoint++}`;
        this.database.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = await work();
          this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          this.transactionFailures += 1;
          try {
            this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
          } catch {
            // Preserve the original nested transaction error.
          }
          throw error;
        }
      }
      return this.mutex.runExclusive(async () => {
        const context = { nextSavepoint: 1 };
        this.database.exec("BEGIN IMMEDIATE");
        try {
          const result = await this.transactionContext.run(context, work);
          this.database.exec("COMMIT");
          return result;
        } catch (error) {
          this.transactionFailures += 1;
          try {
            this.database.exec("ROLLBACK");
          } catch {
            // Preserve the original transaction error.
          }
          throw error;
        }
      });
    };
  }

  async close(): Promise<void> {
    await this.mutex.runExclusive(() => {
      if (this.closed) return;
      this.database.close();
      this.closed = true;
    });
  }

  metrics(): SqlPoolMetrics {
    return {
      dialect: this.dialect,
      totalConnections: this.closed ? 0 : 1,
      idleConnections: this.closed ? 0 : 1,
      waitingRequests: 0,
      completedQueries: this.completedQueries,
      failedQueries: this.failedQueries,
      transactionFailures: this.transactionFailures,
      lastQueryDurationMs: this.lastQueryDurationMs,
    };
  }
}

interface CompiledPostgresQuery {
  text: string;
  values: unknown[];
}

export type ExactPostgresNumber = number | string;

function canonicalDecimalText(value: string): string {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error("Postgres returned a non-finite or invalid numeric value.");

  const negative = match[1] === "-";
  const whole = match[2]!;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent)) {
    throw new Error("Postgres returned a numeric exponent outside the supported range.");
  }

  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length + exponent;
  let integerPart: string;
  let fractionalPart: string;
  if (decimalIndex <= 0) {
    integerPart = "0";
    fractionalPart = `${"0".repeat(-decimalIndex)}${digits}`;
  } else if (decimalIndex >= digits.length) {
    integerPart = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
    fractionalPart = "";
  } else {
    integerPart = digits.slice(0, decimalIndex);
    fractionalPart = digits.slice(decimalIndex);
  }

  integerPart = integerPart.replace(/^0+(?=\d)/, "");
  fractionalPart = fractionalPart.replace(/0+$/, "");
  const isZero = /^0+$/.test(integerPart) && !fractionalPart;
  return `${negative && !isZero ? "-" : ""}${integerPart}${fractionalPart ? `.${fractionalPart}` : ""}`;
}

function normalizePostgresInt8(value: string): ExactPostgresNumber {
  const canonical = canonicalDecimalText(value);
  if (canonical.includes(".")) throw new Error("Postgres returned a non-integer int8 value.");
  const unsigned = canonical.startsWith("-") ? canonical.slice(1) : canonical;
  if (unsigned.length > 16) return canonical;
  const exact = BigInt(canonical);
  if (exact < BigInt(Number.MIN_SAFE_INTEGER) || exact > BigInt(Number.MAX_SAFE_INTEGER)) {
    return canonical;
  }
  return Number(exact);
}

function normalizePostgresNumeric(value: string): ExactPostgresNumber {
  const canonical = canonicalDecimalText(value);
  if (!canonical.includes(".")) return normalizePostgresInt8(canonical);

  // Keep values that cannot make a stable decimal -> binary64 -> decimal
  // round trip as strings. Fifteen significant decimal digits is the
  // conservative precision boundary for IEEE-754 doubles.
  const significantDigits = canonical
    .replace(/^-/, "")
    .replace(".", "")
    .replace(/^0+/, "")
    .length;
  if (significantDigits > 15) return canonical;
  const numeric = Number(canonical);
  if (!Number.isFinite(numeric) || canonicalDecimalText(numeric.toString()) !== canonical) {
    return canonical;
  }
  return numeric;
}

function normalizePostgresJsonText(value: string): string {
  // Validation does not feed the parsed value back into serialization. That
  // matters because JSONB can contain integers beyond JavaScript's exact range.
  JSON.parse(value);
  let output = "";
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
    } else if (character === '"') {
      inString = true;
      output += character;
    } else if (!/\s/.test(character)) {
      output += character;
    }
  }
  return output;
}

function normalizePostgresTimestamp(value: string, assumeUtc: boolean): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value);
  if (!match || (!assumeUtc && !match[3])) {
    throw new Error("Postgres returned an unsupported timestamp value.");
  }
  let zone = match[3] ?? "Z";
  if (/^[+-]\d{2}$/.test(zone)) zone = `${zone}:00`;
  else if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const parsed = new Date(`${match[1]}T${match[2]}${zone}`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Postgres returned an invalid timestamp value.");
  }
  return parsed.toISOString();
}

function normalizePostgresLocalTime(value: string): string {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (
    !match
    || Number(match[1]) > 23
    || Number(match[2]) > 59
    || Number(match[3]) > 59
  ) {
    throw new Error("Postgres returned an invalid local time value.");
  }
  return value;
}

const defaultByteaParser = postgresTypes.getTypeParser(postgresTypes.builtins.BYTEA, "text");

function normalizePostgresBytea(value: string): Buffer {
  const parsed = defaultByteaParser(value);
  if (!Buffer.isBuffer(parsed)) throw new Error("Postgres returned an invalid bytea value.");
  return parsed;
}

function createPostgresTypeOverrides(): TypeOverrides {
  const resultTypes = new TypeOverrides();
  resultTypes.setTypeParser(postgresTypes.builtins.BOOL, (value) => {
    if (value === "t") return true;
    if (value === "f") return false;
    throw new Error("Postgres returned an invalid boolean value.");
  });
  resultTypes.setTypeParser(postgresTypes.builtins.BYTEA, normalizePostgresBytea);
  resultTypes.setTypeParser(postgresTypes.builtins.INT8, normalizePostgresInt8);
  resultTypes.setTypeParser(postgresTypes.builtins.JSON, normalizePostgresJsonText);
  resultTypes.setTypeParser(postgresTypes.builtins.JSONB, normalizePostgresJsonText);
  resultTypes.setTypeParser(postgresTypes.builtins.DATE, (value) => value);
  resultTypes.setTypeParser(postgresTypes.builtins.TIME, normalizePostgresLocalTime);
  resultTypes.setTypeParser(
    postgresTypes.builtins.TIMESTAMP,
    (value) => normalizePostgresTimestamp(value, true),
  );
  resultTypes.setTypeParser(
    postgresTypes.builtins.TIMESTAMPTZ,
    (value) => normalizePostgresTimestamp(value, false),
  );
  resultTypes.setTypeParser(postgresTypes.builtins.NUMERIC, normalizePostgresNumeric);
  return resultTypes;
}

function appendConflictDoNothing(sql: string): string {
  const trimmed = sql.trim().replace(/;$/, "");
  if (!/^insert\s+or\s+ignore\s+into\b/i.test(trimmed)) return sql;
  const insert = trimmed.replace(/^insert\s+or\s+ignore\s+into\b/i, "INSERT INTO");
  const returningIndex = insert.search(/\sRETURNING\s/i);
  if (returningIndex < 0) return `${insert} ON CONFLICT DO NOTHING`;
  return `${insert.slice(0, returningIndex)} ON CONFLICT DO NOTHING${insert.slice(returningIndex)}`;
}

function normalizePostgresCompatibilitySql(sql: string): string {
  return appendConflictDoNothing(sql)
    .replace(/\s+COLLATE\s+NOCASE\b/gi, "")
    .replace(/\bmin\s*\(\s*1\s*,/gi, "least(1,")
    .replace(/\bmin\s*\(\s*100\s*,/gi, "least(100,")
    .replace(/\bmax\s*\(\s*0\s*,/gi, "greatest(0,")
    .replace(/\bIS\s+NOT\s+(\$\d+)\b/gi, "IS DISTINCT FROM $1")
    .replace(/\bIS\s+(\$\d+)\b/gi, "IS NOT DISTINCT FROM $1");
}

function compilePostgresQuery(sql: string, bindings: SqlBindings): CompiledPostgresQuery {
  const positional = Array.isArray(bindings) ? bindings : null;
  const named = positional ? null : bindings as Readonly<Record<string, unknown>>;
  const values: unknown[] = [];
  const namedIndexes = new Map<string, number>();
  let positionalIndex = 0;
  let output = "";
  let index = 0;
  let state: "normal" | "single" | "double" | "line-comment" | "block-comment" = "normal";

  while (index < sql.length) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (state === "single") {
      output += character;
      if (character === "'" && next === "'") {
        output += next;
        index += 2;
        continue;
      }
      if (character === "'") state = "normal";
      index += 1;
      continue;
    }
    if (state === "double") {
      output += character;
      if (character === '"' && next === '"') {
        output += next;
        index += 2;
        continue;
      }
      if (character === '"') state = "normal";
      index += 1;
      continue;
    }
    if (state === "line-comment") {
      output += character;
      if (character === "\n") state = "normal";
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      output += character;
      if (character === "*" && next === "/") {
        output += next;
        index += 2;
        state = "normal";
        continue;
      }
      index += 1;
      continue;
    }

    if (character === "'") {
      state = "single";
      output += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      state = "double";
      output += character;
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      state = "line-comment";
      output += "--";
      index += 2;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      output += "/*";
      index += 2;
      continue;
    }
    if (character === "?") {
      if (!positional) throw new Error("Positional SQL placeholder used with named bindings.");
      if (positionalIndex >= positional.length) throw new Error("Missing positional SQL binding.");
      values.push(positional[positionalIndex]);
      positionalIndex += 1;
      output += `$${values.length}`;
      index += 1;
      continue;
    }
    if (character === "@" && /[A-Za-z_]/.test(next ?? "")) {
      if (!named) throw new Error("Named SQL placeholder used with positional bindings.");
      let end = index + 2;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end]!)) end += 1;
      const name = sql.slice(index + 1, end);
      if (!Object.hasOwn(named, name)) throw new Error(`Missing named SQL binding: ${name}`);
      let parameterIndex = namedIndexes.get(name);
      if (!parameterIndex) {
        values.push(named[name]);
        parameterIndex = values.length;
        namedIndexes.set(name, parameterIndex);
      }
      output += `$${parameterIndex}`;
      index = end;
      continue;
    }
    output += character;
    index += 1;
  }

  if (state !== "normal") throw new Error("SQL contains an unterminated quote or comment.");
  if (positional && positionalIndex !== positional.length) {
    throw new Error(`Received ${positional.length} SQL bindings but used ${positionalIndex}.`);
  }
  return { text: normalizePostgresCompatibilitySql(output), values };
}

export interface PostgresDatabaseOptions {
  connectionString: string;
  applicationName?: string | undefined;
  maxConnections?: number | undefined;
  idleTimeoutMs?: number | undefined;
  connectionTimeoutMs?: number | undefined;
  statementTimeoutMs?: number | undefined;
  idleInTransactionTimeoutMs?: number | undefined;
  sslRootCertificatePath?: string | undefined;
}

function assertTlsPostgresUrl(connectionString: string): URL {
  if (connectionString.length < 1 || connectionString.length > 4096 || /[\r\n\0]/.test(connectionString)) {
    throw new Error("DATABASE_URL must be a bounded single-line Postgres URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be a valid Postgres URL.");
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol.");
  }
  if (parsed.hash) throw new Error("DATABASE_URL must not contain a URL fragment.");
  const sslModes = parsed.searchParams.getAll("sslmode");
  if (sslModes.length !== 1 || !["require", "verify-ca", "verify-full"].includes(sslModes[0]!.toLowerCase())) {
    throw new Error("DATABASE_URL must contain exactly one sslmode=require, sslmode=verify-ca, or sslmode=verify-full parameter.");
  }
  return parsed;
}

function normalizePostgresClientUrl(
  connectionString: string,
  sslRootCertificatePath?: string,
): string {
  const parsed = assertTlsPostgresUrl(connectionString);
  const sslMode = parsed.searchParams.get("sslmode")!.toLowerCase();
  const libpqCompatibilityFlags = parsed.searchParams.getAll("uselibpqcompat");
  if (
    libpqCompatibilityFlags.length > 1
    || (libpqCompatibilityFlags.length === 1 && libpqCompatibilityFlags[0] !== "true")
  ) {
    throw new Error("DATABASE_URL must not contain a false or duplicate uselibpqcompat parameter.");
  }

  const configuredRootCertificates = parsed.searchParams.getAll("sslrootcert");
  if (
    configuredRootCertificates.length > 1
    || (configuredRootCertificates.length === 1 && !configuredRootCertificates[0]!.trim())
  ) {
    throw new Error("DATABASE_URL must contain at most one non-empty sslrootcert parameter.");
  }
  const configuredRootCertificate = configuredRootCertificates[0];
  if (
    sslRootCertificatePath
    && configuredRootCertificate
    && configuredRootCertificate !== sslRootCertificatePath
  ) {
    throw new Error("DATABASE_URL sslrootcert does not match the configured root certificate path.");
  }
  const effectiveRootCertificate = sslRootCertificatePath ?? configuredRootCertificate;
  if (sslMode === "verify-ca" && !effectiveRootCertificate) {
    throw new Error("DATABASE_URL sslmode=verify-ca requires an explicit root certificate path.");
  }
  if (effectiveRootCertificate) {
    // Preserve constructor-time failure for an unreadable trust root. The pg
    // client reads the same path from its normalized private URL.
    fs.readFileSync(effectiveRootCertificate, "utf8");
    parsed.searchParams.set("sslrootcert", effectiveRootCertificate);
  }

  // pg-connection-string 2.x otherwise aliases require and verify-ca to
  // verify-full. Only this Pool-facing copy is normalized; environment
  // identity pins continue to hash the exact configured DATABASE_URL bytes.
  parsed.searchParams.set("sslmode", sslMode);
  parsed.searchParams.set("uselibpqcompat", "true");
  return parsed.toString();
}

export class PostgresDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly transactionClient = new AsyncLocalStorage<{
    client: PoolClient;
    nextSavepoint: number;
  }>();
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;
  private lastQueryDurationMs: number | null = null;
  private closed = false;

  constructor(options: PostgresDatabaseOptions) {
    const clientUrl = normalizePostgresClientUrl(
      options.connectionString,
      options.sslRootCertificatePath,
    );
    const poolConfig: PoolConfig = {
      connectionString: clientUrl,
      application_name: options.applicationName ?? "pint-path",
      max: options.maxConnections ?? 8,
      idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
      options: [
        `-c search_path=${POSTGRES_APPLICATION_SCHEMA},pg_catalog`,
        `-c statement_timeout=${options.statementTimeoutMs ?? 30_000}`,
        `-c idle_in_transaction_session_timeout=${options.idleInTransactionTimeoutMs ?? 30_000}`,
        "-c lock_timeout=10000",
        "-c synchronous_commit=on",
      ].join(" "),
      types: createPostgresTypeOverrides(),
    };
    this.pool = new Pool(poolConfig);
    this.pool.on("error", () => {
      this.failedQueries += 1;
    });
  }

  private async query<Row extends QueryResultRow>(sql: string, bindings: SqlBindings) {
    if (this.closed) throw new Error("Database is closed.");
    const compiled = compilePostgresQuery(sql, bindings);
    const executor = this.transactionClient.getStore()?.client ?? this.pool;
    const startedAt = performance.now();
    try {
      const result = await executor.query<Row>(compiled.text, compiled.values);
      this.completedQueries += 1;
      return result;
    } catch (error) {
      this.failedQueries += 1;
      throw error;
    } finally {
      this.lastQueryDurationMs = performance.now() - startedAt;
    }
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async (...bindings) => {
        const result = await this.query(sql, normalizeBindings(bindings));
        return { changes: result.rowCount ?? 0 };
      },
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, normalizeBindings(bindings));
        return result.rows[0];
      },
      all: async <Row extends QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, normalizeBindings(bindings));
        return result.rows;
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql, []);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      const activeTransaction = this.transactionClient.getStore();
      if (activeTransaction) {
        const savepoint = `pintpath_nested_${activeTransaction.nextSavepoint++}`;
        await activeTransaction.client.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await work();
          await activeTransaction.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          this.transactionFailures += 1;
          try {
            await activeTransaction.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await activeTransaction.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          } catch {
            // Preserve the original nested transaction error.
          }
          throw error;
        }
      }
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await this.transactionClient.run({ client, nextSavepoint: 1 }, work);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        this.transactionFailures += 1;
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original transaction error.
        }
        throw error;
      } finally {
        client.release();
      }
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  metrics(): SqlPoolMetrics {
    return {
      dialect: this.dialect,
      totalConnections: this.pool.totalCount,
      idleConnections: this.pool.idleCount,
      waitingRequests: this.pool.waitingCount,
      completedQueries: this.completedQueries,
      failedQueries: this.failedQueries,
      transactionFailures: this.transactionFailures,
      lastQueryDurationMs: this.lastQueryDurationMs,
    };
  }
}

export function asAsyncSqliteDatabase(database: BetterSqlite3.Database): SqlDatabase {
  return new AsyncSqliteDatabase(database);
}

export function createPostgresDatabase(options: PostgresDatabaseOptions): SqlDatabase {
  return new PostgresDatabase(options);
}

export const sqlDatabaseInternals = {
  canonicalDecimalText,
  compilePostgresQuery,
  createPostgresTypeOverrides,
  normalizePostgresInt8,
  normalizePostgresJsonText,
  normalizePostgresLocalTime,
  normalizePostgresNumeric,
  normalizePostgresTimestamp,
  normalizePostgresCompatibilitySql,
  normalizePostgresClientUrl,
};
