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
import {
  createMockReportEmailProvider,
  createResendReportEmailProvider,
  runMonthlyReportDelivery,
} from "../src/lib/monthly-report-delivery.js";
import { BusinessService } from "../src/modules/business/business.service.js";
import { createSqliteAccountDeletionSecretPhysicalCheckpoint } from "../src/lib/account-deletion-secret-checkpoint.js";

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
  const sqlDatabase = asAsyncSqliteDatabase(database);
  const stateRepository = new SystemStateRepository(sqlDatabase);
  const accountSessionRepository = new AccountSessionRepository(sqlDatabase);
  const venueAccessRepository = new VenueAccessRepository(sqlDatabase);
  const service = new BusinessService(
    repository,
    env,
    new PublicVenueDirectoryRepository(sqlDatabase),
    new PublicPriceRepository(sqlDatabase),
    stateRepository,
    new ActivityAuditRepository(sqlDatabase),
    new SupportFeedbackRepository(sqlDatabase),
    accountSessionRepository,
    new AccountProfilePreferencesRepository(sqlDatabase),
    new VenueInventoryRepository(sqlDatabase),
    new VenueIdentityRepository(sqlDatabase),
    new BillingCheckoutRepository(sqlDatabase),
    venueAccessRepository,
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
  const provider = env.REPORT_EMAIL_MODE === "resend"
    ? createResendReportEmailProvider({ apiKey: env.RESEND_API_KEY! })
    : env.REPORT_EMAIL_MODE === "mock"
      ? createMockReportEmailProvider()
      : null;
  const result = await runMonthlyReportDelivery({
    generator: service,
    repository: venueAccessRepository,
    accountRepository: accountSessionRepository,
    stateRepository,
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
