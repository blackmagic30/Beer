import { checkRuntimeReadinessInWorker } from "../staging-private-auth-probe.js";

const transportDescriptor =
  process.env.STAGING_AUTH_PROBE_INTERNAL_RUNTIME_TRANSPORT ?? "";
delete process.env.STAGING_AUTH_PROBE_INTERNAL_RUNTIME_TRANSPORT;
const result = await checkRuntimeReadinessInWorker(transportDescriptor);
process.stdout.write(`${result}\n`);
