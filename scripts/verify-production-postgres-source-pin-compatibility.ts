import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRODUCTION_POSTGRES_SOURCE_PIN_STATE,
  protectedProductionPostgresSourcePinInternals,
} from "./execute-protected-production-postgres-source-pin.js";

export async function runProductionPostgresSourcePinCompatibilityCheck(
  overrides: {
    readonly cwd?: string;
    readonly writeOutput?: (source: string) => void;
  } = {},
): Promise<0 | 1> {
  const cwd = overrides.cwd ?? process.cwd();
  const writeOutput = overrides.writeOutput ??
    ((source: string) => process.stdout.write(source));
  const policy = protectedProductionPostgresSourcePinInternals.readPolicy(cwd);
  const compatibilityExact = policy !== null &&
    protectedProductionPostgresSourcePinInternals.defaultCompatibility(
      cwd,
      policy,
    );
  const databaseIdentityInspectorActivated = policy !== null &&
    policy.databaseIdentityAuthority.state ===
      "ACTIVE_PINNED_READ_ONLY_PRE_POST_INSPECTOR" &&
    policy.databaseIdentityAuthority.productionMutationAllowed === true;
  const durabilityAuthorityActivated = policy !== null &&
    policy.durabilityAuthority.state === "ACTIVE_PINNED_DURABILITY" &&
    policy.durabilityAuthority.productionMutationAllowed === true;
  const ok = compatibilityExact && databaseIdentityInspectorActivated &&
    durabilityAuthorityActivated;
  writeOutput(`${JSON.stringify({
    command: "verify-production-postgres-source-pin-compatibility",
    ok,
    executorState: PRODUCTION_POSTGRES_SOURCE_PIN_STATE,
    policyExact: policy !== null,
    compatibilityAuthorityExact: compatibilityExact,
    databaseIdentityInspectorActivated,
    durabilityAuthorityActivated,
    providerCredentialsRead: false,
    providerMutationAttempted: false,
  })}\n`);
  return ok ? 0 : 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runProductionPostgresSourcePinCompatibilityCheck();
}
