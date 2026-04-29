import { HAPPY_HOUR_SCRIPT_VARIANT_KEYS } from "../src/constants/agent-script.js";

interface CallRunView {
  id: string;
  requestedBeer: string | null;
  scriptVariant: string | null;
  callStatus: string;
  parseStatus: string;
  errorMessage: string | null;
  happyHour: {
    happyHour: boolean;
    happyHourDays: string | null;
    happyHourStart: string | null;
    happyHourEnd: string | null;
    happyHourPrice: number | null;
    happyHourSpecials: string | null;
  } | null;
}

interface CallsResponse {
  ok: boolean;
  data?: {
    count: number;
    calls: CallRunView[];
  };
}

function parseArgs(argv: string[]) {
  const options = {
    baseUrl: process.env.BEER_API_BASE_URL ?? "https://beer-production-aad4.up.railway.app",
    limit: 200,
  };

  for (const argument of argv) {
    if (argument.startsWith("--base-url=")) {
      options.baseUrl = argument.slice("--base-url=".length);
    } else if (argument.startsWith("--limit=")) {
      const parsed = Number.parseInt(argument.slice("--limit=".length), 10);

      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = parsed;
      }
    }
  }

  return options;
}

function buildUrl(baseUrl: string, limit: number): string {
  const url = new URL("/api/calls", baseUrl);
  url.searchParams.set("requestedBeer", "happy_hour");
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

function formatPercent(value: number, total: number): string {
  if (total === 0) {
    return "0.0%";
  }

  return `${((value / total) * 100).toFixed(1)}%`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const response = await fetch(buildUrl(options.baseUrl, options.limit));

  if (!response.ok) {
    throw new Error(`Variant report fetch failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as CallsResponse;
  const calls = payload.data?.calls ?? [];
  const happyHourCalls = calls.filter((call) => call.requestedBeer === "happy_hour");

  const groups = new Map<string, CallRunView[]>();

  for (const variant of HAPPY_HOUR_SCRIPT_VARIANT_KEYS) {
    groups.set(variant, []);
  }

  for (const call of happyHourCalls) {
    const variant = call.scriptVariant ?? "untracked";
    const bucket = groups.get(variant) ?? [];
    bucket.push(call);
    groups.set(variant, bucket);
  }

  console.log(`Happy hour script variant report (${happyHourCalls.length} calls)\n`);

  for (const [variant, rows] of groups.entries()) {
    if (rows.length === 0) {
      continue;
    }

    const parsed = rows.filter((row) => row.parseStatus === "parsed").length;
    const usable = rows.filter((row) => row.happyHour && (row.happyHour.happyHourSpecials || row.happyHour.happyHourDays || row.happyHour.happyHourStart)).length;
    const noHappyHour = rows.filter((row) => row.happyHour?.happyHour === false).length;
    const failed = rows.filter((row) => row.callStatus === "failed").length;
    const lowSignal = rows.filter((row) => row.parseStatus !== "parsed" && row.callStatus !== "failed").length;

    console.log(`${variant}`);
    console.log(`  total: ${rows.length}`);
    console.log(`  parsed: ${parsed} (${formatPercent(parsed, rows.length)})`);
    console.log(`  usable captures: ${usable} (${formatPercent(usable, rows.length)})`);
    console.log(`  explicit no happy hour: ${noHappyHour} (${formatPercent(noHappyHour, rows.length)})`);
    console.log(`  hard failures: ${failed} (${formatPercent(failed, rows.length)})`);
    console.log(`  low-signal: ${lowSignal} (${formatPercent(lowSignal, rows.length)})`);
    console.log("");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
