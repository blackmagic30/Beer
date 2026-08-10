import fs from "node:fs";

import { buildPostgresReviewedPricePromotionPlanCandidate } from
  "../../src/lib/postgres-reviewed-price-promotion-plan.js";
import { STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK } from
  "./staging-postgres-build-canary-railway-contract.js";
import type {
  PostgresReviewedPricePromotionCliDependencies,
  PostgresReviewedPricePromotionPlannerDatabaseOptions,
} from "../postgres-reviewed-price-promotion.js";

function writeStandardOutputExact(value: string): void {
  const bytes = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(
      1,
      bytes,
      offset,
      bytes.length - offset,
    );
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error("planner_summary_write_failed");
    }
    offset += written;
  }
}

async function openFixedRailwayPlannerDatabase(
  options: PostgresReviewedPricePromotionPlannerDatabaseOptions,
) {
  const { openRailwayPlannerDatabase } = await import(
    "../postgres-reviewed-price-promotion.js"
  );
  return openRailwayPlannerDatabase(options);
}

export const POSTGRES_REVIEWED_PRICE_PROMOTION_RUNTIME = Object.freeze({
  openDatabase: openFixedRailwayPlannerDatabase,
  buildPlan: buildPostgresReviewedPricePromotionPlanCandidate,
  environment: process.env,
  expectedRootCaDerSha256:
    STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.rootCaDerSha256,
  writeOutput: writeStandardOutputExact,
} satisfies PostgresReviewedPricePromotionCliDependencies);
