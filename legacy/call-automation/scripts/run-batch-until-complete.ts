import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

type BatchStatus = "running" | "paused" | "completed";

interface BatchRunStateSnapshot {
  runId: string;
  status: BatchStatus;
  stopReason: string | null;
  cursor: number;
  total: number;
}

const RESUMABLE_STOP_REASON_PATTERNS = [
  /circuit breaker tripped/i,
  /low-signal breaker tripped/i,
  /still unresolved/i,
  /network error while queueing/i,
] as const;

const TERMINAL_STOP_REASON_PATTERNS = [
  /outside the configured venue call window/i,
  /resume when the window reopens/i,
  /outbound calling paused by api/i,
] as const;

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readState(statePath: string): BatchRunStateSnapshot {
  const raw = fs.readFileSync(statePath, "utf8");
  return JSON.parse(raw) as BatchRunStateSnapshot;
}

function shouldResume(state: BatchRunStateSnapshot): boolean {
  if (state.status === "completed") {
    return false;
  }

  if (!state.stopReason) {
    return true;
  }

  if (TERMINAL_STOP_REASON_PATTERNS.some((pattern) => pattern.test(state.stopReason ?? ""))) {
    return false;
  }

  if (RESUMABLE_STOP_REASON_PATTERNS.some((pattern) => pattern.test(state.stopReason ?? ""))) {
    return true;
  }

  return false;
}

async function runBatchOnce(nodeBin: string, scriptPath: string, passthroughArgs: string[]): Promise<number> {
  return await new Promise((resolve) => {
    const child = spawn(nodeBin, [scriptPath, ...passthroughArgs], {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });

    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

async function main() {
  const root = process.cwd();
  const statePath = path.resolve(root, getArg("state-file", "./data/runs/venue-call-batch-state.json")!);
  const nodeBin = process.execPath;
  const scriptPath = path.resolve(root, "./dist/scripts/batch-call-venues.js");
  const resumeDelayMs = Number.parseInt(getArg("resume-delay-ms", "15000") ?? "15000", 10);
  const maxResumes = Number.parseInt(getArg("max-resumes", "200") ?? "200", 10);
  const passthroughArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--resume-delay-ms=") && !arg.startsWith("--max-resumes="));

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Compiled batch runner not found at ${scriptPath}. Run npm run build first.`);
  }

  if (!fs.existsSync(statePath) && !passthroughArgs.some((arg) => arg.startsWith("--state-file="))) {
    passthroughArgs.push(`--state-file=${statePath}`);
  }

  const automationRunId = randomUUID();
  console.log(`Auto-resume wrapper started (${automationRunId}).`);
  console.log(`Using state file: ${statePath}`);

  for (let resumeCount = 0; resumeCount < maxResumes; resumeCount += 1) {
    const exitCode = await runBatchOnce(nodeBin, scriptPath, passthroughArgs);

    if (!fs.existsSync(statePath)) {
      throw new Error(`State file ${statePath} was not created by the batch runner.`);
    }

    const state = readState(statePath);
    console.log(
      `Batch pass ${resumeCount + 1} finished with exit ${exitCode}. Status=${state.status}. Cursor=${state.cursor}/${state.total}. Reason=${state.stopReason ?? "none"}`,
    );

    if (!shouldResume(state)) {
      console.log("Auto-resume wrapper is stopping because the batch reached a non-resumable state.");
      return;
    }

    console.log(`Sleeping ${resumeDelayMs}ms before resuming...`);
    await sleep(resumeDelayMs);
  }

  throw new Error(`Auto-resume wrapper hit the max resume count (${maxResumes}) before completion.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
