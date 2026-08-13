import { describe, expect, it, vi } from "vitest";

import {
  fetchPostgresToolRuntimeClosureV4RegistryResponse,
  validatePostgresToolRuntimeClosureV4BlobRedirect,
} from "../src/lib/postgres-tool-runtime-closure-v4-registry.js";

const NOW = 1_700_000_000;
const DIGEST_HEX = "7d612f69c8b54228ef0a3ff3af3bb9df2f4348836ec03cebafe063e0cdca80ab";
const DIGEST = `sha256:${DIGEST_HEX}`;
const TOKEN = "t".repeat(100);
const SIGNATURE = "S".repeat(128);
const SOURCE = `https://registry-1.docker.io/v2/library/postgres/blobs/${DIGEST}`;
const TARGET_PATH = `/registry-v2/docker/registry/v2/blobs/sha256/7d/${DIGEST_HEX}/data`;
const TARGET = `https://production.cloudfront.docker.com${TARGET_PATH}`
  + `?Expires=${NOW + 3_000}&Signature=${SIGNATURE}&Key-Pair-Id=APKAIEXAMPLE12`;

function response(
  status: number,
  url: string,
  headers: Record<string, string> = {},
): Response {
  return {
    headers: new Headers(headers),
    ok: status >= 200 && status < 300,
    status,
    url,
  } as Response;
}

function mockedFetch(responses: Response[]): {
  readonly fetchImpl: typeof fetch;
  readonly mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
  return { fetchImpl: mock as unknown as typeof fetch, mock };
}

describe("PostgreSQL V4 Docker registry blob redirect", () => {
  it("accepts only the exact digest-bound production CloudFront URL", () => {
    expect(validatePostgresToolRuntimeClosureV4BlobRedirect({
      digest: DIGEST,
      location: TARGET,
      nowEpochSeconds: NOW,
    })).toBe(TARGET);
  });

  it.each([
    ["relative", TARGET.replace("https://production.cloudfront.docker.com", "")],
    ["plaintext", TARGET.replace("https:", "http:")],
    ["wrong host", TARGET.replace("production.cloudfront.docker.com", "example.com")],
    ["host suffix", TARGET.replace("production.cloudfront.docker.com", "production.cloudfront.docker.com.evil")],
    ["explicit port", TARGET.replace(".com/", ".com:443/")],
    ["userinfo", TARGET.replace("https://", "https://user@")],
    ["fragment", `${TARGET}#fragment`],
    ["wrong shard", TARGET.replace("/sha256/7d/", "/sha256/00/")],
    ["wrong digest", TARGET.replace(DIGEST_HEX, `0${DIGEST_HEX.slice(1)}`)],
    ["encoded path", TARGET.replace("/data?", "/%64ata?")],
    ["missing query", TARGET.replace(/&Key-Pair-Id=.*/, "")],
    ["extra query", `${TARGET}&Unexpected=value`],
    ["duplicate query", `${TARGET}&Expires=${NOW + 3_000}`],
    ["encoded query name", TARGET.replace("Expires=", "%45xpires=")],
    ["expired", TARGET.replace(String(NOW + 3_000), String(NOW))],
    ["too far in future", TARGET.replace(String(NOW + 3_000), String(NOW + 3_601))],
    ["unsafe key", TARGET.replace("APKAIEXAMPLE12", "APKAI!EXAMPLE")],
    ["short signature", TARGET.replace(SIGNATURE, "short")],
    ["leading whitespace", ` ${TARGET}`],
    ["oversized", TARGET.replace(SIGNATURE, "S".repeat(4_097))],
  ])("rejects %s", (_name, location) => {
    expect(() => validatePostgresToolRuntimeClosureV4BlobRedirect({
      digest: DIGEST,
      location,
      nowEpochSeconds: NOW,
    })).toThrow("runtime_observation_registry_fetch_failed");
  });

  it("performs one credentialed registry request and one credential-free CDN request", async () => {
    const { fetchImpl, mock } = mockedFetch([
      response(307, SOURCE, { location: TARGET }),
      response(200, TARGET),
    ]);
    const result = await fetchPostgresToolRuntimeClosureV4RegistryResponse({
      token: TOKEN,
      kind: "blobs",
      digest: DIGEST,
      accept: "application/octet-stream",
      fetchImpl,
      nowEpochSeconds: NOW,
      timeoutMs: 1_000,
    });
    expect(result.url).toBe(TARGET);
    expect(mock).toHaveBeenCalledTimes(2);

    const [registryUrl, registryInit] = mock.mock.calls[0]!;
    expect(registryUrl).toBe(SOURCE);
    expect(registryInit).toMatchObject({ redirect: "manual" });
    expect(new Headers(registryInit.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);

    const [cdnUrl, cdnInit] = mock.mock.calls[1]!;
    expect(cdnUrl).toBe(TARGET);
    expect(cdnInit).toMatchObject({
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    const cdnHeaders = new Headers(cdnInit.headers);
    expect(cdnHeaders.get("authorization")).toBeNull();
    expect(cdnHeaders.get("cookie")).toBeNull();
    expect(cdnHeaders.get("accept")).toBe("application/octet-stream");
    expect(cdnHeaders.get("accept-encoding")).toBe("identity");
  });

  it("accepts a direct blob response without a second request", async () => {
    const { fetchImpl, mock } = mockedFetch([response(200, SOURCE)]);
    await expect(fetchPostgresToolRuntimeClosureV4RegistryResponse({
      token: TOKEN,
      kind: "blobs",
      digest: DIGEST,
      accept: "application/octet-stream",
      fetchImpl,
      nowEpochSeconds: NOW,
    })).resolves.toMatchObject({ status: 200, url: SOURCE });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 303, 308])("rejects blob HTTP %s rather than following it", async (status) => {
    const { fetchImpl, mock } = mockedFetch([
      response(status, SOURCE, { location: TARGET }),
    ]);
    await expect(fetchPostgresToolRuntimeClosureV4RegistryResponse({
      token: TOKEN,
      kind: "blobs",
      digest: DIGEST,
      accept: "application/octet-stream",
      fetchImpl,
      nowEpochSeconds: NOW,
    })).rejects.toThrow("runtime_observation_registry_fetch_failed");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("keeps manifests direct-only", async () => {
    const manifestSource = SOURCE.replace("/blobs/", "/manifests/");
    const { fetchImpl, mock } = mockedFetch([
      response(307, manifestSource, { location: TARGET }),
    ]);
    await expect(fetchPostgresToolRuntimeClosureV4RegistryResponse({
      token: TOKEN,
      kind: "manifests",
      digest: DIGEST,
      accept: "application/vnd.oci.image.manifest.v1+json",
      fetchImpl,
      nowEpochSeconds: NOW,
    })).rejects.toThrow("runtime_observation_registry_fetch_failed");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });

  it("rejects a second redirect and never makes a third request", async () => {
    const { fetchImpl, mock } = mockedFetch([
      response(307, SOURCE, { location: TARGET }),
      response(307, TARGET, { location: TARGET }),
    ]);
    await expect(fetchPostgresToolRuntimeClosureV4RegistryResponse({
      token: TOKEN,
      kind: "blobs",
      digest: DIGEST,
      accept: "application/octet-stream",
      fetchImpl,
      nowEpochSeconds: NOW,
    })).rejects.toThrow("runtime_observation_registry_fetch_failed");
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
