const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_KEY_PAIR_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const SAFE_SIGNATURE_PATTERN = /^[A-Za-z0-9_~=-]{128,1024}$/;
const MAX_REDIRECT_LOCATION_CHARACTERS = 4_096;
const MAX_REDIRECT_LIFETIME_SECONDS = 3_600;

export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REGISTRY =
  "https://registry-1.docker.io" as const;
export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REPOSITORY =
  "library/postgres" as const;
export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_BLOB_CDN_ORIGIN =
  "https://production.cloudfront.docker.com" as const;

export type PostgresToolRuntimeClosureV4RegistryKind = "manifests" | "blobs";

function fail(): never {
  throw new Error("runtime_observation_registry_fetch_failed");
}

function exactDigest(value: string): string {
  if (!SHA256_PATTERN.test(value)) fail();
  return value.slice("sha256:".length);
}

function exactRedirectQuery(
  target: URL,
  nowEpochSeconds: number,
): void {
  const components = target.search.startsWith("?")
    ? target.search.slice(1).split("&")
    : [];
  if (components.length !== 3) fail();

  const values = new Map<string, string>();
  for (const component of components) {
    const separator = component.indexOf("=");
    if (separator < 1) fail();
    const name = component.slice(0, separator);
    const value = component.slice(separator + 1);
    if (
      !["Expires", "Key-Pair-Id", "Signature"].includes(name)
      || values.has(name)
    ) fail();
    values.set(name, value);
  }

  const expiresSource = values.get("Expires") ?? "";
  const keyPairId = values.get("Key-Pair-Id") ?? "";
  const signature = values.get("Signature") ?? "";
  if (!/^\d{10}$/.test(expiresSource)) fail();
  const expires = Number(expiresSource);
  if (
    !Number.isSafeInteger(nowEpochSeconds)
    || nowEpochSeconds < 0
    || !Number.isSafeInteger(expires)
    || expires <= nowEpochSeconds
    || expires > nowEpochSeconds + MAX_REDIRECT_LIFETIME_SECONDS
    || !SAFE_KEY_PAIR_ID_PATTERN.test(keyPairId)
    || !SAFE_SIGNATURE_PATTERN.test(signature)
  ) fail();
}

/**
 * Validates Docker Hub's single digest-bound handoff to its production CDN.
 * The returned URL is safe to request without registry credentials.
 */
export function validatePostgresToolRuntimeClosureV4BlobRedirect(input: {
  readonly digest: string;
  readonly location: string;
  readonly nowEpochSeconds: number;
}): string {
  const digestHex = exactDigest(input.digest);
  const location = input.location;
  if (
    typeof location !== "string"
    || location.length < 1
    || location.length > MAX_REDIRECT_LOCATION_CHARACTERS
    || location.trim() !== location
    || /[\0\r\n]/.test(location)
  ) fail();

  let target: URL;
  try {
    target = new URL(location);
  } catch {
    fail();
  }
  if (
    target.href !== location
    || target.origin !== POSTGRES_TOOL_RUNTIME_CLOSURE_V4_BLOB_CDN_ORIGIN
    || target.protocol !== "https:"
    || target.hostname !== "production.cloudfront.docker.com"
    || target.port !== ""
    || target.username !== ""
    || target.password !== ""
    || target.hash !== ""
    || target.pathname
      !== `/registry-v2/docker/registry/v2/blobs/sha256/${digestHex.slice(0, 2)}/${digestHex}/data`
  ) fail();
  exactRedirectQuery(target, input.nowEpochSeconds);
  return target.href;
}

export async function fetchPostgresToolRuntimeClosureV4RegistryResponse(input: {
  readonly token: string;
  readonly kind: PostgresToolRuntimeClosureV4RegistryKind;
  readonly digest: string;
  readonly accept: string;
  readonly fetchImpl?: typeof fetch;
  readonly nowEpochSeconds?: number;
  readonly timeoutMs?: number;
}): Promise<Response> {
  exactDigest(input.digest);
  if (
    typeof input.token !== "string"
    || input.token.length < 100
    || input.token.length > 16_384
    || /[\0\r\n]/.test(input.token)
    || typeof input.accept !== "string"
    || input.accept.length < 1
    || input.accept.length > 256
    || /[\0\r\n]/.test(input.accept)
  ) fail();
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") fail();
  const timeoutMs = input.timeoutMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000) fail();
  const nowEpochSeconds = input.nowEpochSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds < 0) fail();

  const source = `${POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REGISTRY}/v2/`
    + `${POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REPOSITORY}/${input.kind}/${input.digest}`;
  const response = await fetchImpl(source, {
    headers: {
      accept: input.accept,
      authorization: `Bearer ${input.token}`,
      "accept-encoding": "identity",
    },
    redirect: input.kind === "blobs" ? "manual" : "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.url !== source) fail();
  if (response.status === 200 && response.ok) return response;
  if (input.kind !== "blobs" || response.status !== 307) fail();

  const location = response.headers.get("location");
  if (location === null) fail();
  const target = validatePostgresToolRuntimeClosureV4BlobRedirect({
    digest: input.digest,
    location,
    nowEpochSeconds,
  });
  const redirected = await fetchImpl(target, {
    credentials: "omit",
    headers: {
      accept: input.accept,
      "accept-encoding": "identity",
    },
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!redirected.ok || redirected.status !== 200 || redirected.url !== target) fail();
  return redirected;
}
