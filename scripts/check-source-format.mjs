#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const sourceExtension = /\.(?:cjs|css|html|js|json|mjs|sql|ts|tsx|ya?ml)$/i;
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => file && sourceExtension.test(file));
const decoder = new TextDecoder("utf-8", { fatal: true });
const failures = [];

for (const file of files) {
  let content;
  try {
    content = decoder.decode(fs.readFileSync(file));
  } catch {
    failures.push(`${file}: is not valid UTF-8 text`);
    continue;
  }
  if (content.startsWith("\uFEFF")) failures.push(`${file}: contains a UTF-8 BOM`);
  if (content.includes("\r")) failures.push(`${file}: contains CR/CRLF line endings`);
  if (/(?:[ \t]+)$/m.test(content)) failures.push(`${file}: contains trailing whitespace`);
  if (content.length > 0 && !content.endsWith("\n")) failures.push(`${file}: has no final newline`);
}

if (failures.length > 0) {
  console.error("Source-format check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Source-format check passed (${files.length} tracked text files).`);
