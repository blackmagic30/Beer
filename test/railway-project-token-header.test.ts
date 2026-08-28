import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAILWAY_PROJECT_TOKEN_CLIENTS = [
  "scripts/execute-protected-permanent-staging-scale.ts",
  "scripts/execute-protected-permanent-staging-variable-mutation.ts",
  "scripts/execute-protected-postgres-ha-pitr.ts",
  "scripts/execute-protected-production-route-mutation.ts",
  "scripts/execute-protected-staging-postgres-build-canary.ts",
  "scripts/observe-production-post-promotion-pitr.ts",
] as const;

const RAILWAY_WORKSPACE_TOKEN_CLIENTS = [
  "scripts/execute-protected-disposable-restore-teardown.ts",
  "scripts/execute-protected-production-recovery-railway-teardown.ts",
  "scripts/verify-disposable-restore-project-absent.ts",
] as const;

describe("Railway project-token authentication", () => {
  it.each(RAILWAY_PROJECT_TOKEN_CLIENTS)(
    "%s uses Railway's project-token header and never an OAuth bearer header",
    (filename) => {
      const source = fs.readFileSync(path.resolve(filename), "utf8");

      expect(source).toContain('"Project-Access-Token": token');
      expect(source).not.toMatch(
        /[Aa]uthorization:\s*`Bearer \$\{token\}`/,
      );
    },
  );

  it.each(RAILWAY_WORKSPACE_TOKEN_CLIENTS)(
    "%s preserves Railway's workspace-token bearer header",
    (filename) => {
      const source = fs.readFileSync(path.resolve(filename), "utf8");

      expect(source).toMatch(/[Aa]uthorization:\s*`Bearer \$\{token\}`/);
      expect(source).not.toContain('"Project-Access-Token": token');
    },
  );
});
