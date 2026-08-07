import type BetterSqlite3 from "better-sqlite3";

function tableExists(database: BetterSqlite3.Database, tableName: string): boolean {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(tableName));
}

/**
 * Removes short-lived deletion-notice destinations from a backup copy only.
 * Restored completed deletions are suppressed by the independent tombstone
 * ledger; interrupted pre-completion rows are marked purged so a retry can
 * safely prepare a fresh destination from the still-existing account.
 */
export function sanitizeAccountDeletionRecipientSecretsInBackup(
  database: BetterSqlite3.Database,
): number {
  if (
    !tableExists(database, "account_deletion_completion_outbox")
    || !tableExists(database, "account_deletion_notice_recipient_secrets")
  ) {
    return 0;
  }

  const count = Number((database.prepare(
    "SELECT count(*) AS count FROM account_deletion_notice_recipient_secrets",
  ).get() as { count?: number } | undefined)?.count ?? 0);
  if (count === 0) return 0;

  const columns = new Set((database.pragma(
    "table_info(account_deletion_completion_outbox)",
  ) as Array<{ name: string }>).map((column) => column.name));
  const checkpointReset = columns.has("secret_purge_checkpoint_pending")
    ? ", secret_purge_checkpoint_pending = 0"
    : "";

  database.pragma("secure_delete = ON");
  const journalMode = database.pragma("journal_mode = DELETE", { simple: true });
  if (String(journalMode).toLowerCase() !== "delete") {
    throw new Error("Could not isolate the backup SQLite journal before privacy sanitization.");
  }
  database.transaction(() => {
    database.prepare(
      `UPDATE account_deletion_completion_outbox
          SET status = CASE
                WHEN completed_at IS NULL THEN 'purged'
                WHEN status = 'delivered' THEN 'delivered'
                ELSE 'suppressed_restore'
              END,
              terminal_at = COALESCE(terminal_at, updated_at, created_at),
              next_attempt_at = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error = CASE
                WHEN completed_at IS NULL
                  THEN 'Recipient removed from backup; an interrupted deletion retry must prepare it again.'
                WHEN status = 'delivered' THEN last_error
                ELSE 'Completion notice suppressed in backup; restore reconciliation uses the deletion ledger.'
              END
              ${checkpointReset}
        WHERE request_id IN (
          SELECT request_id FROM account_deletion_notice_recipient_secrets
        )`,
    ).run();
    database.prepare("DELETE FROM account_deletion_notice_recipient_secrets").run();
  })();
  // secure_delete overwrites deleted cells; VACUUM rebuilds the artifact so
  // ciphertext cannot survive in free pages that are later uploaded.
  database.exec("VACUUM");
  return count;
}
