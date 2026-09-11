#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  canonicalProtectedSourceArchiveManifest,
  PROTECTED_SOURCE_ARCHIVE_FILENAME,
  readProtectedSourceArchiveManifest,
} from "../dist/src/lib/protected-source-archive.js";

const requiredFiles = [
  "dist/src/server.js",
  "dist/scripts/lib/hosted-bar-pilot-acceptance.mjs",
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

// Railpack retains dist as the application artifact. Preserve explicit archive
// provenance there without assuming the source checkout remains in the image.
// The ordinary Git build has no generated manifest and remains unchanged.
const sourceRoot = fs.realpathSync(process.cwd());
const sourceArchive = readProtectedSourceArchiveManifest(sourceRoot);
const artifactRoot = fs.realpathSync(path.join(sourceRoot, "dist"));
if (sourceArchive) {
  const destination = path.join(artifactRoot, PROTECTED_SOURCE_ARCHIVE_FILENAME);
  if (!readProtectedSourceArchiveManifest(artifactRoot)) {
    fs.writeFileSync(destination, canonicalProtectedSourceArchiveManifest(sourceArchive), {
      flag: "wx",
      mode: 0o444,
    });
  }
  if (readProtectedSourceArchiveManifest(artifactRoot)?.sourceIdentitySha256 !== sourceArchive.sourceIdentitySha256) {
    throw new Error("Production artifact source identity does not match its protected archive.");
  }
} else if (readProtectedSourceArchiveManifest(artifactRoot)) {
  throw new Error("Production artifact contains an unexpected source archive identity.");
}

console.log(`Production artifact verified (${requiredFiles.length} required files).`);
