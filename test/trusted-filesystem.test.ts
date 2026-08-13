import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "../scripts/lib/trusted-filesystem.js";

const temporaryRoots: string[] = [];

function privateDirectory(): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-trusted-fs-")),
  );
  fs.chmodSync(directory, 0o700);
  temporaryRoots.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("trusted filesystem custody", () => {
  it("reads a canonical private file through a no-follow held descriptor", () => {
    const directory = privateDirectory();
    const filename = path.join(directory, "secret");
    fs.writeFileSync(filename, "held-secret", { mode: 0o600 });
    const open = vi.spyOn(fs, "openSync");

    const value = readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 32,
      requireOwner: true,
      requirePrivate: true,
    });

    expect(value.toString("utf8")).toBe("held-secret");
    expect(open).toHaveBeenCalledWith(
      filename,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    value.fill(0);
  });

  it("rejects symlink and hard-link inputs", () => {
    const directory = privateDirectory();
    const original = path.join(directory, "original");
    const symlink = path.join(directory, "symlink");
    const hardlink = path.join(directory, "hardlink");
    fs.writeFileSync(original, "secret", { mode: 0o600 });
    fs.symlinkSync(original, symlink);
    fs.linkSync(original, hardlink);

    for (const filename of [symlink, hardlink]) {
      expect(() => readTrustedRegularFile(filename, {
        minBytes: 1,
        maxBytes: 32,
        requirePrivate: true,
      })).toThrow("trusted_file_invalid");
    }
  });

  it("rejects a pathname replacement after open instead of reading the replacement", () => {
    const directory = privateDirectory();
    const filename = path.join(directory, "authority.json");
    const displaced = path.join(directory, "authority.held");
    fs.writeFileSync(filename, "trusted", { mode: 0o600 });
    const originalFstat = fs.fstatSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "fstatSync").mockImplementation(((descriptor, options) => {
      const result = originalFstat(descriptor, options as never);
      if (!replaced) {
        replaced = true;
        fs.renameSync(filename, displaced);
        fs.writeFileSync(filename, "foreign", { mode: 0o600 });
      }
      return result;
    }) as typeof fs.fstatSync);

    expect(() => readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 32,
      requirePrivate: true,
    })).toThrow("trusted_file_invalid");
  });

  it("reserves and writes a mode-600 child under held directory custody", () => {
    const directory = privateDirectory();
    const filename = path.join(directory, "receipt.json");
    const open = vi.spyOn(fs, "openSync");

    writePrivateExclusiveFile(directory, "receipt.json", "{\"ok\":true}\n", {
      requireExactDirectoryMode: true,
      requireOwner: true,
    });

    expect(fs.readFileSync(filename, "utf8")).toBe("{\"ok\":true}\n");
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    expect(open).toHaveBeenCalledWith(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    expect(open).toHaveBeenCalledWith(
      filename,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
        | fs.constants.O_NOFOLLOW,
      0o600,
    );
  });

  it("writes no bytes when the directory pathname is replaced before child reservation", () => {
    const directory = privateDirectory();
    const displaced = `${directory}-held`;
    const source = "must-not-be-written";
    const originalOpen = fs.openSync.bind(fs);
    let opens = 0;
    vi.spyOn(fs, "openSync").mockImplementation(((filename, flags, mode) => {
      opens += 1;
      if (opens === 2) {
        fs.renameSync(directory, displaced);
        fs.mkdirSync(directory, { mode: 0o700 });
      }
      return originalOpen(filename, flags, mode);
    }) as typeof fs.openSync);

    expect(() => writePrivateExclusiveFile(directory, "receipt.json", source, {
      requireOwner: true,
    })).toThrow("private_output_invalid");
    const replacement = path.join(directory, "receipt.json");
    expect(fs.existsSync(replacement)).toBe(true);
    expect(fs.statSync(replacement).size).toBe(0);
    expect(fs.existsSync(path.join(displaced, "receipt.json"))).toBe(false);
    temporaryRoots.push(displaced);
  });
});
