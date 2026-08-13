#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const expectedNode = "22.23.2";
const expectedNpm = "10.9.8";
const npmExecPath = process.env.npm_execpath;
let npmVersion;
if (npmExecPath) {
  try {
    npmVersion = JSON.parse(
      fs.readFileSync(path.resolve(path.dirname(npmExecPath), "..", "package.json"), "utf8"),
    ).version;
  } catch {
    // A nonstandard npm launcher is rejected below unless its user agent is exact.
  }
}
npmVersion ??= process.env.npm_config_user_agent?.match(/(?:^|\s)npm\/([^\s]+)/)?.[1];
const failures = [];

if (process.versions.node !== expectedNode) {
  failures.push(`Node ${expectedNode} is required; received ${process.versions.node}.`);
}
if (npmVersion !== expectedNpm) {
  failures.push(`npm ${expectedNpm} is required; received ${npmVersion ?? "an unknown version"}.`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`Toolchain verified (Node ${expectedNode}, npm ${expectedNpm}).`);
