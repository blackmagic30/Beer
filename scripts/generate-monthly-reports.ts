import { env } from "../src/config/env.js";
import { createDatabase } from "../src/db/database.js";
import { BusinessRepository } from "../src/db/business.repository.js";
import { AccountSessionRepository } from "../src/db/account-session.repository.js";
import { AccountProfilePreferencesRepository } from "../src/db/account-profile-preferences.repository.js";
import { AccountDeletionQueueRepository } from "../src/db/account-deletion-queue.repository.js";
import { AccountPrivacyRepository } from "../src/db/account-privacy.repository.js";
import { PrivacyRetentionRepository } from "../src/db/privacy-retention.repository.js";
import { CommunitySubmissionRepository } from "../src/db/community-submission.repository.js";
import { VenueManagerInternalSubmissionRepository } from "../src/db/venue-manager-internal-submission.repository.js";
import { SourceEvidenceObjectRepository } from "../src/db/source-evidence-object.repository.js";
import { SourceEvidenceRetentionRepository } from "../src/db/source-evidence-retention.repository.js";
import { VenuePendingChangeRepository } from "../src/db/venue-pending-change.repository.js";
import { VenueDataReadRepository } from "../src/db/venue-data-read.repository.js";
import { PublicPriceRepository } from "../src/db/public-price.repository.js";
import { PublicVenueDirectoryRepository } from "../src/db/public-venue-directory.repository.js";
import { asAsyncSqliteDatabase } from "../src/db/sql-database.js";
import { SystemStateRepository } from "../src/db/system-state.repository.js";
import { ActivityAuditRepository } from "../src/db/activity-audit.repository.js";
import { SupportFeedbackRepository } from "../src/db/support-feedback.repository.js";
import { VenueInventoryRepository } from "../src/db/venue-inventory.repository.js";
import { VenueIdentityRepository } from "../src/db/venue-identity.repository.js";
import { BillingCheckoutRepository } from "../src/db/billing-checkout.repository.js";
import { VenueAccessRepository } from "../src/db/venue-access.repository.js";
import { MissionLifecycleRepository } from "../src/db/mission-lifecycle.repository.js";
import { MissionDiscoveryAutomationRepository } from "../src/db/mission-discovery-automation.repository.js";
import { StripeSubscriptionRepository } from "../src/db/stripe-subscription.repository.js";
import { VenueRequestRepository } from "../src/db/venue-request.repository.js";
import { VenuePartnerRepository } from "../src/db/venue-partner.repository.js";
import { AdminAnalyticsRepository } from "../src/db/admin-analytics.repository.js";
import { VenueManagerInsightsRepository } from "../src/db/venue-manager-insights.repository.js";
import { AdminAccountRepository } from "../src/db/admin-account.repository.js";
import { BusinessService } from "../src/modules/business/business.service.js";
import { createSqliteAccountDeletionSecretPhysicalCheckpoint } from "../src/lib/account-deletion-secret-checkpoint.js";

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
  const sqlDatabase = asAsyncSqliteDatabase(database);
  const service = new BusinessService(
    repository,
    env,
    new PublicVenueDirectoryRepository(sqlDatabase),
    new PublicPriceRepository(sqlDatabase),
    new SystemStateRepository(sqlDatabase),
    new ActivityAuditRepository(sqlDatabase),
    new SupportFeedbackRepository(sqlDatabase),
    new AccountSessionRepository(sqlDatabase),
    new AccountProfilePreferencesRepository(sqlDatabase),
    new VenueInventoryRepository(sqlDatabase),
    new VenueIdentityRepository(sqlDatabase),
    new BillingCheckoutRepository(sqlDatabase),
    new VenueAccessRepository(sqlDatabase),
    new MissionLifecycleRepository(sqlDatabase),
    new MissionDiscoveryAutomationRepository(sqlDatabase),
    new StripeSubscriptionRepository(sqlDatabase),
    new VenueRequestRepository(sqlDatabase),
    new VenuePartnerRepository(sqlDatabase),
    new AdminAnalyticsRepository(sqlDatabase),
    new VenueManagerInsightsRepository(sqlDatabase),
    new AdminAccountRepository(sqlDatabase),
    new AccountDeletionQueueRepository(sqlDatabase),
    new AccountPrivacyRepository(sqlDatabase),
    new PrivacyRetentionRepository(sqlDatabase),
    new CommunitySubmissionRepository(sqlDatabase),
    new VenueManagerInternalSubmissionRepository(sqlDatabase),
    new SourceEvidenceObjectRepository(sqlDatabase),
    new SourceEvidenceRetentionRepository(sqlDatabase),
    new VenuePendingChangeRepository(sqlDatabase),
    new VenueDataReadRepository(sqlDatabase),
    createSqliteAccountDeletionSecretPhysicalCheckpoint(database),
  );
  const input = {
    month,
    venueId,
    dryRun,
    deliver,
  };
  const generated = deliver
    ? await service.deliverScheduledVenueMonthlyReports(input)
    : await service.generateScheduledVenueMonthlyReports(input);
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
