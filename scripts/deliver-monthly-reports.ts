import { env } from "../src/config/env.js";
import { createDatabase } from "../src/db/database.js";
import { BusinessRepository } from "../src/db/business.repository.js";
import {
  createMockReportEmailProvider,
  createResendReportEmailProvider,
  runMonthlyReportDelivery,
} from "../src/lib/monthly-report-delivery.js";
import { BusinessService } from "../src/modules/business/business.service.js";

function getArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const month = getArgValue("month") ?? process.env.PINTPATH_REPORT_MONTH ?? undefined;
const venueId = getArgValue("venue-id") ?? process.env.PINTPATH_REPORT_VENUE_ID ?? null;
const dryRun = process.argv.includes("--dry-run") || process.env.PINTPATH_REPORT_DRY_RUN === "true";
const retryRejected = process.argv.includes("--retry-rejected");
if (env.RESTORE_REHEARSAL_MODE) {
  throw new Error("Monthly report delivery is disabled in RESTORE_REHEARSAL_MODE.");
}
const database = createDatabase();

try {
  const repository = new BusinessRepository(database);
  const service = new BusinessService(repository, env);
  const provider = env.REPORT_EMAIL_MODE === "resend"
    ? createResendReportEmailProvider({ apiKey: env.RESEND_API_KEY! })
    : env.REPORT_EMAIL_MODE === "mock"
      ? createMockReportEmailProvider()
      : null;
  const result = await runMonthlyReportDelivery({
    generator: service,
    repository,
    provider,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    from: env.REPORT_EMAIL_FROM ?? "Pint Path <reports@pintpath.au>",
    ...(env.REPORT_EMAIL_REPLY_TO ? { replyTo: env.REPORT_EMAIL_REPLY_TO } : {}),
    timezone: env.REPORT_TIMEZONE,
    ...(month ? { month } : {}),
    venueId,
    dryRun,
    retryRejected,
  });
  const complete = result.generatedCount > 0
    && result.skippedNoEligibleRecipientCount === 0
    && result.skippedUnverifiedAccountCount === 0
    && result.rejectedCount === 0
    && result.uncertainCount === 0
    && result.inProgressCount === 0;

  console.log(JSON.stringify({
    ok: complete,
    complete,
    emailMode: env.REPORT_EMAIL_MODE,
    ...result,
  }, null, 2));

  if (!complete) {
    process.exitCode = 1;
  }
} finally {
  database.close();
}
