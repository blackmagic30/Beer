import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function repositoryFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("staging private-auth Railway CA transport contract", () => {
  it("routes every live Postgres surface through the shared held transport", () => {
    const source = repositoryFile("scripts/staging-private-auth-probe.ts");
    const worker = repositoryFile(
      "scripts/lib/staging-private-auth-readiness-worker.ts",
    );

    for (const required of [
      "openPostgresRailwayStockLocalhostCaTransportFromPem",
      "openPostgresRailwayStockLocalhostCaTransport",
      "parsePostgresRailwayStockLocalhostCaUrl",
      "POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE",
      "STAGING_AUTH_PROBE_POSTGRES_ROOT_CA_PEM",
      "STAGING_AUTH_PROBE_POSTGRES_ROOT_CA_DER_SHA256",
      "postgresTransport.nodeConnection",
      "postgresTransport.libpqEnvironment",
      "postgresTransport.assertExact()",
      "postgresTransport.close()",
      'activeRole: "pintpath_runtime"',
      'PGREQUIREAUTH: "scram-sha-256"',
      'schemaVersion: "staging-private-auth-runtime-transport/v1"',
    ]) {
      expect(source).toContain(required);
    }
    expect(source).not.toContain("sslmode=require");
    expect(source).not.toContain("sslmode=verify-ca");
    expect(source).not.toContain("PGHOST: target.hostname");
    expect(source).not.toContain("STAGING_AUTH_PROBE_INTERNAL_RUNTIME_URL");
    expect(worker).toContain("STAGING_AUTH_PROBE_INTERNAL_RUNTIME_TRANSPORT");
    expect(worker).not.toContain("STAGING_AUTH_PROBE_INTERNAL_RUNTIME_URL");
  });

  it("keeps CI's loopback PG17 test synthetic and the live runbook authenticated", () => {
    const workflow = repositoryFile(".github/workflows/ci.yml");
    const integration = repositoryFile(
      "test/staging-private-auth-probe.integration.test.ts",
    );
    const runbook = repositoryFile(
      "docs/permanent-staging-private-auth-rotation.md",
    );

    expect(workflow).toContain(
      "Run staging private-auth probe Postgres 17 contract",
    );
    expect(workflow).toContain(
      'PINTPATH_STAGING_AUTH_PROBE_TEST_REQUIRED: "true"',
    );
    expect(workflow).toContain(
      'PATH="$GITHUB_WORKSPACE/scripts/ci:$PATH" npm run test:staging:auth:probe:pg17',
    );
    expect(workflow).toContain(
      "postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable",
    );
    expect(integration).toContain(
      'url.searchParams.get("sslmode") !== "disable"',
    );
    expect(integration).toContain('PGREQUIREAUTH: "scram-sha-256"');

    for (const required of [
      "?sslmode=verify-full",
      "STAGING_AUTH_PROBE_POSTGRES_ROOT_CA_PEM",
      "STAGING_AUTH_PROBE_POSTGRES_ROOT_CA_DER_SHA256",
      "${{Beer.PINTPATH_POSTGRES_ROOT_CA_PEM}}",
      "${{Beer.PINTPATH_POSTGRES_ROOT_CA_DER_SHA256}}",
      "6816c4a2-e392-4ee5-826f-2584cb599ec0",
      "PGHOST=localhost",
      "PGHOSTADDR",
      "PGSSLMODE=verify-full",
      "mode-`0700`/mode-`0600`",
      "owner-controlled external activation steps",
    ]) {
      expect(runbook).toContain(required);
    }
    expect(runbook).not.toContain("sslmode=require");
    expect(runbook).not.toContain("sslmode=verify-ca");
    expect(runbook).not.toContain("sslrootcert=");
  });
});
