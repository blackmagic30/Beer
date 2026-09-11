import { fileURLToPath } from "node:url";

import { materializeBarPilotProductionMigrationEvidence } from "./lib/bar-pilot-production-runtime-preflight.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 2) throw new Error("arguments");
    materializeBarPilotProductionMigrationEvidence({ env: process.env,
      candidateSha: process.env.CANDIDATE_SHA ?? "", now: new Date() });
    process.stdout.write("Production native migration evidence materialized and verified.\n");
  } catch {
    process.stderr.write("Production native migration evidence is missing, inconsistent, or unauthorised.\n");
    process.exitCode = 1;
  }
}
