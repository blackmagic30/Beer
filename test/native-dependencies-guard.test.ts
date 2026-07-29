import { describe, expect, it } from "vitest";

import { isRebuildableBetterSqlite3Failure } from "../scripts/ensure-native-dependencies.mjs";

describe("native dependency guard", () => {
  it.each([
    [
      "Node ABI mismatch",
      "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version requires NODE_MODULE_VERSION 137.",
    ],
    ["missing binding", "Could not locate the bindings file. Tried: better_sqlite3.node"],
    ["Linux architecture mismatch", "better_sqlite3.node: wrong ELF class: ELFCLASS32"],
    [
      "macOS architecture mismatch",
      "mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64')",
    ],
    ["Windows architecture mismatch", "%1 is not a valid Win32 application."],
  ])("recognizes a rebuildable %s", (_label, diagnostic) => {
    expect(isRebuildableBetterSqlite3Failure(diagnostic)).toBe(true);
  });

  it.each([
    ["missing package", "Cannot find package 'better-sqlite3' imported from startup.mjs"],
    ["database error", "SqliteError: no such table: venues"],
    ["permission error", "Error: EACCES: permission denied, open '/data/pint-path.sqlite'"],
    ["generic process failure", "The probe exited unexpectedly."],
  ])("does not automatically repair an unrelated %s", (_label, diagnostic) => {
    expect(isRebuildableBetterSqlite3Failure(diagnostic)).toBe(false);
  });
});
