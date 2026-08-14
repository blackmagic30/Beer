#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const requiredFiles = [
  "dist/src/server.js",
  "dist/src/db/schema.sql",
  "dist/src/db/postgres-schema.sql",
  "dist/viewer/index.html",
  "dist/viewer/404.html",
  "dist/viewer/account.html",
  "dist/viewer/admin.html",
  "dist/viewer/auth/callback.html",
  "dist/viewer/business.css",
  "dist/viewer/business.js",
  "dist/viewer/site.webmanifest",
  "dist/viewer/venue-portal.html",
];

const missing = requiredFiles.filter((file) => {
  const absolute = path.resolve(process.cwd(), file);
  return !fs.existsSync(absolute) || fs.statSync(absolute).size === 0;
});

if (missing.length > 0) {
  console.error(`Production artifact is incomplete: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Production artifact verified (${requiredFiles.length} required files).`);
