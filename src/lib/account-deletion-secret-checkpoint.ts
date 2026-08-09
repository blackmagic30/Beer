import type BetterSqlite3 from "better-sqlite3";

import type { AccountDeletionSecretPurgeCheckpointEntry } from "../db/account-deletion-queue.repository.js";
import type { SqlDatabase } from "../db/sql-database.js";

export type AccountDeletionSecretPhysicalCheckpoint = (
  snapshot: readonly AccountDeletionSecretPurgeCheckpointEntry[],
) => Promise<boolean>;

/**
 * Performs the SQLite storage checkpoint between the repository's durable
 * generation capture and guarded acknowledgement. It deliberately owns no
 * database transaction and never receives recipient bytes.
 */
export function createSqliteAccountDeletionSecretPhysicalCheckpoint(
  database: Pick<BetterSqlite3.Database, "pragma">,
): AccountDeletionSecretPhysicalCheckpoint {
  return async () => {
    try {
      const rows = database.pragma("wal_checkpoint(TRUNCATE)") as Array<{
        busy?: number;
      }>;
      return Number(rows[0]?.busy ?? 1) === 0;
    } catch {
      return false;
    }
  };
}

const POSTGRES_CHECKPOINT_BATCH_SIZE = 500;
const MAX_POSTGRES_CHECKPOINT_ENTRIES = 100_000;

/**
 * Confirms that a committed PostgreSQL purge is durable in the live database.
 * The application pool forces synchronous_commit=on; each bounded query checks
 * that setting and proves the captured requests no longer have decryptable
 * recipient-secret rows before the repository acknowledges their generations.
 *
 * PostgreSQL MVCC/WAL and managed backup retention are provider lifecycle
 * concerns, so this deliberately does not claim immediate byte erasure from
 * historical backups. Those copies remain access-restricted and must expire
 * under the reviewed provider retention policy.
 */
export function createPostgresAccountDeletionSecretPhysicalCheckpoint(
  database: SqlDatabase,
): AccountDeletionSecretPhysicalCheckpoint {
  return async (snapshot) => {
    if (
      database.dialect !== "postgres" ||
      snapshot.length > MAX_POSTGRES_CHECKPOINT_ENTRIES
    ) {
      return false;
    }
    const requestIds: string[] = [];
    const seen = new Set<string>();
    for (const entry of snapshot) {
      if (
        typeof entry.requestId !== "string" ||
        !/^[a-z0-9][a-z0-9._:-]{0,254}$/i.test(entry.requestId) ||
        !Number.isSafeInteger(entry.generation) ||
        entry.generation < 0 ||
        seen.has(entry.requestId)
      ) {
        return false;
      }
      seen.add(entry.requestId);
      requestIds.push(entry.requestId);
    }
    try {
      for (
        let offset = 0;
        offset < requestIds.length;
        offset += POSTGRES_CHECKPOINT_BATCH_SIZE
      ) {
        const batch = requestIds.slice(
          offset,
          offset + POSTGRES_CHECKPOINT_BATCH_SIZE,
        );
        const placeholders = batch.map(() => "?").join(", ");
        const row = await database
          .prepare(
            `SELECT current_setting('synchronous_commit') AS "synchronousCommit",
                  EXISTS (
                    SELECT 1
                      FROM account_deletion_notice_recipient_secrets
                     WHERE request_id IN (${placeholders})
                  ) AS "hasRecipientSecret"`,
          )
          .get<{ synchronousCommit: string; hasRecipientSecret: boolean }>(
            ...batch,
          );
        if (row?.synchronousCommit !== "on" || row.hasRecipientSecret !== false)
          return false;
      }
      return true;
    } catch {
      return false;
    }
  };
}
