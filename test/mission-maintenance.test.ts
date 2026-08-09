import { afterEach, describe, expect, it, vi } from "vitest";

import {
  scheduleMissionMaintenance,
  type MissionMaintenanceStatus,
} from "../src/lib/mission-maintenance.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mission maintenance scheduler", () => {
  it("runs at startup and periodically, reports status, and stops cleanly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T02:00:00.000Z"));
    const run = vi.fn(async () => ({ candidates: 12, generated: 7, refreshed: true }));
    const statuses: Array<MissionMaintenanceStatus<Awaited<ReturnType<typeof run>>>> = [];
    const scheduler = scheduleMissionMaintenance({
      run,
      intervalMinutes: 30,
      onStatus: (status) => statuses.push(status),
    });

    await scheduler.runNow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([
      expect.objectContaining({ state: "running", trigger: "startup" }),
      expect.objectContaining({
        state: "succeeded",
        trigger: "startup",
        result: { candidates: 12, generated: 7, refreshed: true },
      }),
    ]);

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toEqual(expect.objectContaining({ state: "succeeded", trigger: "interval" }));

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await scheduler.runNow();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not overlap runs and safely reports failures", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const firstRun = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn()
      .mockReturnValueOnce(firstRun)
      .mockRejectedValueOnce(new Error("maintenance exploded with sk-abcdefghijklmnopqrstuvwxyz"));
    const statuses: Array<MissionMaintenanceStatus<void>> = [];
    const scheduler = scheduleMissionMaintenance({
      run,
      intervalMinutes: 1,
      onStatus: (status) => statuses.push(status),
    });

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(run).toHaveBeenCalledTimes(1);

    release?.();
    await firstRun;
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.runNow();

    expect(run).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toEqual(expect.objectContaining({
      state: "failed",
      trigger: "manual",
      error: expect.not.stringContaining("sk-abcdefghijklmnopqrstuvwxyz"),
    }));
    scheduler.stop();
  });

  it("waits for an in-flight run before stop resolves", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const scheduler = scheduleMissionMaintenance({ run, intervalMinutes: 30 });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    let stopped = false;
    const stopPromise = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release?.();
    await stopPromise;
    expect(stopped).toBe(true);
  });

  it("waits for an asynchronous terminal status callback before stop resolves", async () => {
    let releaseStatus: (() => void) | undefined;
    let terminalStatusStarted = false;
    const scheduler = scheduleMissionMaintenance({
      run: vi.fn(async () => ({ refreshed: true })),
      intervalMinutes: 30,
      onStatus: (status) => {
        if (status.state !== "succeeded") return;
        terminalStatusStarted = true;
        return new Promise<void>((resolve) => { releaseStatus = resolve; });
      },
    });
    await vi.waitFor(() => expect(terminalStatusStarted).toBe(true));

    let stopped = false;
    const stopPromise = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseStatus?.();
    await expect(stopPromise).resolves.toBeUndefined();
    expect(stopped).toBe(true);
  });

  it("unrefs its interval and ignores status callback errors", async () => {
    const unref = vi.fn();
    const interval = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(interval);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    const scheduler = scheduleMissionMaintenance({
      run: vi.fn(() => ({ refreshed: true })),
      intervalMinutes: 30,
      onStatus: () => {
        throw new Error("status sink unavailable");
      },
    });

    await scheduler.runNow();
    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();

    scheduler.stop();
    expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
  });

  it("rejects invalid intervals before starting", () => {
    expect(() => scheduleMissionMaintenance({ run: vi.fn(), intervalMinutes: 0 }))
      .toThrow("greater than zero");
  });
});
