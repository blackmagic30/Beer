#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const sourceArtifact = path.resolve(process.cwd(), "dist");
if (!fs.existsSync(path.join(sourceArtifact, "src", "server.js"))) {
  console.error("Production artifact smoke requires a completed npm run build.");
  process.exit(1);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate an artifact-smoke port.");
  }
  const { port } = address;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return port;
}

const isolatedRoot = fs.mkdtempSync(path.join(process.cwd(), ".artifact-smoke-"));
const copiedArtifact = path.join(isolatedRoot, "dist");
let child;

try {
  fs.cpSync(sourceArtifact, copiedArtifact, { recursive: true });
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const output = [];
  child = spawn(process.execPath, [path.join(copiedArtifact, "src", "server.js")], {
    cwd: isolatedRoot,
    env: {
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_BASE_URL: origin,
      DATABASE_PATH: path.join(isolatedRoot, "data", "pint-path.sqlite"),
      SOURCE_EVIDENCE_STORAGE_DIR: path.join(isolatedRoot, "data", "source-evidence"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  const deadline = Date.now() + 15_000;
  let healthResponse;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      healthResponse = await fetch(`${origin}/health`);
      if (healthResponse.ok) break;
    } catch {
      // The isolated server is still starting.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  if (!healthResponse?.ok) {
    throw new Error(`Artifact server did not become healthy. ${output.join("").slice(-4_000)}`);
  }
  const [startupResponse, indexResponse] = await Promise.all([
    fetch(`${origin}/startup`),
    fetch(`${origin}/`),
  ]);
  const indexHtml = await indexResponse.text();
  if (!startupResponse.ok || !indexResponse.ok || !indexHtml.includes("Pint Path")) {
    throw new Error(
      `Artifact routes failed: startup=${startupResponse.status} index=${indexResponse.status}`,
    );
  }

  console.log("Production artifact smoke passed (/health, /startup, and bundled viewer from an isolated cwd).");
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => {
        child.once("exit", resolve);
      }),
      new Promise((resolve) => {
        setTimeout(resolve, 2_000);
      }),
    ]);
  }
  fs.rmSync(isolatedRoot, { recursive: true, force: true });
}
