import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractExactAppSessionCookie } from "./lib/app-session-cookie.mjs";

const productionExchangeUrl =
  "https://pintpath.au/api/business/auth/supabase-session";
const maxHeaderBytes = 64 * 1_024;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW;
const O_NONBLOCK = fs.constants.O_NONBLOCK;

function fail() {
  throw new Error("Production app-session cookie extraction failed");
}

function exactAbsolutePath(filename) {
  return typeof filename === "string" &&
    filename.length > 0 &&
    !filename.includes("\0") &&
    path.isAbsolute(filename) &&
    path.resolve(filename) === filename;
}

function requiredOpenFlags() {
  if (
    !Number.isSafeInteger(O_NOFOLLOW) ||
    O_NOFOLLOW <= 0 ||
    !Number.isSafeInteger(O_NONBLOCK) ||
    O_NONBLOCK <= 0
  ) {
    return fail();
  }
}

function sameHeldIdentity(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid;
}

function readPrivateHeaderFile(filename) {
  if (!exactAbsolutePath(filename)) return fail();
  requiredOpenFlags();
  let descriptor = null;
  let bytes = null;
  try {
    descriptor = fs.openSync(
      filename,
      fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    const beforePath = fs.lstatSync(filename, { bigint: true });
    const uid = typeof process.getuid === "function"
      ? BigInt(process.getuid())
      : null;
    if (
      uid === null ||
      !before.isFile() ||
      !beforePath.isFile() ||
      beforePath.isSymbolicLink() ||
      before.uid !== uid ||
      beforePath.uid !== uid ||
      (before.mode & 0o777n) !== 0o600n ||
      (beforePath.mode & 0o777n) !== 0o600n ||
      before.nlink !== 1n ||
      beforePath.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(maxHeaderBytes) ||
      !sameHeldIdentity(before, beforePath) ||
      fs.realpathSync(filename) !== filename
    ) {
      return fail();
    }

    bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) return fail();
      offset += count;
    }

    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(filename, { bigint: true });
    if (
      !sameHeldIdentity(before, after) ||
      !sameHeldIdentity(before, afterPath) ||
      after.size !== before.size ||
      afterPath.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      afterPath.mtimeNs !== before.mtimeNs ||
      afterPath.ctimeNs !== before.ctimeNs ||
      fs.realpathSync(filename) !== filename
    ) {
      return fail();
    }

    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.includes("\0") || Buffer.byteLength(source, "utf8") !== bytes.length) {
      return fail();
    }
    return source;
  } catch {
    return fail();
  } finally {
    bytes?.fill(0);
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function writePrivateCookieValue(filename, token) {
  if (!exactAbsolutePath(filename)) return fail();
  requiredOpenFlags();
  let descriptor = null;
  const bytes = Buffer.from(`${token}\n`, "utf8");
  try {
    descriptor = fs.openSync(
      filename,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        O_NOFOLLOW |
        O_NONBLOCK,
      0o600,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    const beforePath = fs.lstatSync(filename, { bigint: true });
    const uid = typeof process.getuid === "function"
      ? BigInt(process.getuid())
      : null;
    if (
      uid === null ||
      !before.isFile() ||
      !beforePath.isFile() ||
      beforePath.isSymbolicLink() ||
      before.uid !== uid ||
      beforePath.uid !== uid ||
      (before.mode & 0o777n) !== 0o600n ||
      (beforePath.mode & 0o777n) !== 0o600n ||
      before.nlink !== 1n ||
      beforePath.nlink !== 1n ||
      before.size !== 0n ||
      beforePath.size !== 0n ||
      !sameHeldIdentity(before, beforePath) ||
      fs.realpathSync(filename) !== filename
    ) {
      return fail();
    }

    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) return fail();
      offset += count;
    }
    fs.fsyncSync(descriptor);

    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(filename, { bigint: true });
    if (
      !sameHeldIdentity(before, after) ||
      !sameHeldIdentity(before, afterPath) ||
      after.size !== BigInt(bytes.length) ||
      afterPath.size !== BigInt(bytes.length) ||
      fs.realpathSync(filename) !== filename
    ) {
      return fail();
    }
  } catch {
    return fail();
  } finally {
    bytes.fill(0);
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function extractProductionAppSessionCookie(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    !exactAbsolutePath(argv[0]) ||
    !exactAbsolutePath(argv[1])
  ) {
    return fail();
  }
  const headerText = readPrivateHeaderFile(argv[0]);
  const setCookieHeaders = headerText
    .split(/\r?\n/)
    .filter((line) => /^set-cookie:/i.test(line))
    .map((line) => line.slice(line.indexOf(":") + 1).trim());
  const { token } = extractExactAppSessionCookie(
    setCookieHeaders,
    productionExchangeUrl,
  );
  writePrivateCookieValue(argv[1], token);
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    extractProductionAppSessionCookie(process.argv.slice(2));
  } catch {
    console.error("Production app-session cookie extraction failed");
    process.exitCode = 1;
  }
}
