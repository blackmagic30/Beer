import { describe, expect, it, vi } from "vitest";
import { automaticMaintenanceWorkerFenceInternals as worker } from "../scripts/execute-protected-automatic-maintenance-worker-fence.js";
import { protectedPermanentStagingScaleInternals as scale } from "../scripts/execute-protected-permanent-staging-scale.js";
import { protectedProductionRouteMutationInternals as route } from "../scripts/execute-protected-production-route-mutation.js";
import { productionProviderSourceExact } from "../scripts/lib/production-source-archive-authority.js";
import { railwayDeploymentIdentityHashes } from "../src/lib/railway-deployment-identity.js";
import { productionArchiveFixture } from "./production-source-archive-downstream.fixtures.js";

const archive = productionArchiveFixture();
const scope = {
  RAILWAY_PROJECT_ID: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  RAILWAY_ENVIRONMENT_ID: "13dab015-df74-45c6-b26f-69323daea99a",
  RAILWAY_SERVICE_ID: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  RAILWAY_DEPLOYMENT_ID: "77b0d060-8438-47bd-97ed-068416afc81e",
  RAILWAY_REPLICA_ID: "archive-replacement-replica",
};
const target = { environmentId: scope.RAILWAY_ENVIRONMENT_ID, domain: "pintpath.au" };
const routes = ["/health", "/startup", "/ready"] as const;
type Route = typeof routes[number];
function runtime(path: Route, enabled: boolean) {
  return { ok: true, data: {
    service: "pint-path",
    status: path === "/health" ? "ok" : path === "/startup" ? "startup_ready" : "ready",
    deployment: { version: "0.1.0", commitSha: "unknown", environment: "production",
      ...railwayDeploymentIdentityHashes(scope), sourceArchive: { ...archive } },
    automaticMaintenance: { enabled, candidateBound: true },
    ...(path !== "/health" ? { dependencies: {
      database: { status: "ok" },
      ...(path === "/ready" ? { restoreRehearsal: {
        enabled: false, externalWritesAllowed: true, httpMutationRoutesAllowed: true,
        runtimeDatabase: "primary_runtime_database", remoteVenueDirectoryEnabled: true,
      } } : {}),
    } } : {}),
  } };
}
function responses(enabled: boolean, change?: (value: ReturnType<typeof runtime>) => void) {
  return vi.fn(async (url: string | URL | Request) => {
    const value = runtime(new URL(String(url)).pathname as Route, enabled);
    change?.(value);
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}
async function workerProbe(path: Route, enabled: boolean, expectedEnabled: boolean,
  change?: (value: ReturnType<typeof runtime>) => void, authority = true) {
  return worker.runtimeResponse({ fetchImpl: responses(enabled, change) } as Parameters<typeof worker.runtimeResponse>[0],
    "https://pintpath.au", path, archive.candidateSha, expectedEnabled, true,
    scope.RAILWAY_ENVIRONMENT_ID, scope.RAILWAY_DEPLOYMENT_ID, authority ? archive : undefined);
}

describe("production archive runtime consumers", () => {
  it.each(routes)("keeps worker state authoritative at %s before and after activation", async (path) => {
    expect(await workerProbe(path, false, false)).toMatch(/^[a-f0-9]{64}$/);
    expect(await workerProbe(path, true, true)).toMatch(/^[a-f0-9]{64}$/);
    expect(await workerProbe(path, false, true)).toBeNull();
    expect(await workerProbe(path, true, false)).toBeNull();
    expect(await workerProbe(path, true, true, undefined, false)).toBeNull();
  });

  it("requires all three enabled, receipt-bound routes before scale; a disabled worker cannot pass", async () => {
    const fetchImpl = responses(true);
    expect(await scale.probeRuntime(fetchImpl, target, archive.candidateSha,
      scope.RAILWAY_DEPLOYMENT_ID, { enabled: true, candidateBound: true, sourceArchive: archive })).toBe(true);
    expect(vi.mocked(fetchImpl).mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(routes);
    expect(await scale.probeRuntime(responses(false), target, archive.candidateSha,
      scope.RAILWAY_DEPLOYMENT_ID, { enabled: true, candidateBound: true, sourceArchive: archive })).toBe(false);
    expect(await scale.probeRuntime(responses(true), target, archive.candidateSha,
      scope.RAILWAY_DEPLOYMENT_ID, { enabled: true, candidateBound: true })).toBe(false);
  });

  it.each(routes)("route-open requires current enabled deployment identity at %s", (path) => {
    expect(route.runtimeIdentityExact(path, JSON.stringify(runtime(path, true)), archive.candidateSha,
      scope.RAILWAY_DEPLOYMENT_ID, archive)).toBe(true);
    expect(route.runtimeIdentityExact(path, JSON.stringify(runtime(path, false)), archive.candidateSha,
      scope.RAILWAY_DEPLOYMENT_ID, archive)).toBe(false);
    expect(route.runtimeIdentityExact(path, JSON.stringify(runtime(path, true)), archive.candidateSha,
      "88b0d060-8438-47bd-97ed-068416afc81e", archive)).toBe(false);
    expect(route.runtimeIdentityExact(path, JSON.stringify(runtime(path, true)), archive.candidateSha,
      scope.RAILWAY_DEPLOYMENT_ID)).toBe(false);
  });

  it.each([
    ["conflicting genuine Git", (value: ReturnType<typeof runtime>) => { value.data.deployment.commitSha = "f".repeat(40); }],
    ["different archive", (value: ReturnType<typeof runtime>) => { value.data.deployment.sourceArchive.sourceIdentitySha256 = "f".repeat(64); }],
    ["wrong environment", (value: ReturnType<typeof runtime>) => { value.data.deployment.environmentIdSha256 = "f".repeat(64); }],
    ["unbound worker", (value: ReturnType<typeof runtime>) => { value.data.automaticMaintenance.candidateBound = false; }],
    ["staging manifest", (value: ReturnType<typeof runtime>) => { Object.assign(value.data.deployment.sourceArchive, { schemaVersion: "protected-source-archive/v1" }); }],
  ] as const)("all consumers reject %s", async (_name, change) => {
    expect(await workerProbe("/health", true, true, change)).toBeNull();
    expect(await scale.probeRuntime(responses(true, change), target, archive.candidateSha,
      scope.RAILWAY_DEPLOYMENT_ID, { enabled: true, candidateBound: true, sourceArchive: archive })).toBe(false);
    const value = runtime("/health", true);
    change(value);
    expect(route.runtimeIdentityExact("/health", JSON.stringify(value), archive.candidateSha,
      scope.RAILWAY_DEPLOYMENT_ID, archive)).toBe(false);
  });

  it("never converts absent provider Git metadata into a claimed Git SHA", () => {
    expect(productionProviderSourceExact(null, archive.candidateSha, archive)).toBe(true);
    expect(productionProviderSourceExact(null, archive.candidateSha)).toBe(false);
    expect(productionProviderSourceExact(archive.candidateSha, archive.candidateSha)).toBe(true);
    expect(productionProviderSourceExact("f".repeat(40), archive.candidateSha, archive)).toBe(false);
  });
});
