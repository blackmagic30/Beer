import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  appendEnvironment,
  EPHEMERAL_RUNNER_POLICY_FILE,
  expectedWorkRoot,
  parseMountInfo,
  VOLATILE_WORK_ROOT,
} from "../scripts/verify-production-backup-volatile-work-root.mjs";

const source = fs.readFileSync(
  path.resolve("scripts/verify-production-backup-volatile-work-root.mjs"),
  "utf8",
);

function withTemporaryDirectory(run: (directory: string) => void) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "pintpath-backup-work-root-test-"),
    ),
  );
  try {
    run(directory);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

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

  it("appends the environment export through a held, fsynced descriptor", () => {
    withTemporaryDirectory((directory) => {
      const githubEnv = path.join(directory, "github-env");
      fs.writeFileSync(githubEnv, "EXISTING=value\n", { mode: 0o644 });
      fs.chmodSync(githubEnv, 0o644);
      const fsync = vi.spyOn(fs, "fsyncSync");
      try {
        appendEnvironment(githubEnv, "PINTPATH_BACKUP_WORK_ROOT", "/run/private");
        expect(fsync).toHaveBeenCalledOnce();
      } finally {
        fsync.mockRestore();
      }
      expect(fs.readFileSync(githubEnv, "utf8")).toBe(
        "EXISTING=value\nPINTPATH_BACKUP_WORK_ROOT=/run/private\n",
      );
    });
  });

  it("rejects a pathname swap after opening instead of writing to a substituted file", () => {
    withTemporaryDirectory((directory) => {
      const githubEnv = path.join(directory, "github-env");
      const held = path.join(directory, "held-env");
      fs.writeFileSync(githubEnv, "ORIGINAL=value\n", { mode: 0o600 });
      fs.chmodSync(githubEnv, 0o600);
      const openSync = fs.openSync.bind(fs);
      const open = vi.spyOn(fs, "openSync").mockImplementationOnce((filename, flags) => {
        const descriptor = openSync(filename, flags);
        fs.renameSync(githubEnv, held);
        fs.writeFileSync(githubEnv, "SUBSTITUTE=value\n", { mode: 0o600 });
        fs.chmodSync(githubEnv, 0o600);
        return descriptor;
      });
      try {
        expect(() =>
          appendEnvironment(githubEnv, "PINTPATH_BACKUP_WORK_ROOT", "/run/private"),
        ).toThrow(/github_environment_file_invalid/);
      } finally {
        open.mockRestore();
      }
      expect(fs.readFileSync(held, "utf8")).toBe("ORIGINAL=value\n");
      expect(fs.readFileSync(githubEnv, "utf8")).toBe("SUBSTITUTE=value\n");
    });
  });

  it("fails closed when the pathname is replaced after the held-descriptor write", () => {
    withTemporaryDirectory((directory) => {
      const githubEnv = path.join(directory, "github-env");
      const held = path.join(directory, "held-env");
      fs.writeFileSync(githubEnv, "ORIGINAL=value\n", { mode: 0o600 });
      fs.chmodSync(githubEnv, 0o600);
      const fsyncSync = fs.fsyncSync.bind(fs);
      const fsync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce((descriptor) => {
        fsyncSync(descriptor);
        fs.renameSync(githubEnv, held);
        fs.writeFileSync(githubEnv, "SUBSTITUTE=value\n", { mode: 0o600 });
        fs.chmodSync(githubEnv, 0o600);
      });
      try {
        expect(() =>
          appendEnvironment(githubEnv, "PINTPATH_BACKUP_WORK_ROOT", "/run/private"),
        ).toThrow(/github_environment_file_invalid/);
      } finally {
        fsync.mockRestore();
      }
      expect(fs.readFileSync(held, "utf8")).toBe(
        "ORIGINAL=value\nPINTPATH_BACKUP_WORK_ROOT=/run/private\n",
      );
      expect(fs.readFileSync(githubEnv, "utf8")).toBe("SUBSTITUTE=value\n");
    });
  });

  it("rejects a hard-linked GitHub environment file before writing", () => {
    withTemporaryDirectory((directory) => {
      const original = path.join(directory, "original-env");
      const githubEnv = path.join(directory, "github-env");
      fs.writeFileSync(original, "ORIGINAL=value\n", { mode: 0o600 });
      fs.chmodSync(original, 0o600);
      fs.linkSync(original, githubEnv);
      expect(() =>
        appendEnvironment(githubEnv, "PINTPATH_BACKUP_WORK_ROOT", "/run/private"),
      ).toThrow(/github_environment_file_invalid/);
      expect(fs.readFileSync(original, "utf8")).toBe("ORIGINAL=value\n");
    });
  });

  it("rejects a symlinked GitHub environment file before writing", () => {
    withTemporaryDirectory((directory) => {
      const original = path.join(directory, "original-env");
      const githubEnv = path.join(directory, "github-env");
      fs.writeFileSync(original, "ORIGINAL=value\n", { mode: 0o600 });
      fs.chmodSync(original, 0o600);
      fs.symlinkSync(original, githubEnv);
      expect(() =>
        appendEnvironment(githubEnv, "PINTPATH_BACKUP_WORK_ROOT", "/run/private"),
      ).toThrow(/github_environment_file_invalid/);
      expect(fs.readFileSync(original, "utf8")).toBe("ORIGINAL=value\n");
    });
  });
});
