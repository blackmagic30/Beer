import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp, replicaIdSha256 } from "../src/app.js";

async function healthPayload(): Promise<Record<string, unknown>> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
    return await response.json() as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deployment replica evidence", () => {
  it("domain-separates and hashes a Railway replica ID without returning the raw value", () => {
    const rawReplicaId = "railway-replica-a-private-platform-id";
    const expected = crypto
      .createHash("sha256")
      .update("pintpath/replica-evidence/v1\0", "utf8")
      .update(rawReplicaId, "utf8")
      .digest("hex");

    expect(replicaIdSha256(rawReplicaId)).toBe(expected);
    expect(replicaIdSha256(`  ${rawReplicaId}  `)).toBe(expected);
    expect(replicaIdSha256("railway-replica-b-private-platform-id")).not.toBe(expected);
    expect(expected).not.toContain(rawReplicaId);
  });

  it("omits replica evidence outside a Railway replica", async () => {
    vi.stubEnv("RAILWAY_REPLICA_ID", "");

    const payload = await healthPayload();
    const deployment = (payload.data as Record<string, unknown>).deployment as Record<string, unknown>;

    expect(replicaIdSha256()).toBeUndefined();
    expect(deployment).not.toHaveProperty("replicaIdSha256");
  });

  it("exposes only the replica digest in health deployment metadata", async () => {
    const rawReplicaId = "railway-replica-a-private-platform-id";
    vi.stubEnv("RAILWAY_REPLICA_ID", rawReplicaId);

    const payload = await healthPayload();
    const deployment = (payload.data as Record<string, unknown>).deployment as Record<string, unknown>;

    expect(deployment.replicaIdSha256).toBe(replicaIdSha256(rawReplicaId));
    expect(JSON.stringify(payload)).not.toContain(rawReplicaId);
  });
});
