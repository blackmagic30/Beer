import { env } from "../src/config/env.js";
import { createDatabase } from "../src/db/database.js";
import { BusinessRepository } from "../src/db/business.repository.js";
import { BusinessService } from "../src/modules/business/business.service.js";

function getArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const month = getArgValue("month") ?? process.env.PINTPATH_REPORT_MONTH ?? undefined;
const venueId = getArgValue("venue-id") ?? process.env.PINTPATH_REPORT_VENUE_ID ?? null;
const dryRun = process.argv.includes("--dry-run") || process.env.PINTPATH_REPORT_DRY_RUN === "true";
const deliver = process.argv.includes("--deliver") || process.env.PINTPATH_REPORT_DELIVER === "true";

if (env.RESTORE_REHEARSAL_MODE) {
  throw new Error("Monthly report generation is disabled during an isolated restore rehearsal.");
}

const database = createDatabase();

try {
  const repository = new BusinessRepository(database);
  const service = new BusinessService(repository, env);
  const input = {
    month,
    venueId,
    dryRun,
    deliver,
  };
  const generated = deliver
    ? service.deliverScheduledVenueMonthlyReports(input)
    : service.generateScheduledVenueMonthlyReports(input);
  const deliveries = "deliveries" in generated && Array.isArray(generated.deliveries)
    ? generated.deliveries as Array<{ status: string }>
    : [];

  console.log(JSON.stringify({
    ok: true,
    mode: deliver ? "generate_and_deliver" : "generate_only",
    generated: {
      month: generated.month,
      timezone: generated.timezone,
      generatedCount: generated.generatedCount,
      skippedReason: generated.skippedReason,
      dryRun: generated.dryRun,
    },
    delivery: deliver
      ? {
          emailMode: env.REPORT_EMAIL_MODE,
          deliveryCount: deliveries.length,
          mockedCount: deliveries.filter((delivery) => delivery.status === "mocked").length,
          dryRunCount: deliveries.filter((delivery) => delivery.status === "dry_run").length,
          skippedCount: deliveries.filter((delivery) => String(delivery.status).startsWith("skipped")).length,
          warning: env.REPORT_EMAIL_MODE === "mock"
            ? "Mock delivery payloads are captured in admin route tests; this script does not send real email."
            : env.REPORT_EMAIL_MODE === "resend"
              ? "This legacy generation command never sends real email. Use npm run reports:deliver after a dry run."
              : "REPORT_EMAIL_MODE is disabled, so no report emails were sent.",
        }
      : null,
  }, null, 2));
} finally {
  database.close();
}
