import "dotenv/config";

import { CallRunsRepository } from "../src/db/call-runs.repository.js";
import { createDatabase } from "../src/db/database.js";
import { recoverStaleCallRuns } from "../src/modules/calls/stale-call-recovery.js";

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

async function main() {
  const activeMinutes = Number.parseInt(getArg("active-minutes", "20") ?? "20", 10);
  const completedMinutes = Number.parseInt(getArg("completed-minutes", "15") ?? "15", 10);
  const terminalMinutes = Number.parseInt(getArg("terminal-minutes", "5") ?? "5", 10);
  const limit = Number.parseInt(getArg("limit", "5000") ?? "5000", 10);
  const dryRun = hasFlag("dry-run");

  const db = createDatabase();
  const repository = new CallRunsRepository(db);
  const nowIso = new Date().toISOString();

  try {
    const recoveries = recoverStaleCallRuns(repository, {
      activeMinutes,
      completedMinutes,
      terminalMinutes,
      nowIso,
      limit,
      dryRun,
    });

    console.log(`Identified ${recoveries.length} stale call runs for recovery.`);

    for (const { run, plan } of recoveries) {
      console.log(
        JSON.stringify({
          callSid: run.callSid,
          venueName: run.venueName,
          previousCallStatus: run.callStatus,
          nextCallStatus: plan.nextCallStatus,
          parseStatus: plan.parseStatus,
          errorMessage: plan.errorMessage,
          dryRun,
        }),
      );
    }

    console.log(
      dryRun
        ? `Dry run complete. ${recoveries.length} stale calls would be recovered.`
        : `Recovery complete. ${recoveries.length} stale calls were updated.`,
    );
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
