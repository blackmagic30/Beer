import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { trackPostgresPoolShutdown } from "./helpers/postgres-pool-shutdown.js";

describe("PostgreSQL fixture pool shutdown", () => {
  it("waits for every connected client even after pool.end has resolved", async () => {
    const pool = new Pool();
    const close = trackPostgresPoolShutdown(pool);
    const first = new EventEmitter();
    const second = new EventEmitter();
    pool.emit("connect", first);
    pool.emit("connect", second);
    second.emit("end");
    let closed = false;
    const closing = close().then(() => { closed = true; });
    await setImmediate();
    expect(pool.ended).toBe(true);
    expect(closed).toBe(false);
    first.emit("end");
    await closing;
    expect(closed).toBe(true);
  });

  it("propagates pool shutdown failures instead of treating them as cleanup success", async () => {
    const pool = new Pool();
    const failure = new Error("fixture shutdown failed");
    const end = vi.spyOn(pool, "end").mockRejectedValueOnce(failure);
    await expect(trackPostgresPoolShutdown(pool)()).rejects.toBe(failure);
    end.mockRestore();
    await pool.end();
  });
});
