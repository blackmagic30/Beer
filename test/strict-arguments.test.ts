import { describe, expect, it } from "vitest";

import { parseStrictArguments } from "../scripts/lib/strict-arguments.js";

describe("strict operator command arguments", () => {
  const allowed = new Set(["--backup", "--sha256"]);

  it("accepts inline, split, and one declared positional value", () => {
    expect(parseStrictArguments(["snapshot", "--sha256=abc"], {
      allowed,
      positionalName: "--backup",
      required: allowed,
    })).toEqual(new Map([
      ["--backup", "snapshot"],
      ["--sha256", "abc"],
    ]));
  });

  it("rejects unknown, duplicate, extra positional, and missing values", () => {
    expect(() => parseStrictArguments(["--unknown=value"], { allowed })).toThrow("Unsupported argument");
    expect(() => parseStrictArguments(["--backup=one", "--backup=two"], { allowed })).toThrow("more than once");
    expect(() => parseStrictArguments(["one", "two"], { allowed, positionalName: "--backup" })).toThrow(
      "Unsupported positional argument",
    );
    expect(() => parseStrictArguments(["--backup"], { allowed })).toThrow("missing its value");
  });
});
