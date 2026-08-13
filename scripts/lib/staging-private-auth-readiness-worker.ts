import { checkRuntimeReadinessInWorker } from "../staging-private-auth-probe.js";

const connectionUrl = process.env.STAGING_AUTH_PROBE_INTERNAL_RUNTIME_URL ?? "";
const result = await checkRuntimeReadinessInWorker(connectionUrl);
process.stdout.write(`${result}\n`);
