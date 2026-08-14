import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  EPHEMERAL_RUNNER_POLICY_FILE,
  expectedWorkRoot,
  parseMountInfo,
  VOLATILE_WORK_ROOT,
} from "../scripts/verify-production-backup-volatile-work-root.mjs";

const source = fs.readFileSync(
  path.resolve("scripts/verify-production-backup-volatile-work-root.mjs"),
  "utf8",
);

describe("production backup volatile work-root authority", () => {
  it("derives only bounded backup and restore paths from numeric run identity", () => {
    expect(expectedWorkRoot("backup", "123", "2")).toBe(
      "/run/pintpath-production-backup/pintpath-production-backup-123-2",
    );
    expect(expectedWorkRoot("restore", "123", "2")).toBe(
      "/run/pintpath-production-backup/pintpath-production-restore-123-2",
    );
    expect(expectedWorkRoot("recovery", "123", "2")).toBe(
      "/run/pintpath-production-backup/pintpath-production-recovery-123-2",
    );
    expect(() => expectedWorkRoot("other", "123", "2")).toThrow(
      /operation_invalid/,
    );
    expect(() => expectedWorkRoot("backup", "../123", "2")).toThrow(
      /run_identity_invalid/,
    );
  });

  it("parses escaped Linux mount paths and combines mount/superblock options", () => {
    const [mount] = parseMountInfo(
      "42 31 0:51 / /run/pintpath\\040production rw,nosuid,nodev - tmpfs tmpfs rw,noexec\n",
    );
    expect(mount).toMatchObject({
      root: "/",
      mountPoint: "/run/pintpath production",
      filesystemType: "tmpfs",
      source: "tmpfs",
    });
    expect([...mount.options].sort()).toEqual(
      ["nodev", "noexec", "nosuid", "rw"].sort(),
    );
  });

  it("pins a root-owned runner policy and performs descriptor/device-bounded cleanup", () => {
    expect(VOLATILE_WORK_ROOT).toBe("/run/pintpath-production-backup");
    expect(EPHEMERAL_RUNNER_POLICY_FILE).toBe(
      "/etc/pintpath/production-backup-ephemeral-runner.json",
    );
    for (const required of [
      "O_NOFOLLOW",
      'runnerMode: "jit-ephemeral-one-job"',
      'filesystemType: "tmpfs"',
      'requiredMountOptions: [...REQUIRED_MOUNT_OPTIONS]',
      'fs.readFileSync("/proc/swaps"',
      "stat.dev !== expectedDevice",
      "fs.realpathSync(target) !== target",
      "fs.readdirSync(VOLATILE_WORK_ROOT).length !== 0",
      "exported_work_root_mismatch",
    ]) {
      expect(source).toContain(required);
    }
    expect(source).not.toContain("rmSync");
    expect(source).not.toContain("RUNNER_TEMP");
  });
});
