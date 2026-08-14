import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISPOSABLE_RESTORE_INVENTORY_QUERY,
  protectedDisposableRestoreTeardownInternals,
} from "./execute-protected-disposable-restore-teardown.js";

const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const TOKEN = /^[^\r\n\0]{16,4096}$/;

export async function runDisposableRestoreAbsenceVerification(
  argv: readonly string[] = process.argv.slice(2),
  token = process.env.PINTPATH_RAILWAY_RESTORE_METADATA_TOKEN ?? "",
  fetchImpl: typeof fetch = fetch,
  writeOutput: (source: string) => void = (source) =>
    process.stdout.write(source),
): Promise<0 | 1> {
  const args = protectedDisposableRestoreTeardownInternals.parseArgs(argv);
  if (!args || !TOKEN.test(token)) return 1;
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: DISPOSABLE_RESTORE_INVENTORY_QUERY,
        variables: { projectId: args.projectId },
      }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const source = await response.text();
    if (!response.ok || Buffer.byteLength(source) > 2 * 1024 * 1024) return 1;
    const value = JSON.parse(source) as unknown;
    const absent = protectedDisposableRestoreTeardownInternals.absent(value);
    writeOutput(
      `${JSON.stringify({
        schemaVersion: "pintpath-disposable-restore-absence-verification/v1",
        candidateSha: args.candidateSha,
        projectId: args.projectId,
        environmentId: args.environmentId,
        expectedInventorySha256: args.inventorySha256,
        absent,
      })}\n`,
    );
    return absent ? 0 : 1;
  } catch {
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runDisposableRestoreAbsenceVerification();
}
