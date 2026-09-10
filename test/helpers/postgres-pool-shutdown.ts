import type { Client, Pool } from "pg";

/** pg-pool can resolve end() before its idle clients finish closing their sockets. */
export function trackPostgresPoolShutdown(pool: Pool): () => Promise<void> {
  const clientClosures: Promise<void>[] = [];
  pool.on("connect", (client) => {
    clientClosures.push(new Promise<void>((resolve) => client.once("end", resolve)));
  });
  return async () => {
    await pool.end();
    await Promise.all(clientClosures);
  };
}

export async function assertPostgresFixtureDisconnected(admin: Client, databaseName: string): Promise<void> {
  const result = await admin.query<{ connections: number }>(
    "SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname = $1",
    [databaseName],
  );
  if (result.rows[0]?.connections !== 0) {
    throw new Error("Fixture connections must finish closing before database removal.");
  }
}
