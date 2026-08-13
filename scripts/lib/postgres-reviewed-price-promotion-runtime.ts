import fs from "node:fs";
import { types as utilTypes } from "node:util";

import { buildPostgresReviewedPricePromotionPlanArtifacts } from
  "../../src/lib/postgres-reviewed-price-promotion-plan.js";
import { STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK } from
  "./staging-postgres-build-canary-railway-contract.js";
import { assertLockedSensitiveWorkerBoundary } from
  "./locked-sensitive-worker-boundary.js";
import {
  openRailwayPlannerDatabase,
  type PostgresReviewedPricePromotionCliDependencies,
  type PostgresReviewedPricePromotionPlannerDatabaseOptions,
} from "../postgres-reviewed-price-promotion.js";

const DATE_CONSTRUCTOR = Date;
const BUFFER_CONSTRUCTOR = Buffer;
const BUFFER_FROM = Buffer.from;
const BUFFER_IS_BUFFER = Buffer.isBuffer;
const FS_OBJECT = fs;
const FS_WRITE_SYNC = fs.writeSync;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const NUMBER_OBJECT = Number;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const REFLECT_APPLY = Reflect.apply;
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_LENGTH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "length",
)?.get;
const UTIL_IS_PROXY = utilTypes.isProxy;
const UTIL_TYPES_OBJECT = utilTypes;

function writeStandardOutputExact(value: string): void {
  if (typeof value !== "string") throw new Error("planner_summary_write_failed");
  const bytes = REFLECT_APPLY(
    BUFFER_FROM,
    BUFFER_CONSTRUCTOR,
    [value, "utf8"],
  ) as Buffer;
  try {
    if (
      typeof TYPED_ARRAY_LENGTH_GETTER !== "function"
      || !REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_CONSTRUCTOR, [bytes])
      || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_OBJECT, [bytes]) === true
    ) throw new Error("planner_summary_write_failed");
    const length = REFLECT_APPLY(TYPED_ARRAY_LENGTH_GETTER, bytes, []);
    if (
      !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_OBJECT, [length])
      || length < 1
    ) throw new Error("planner_summary_write_failed");
    let offset = 0;
    while (offset < length) {
      const written = REFLECT_APPLY(FS_WRITE_SYNC, FS_OBJECT, [
        1,
        bytes,
        offset,
        length - offset,
      ]);
      if (
        !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_OBJECT, [written])
        || written <= 0
        || written > length - offset
      ) throw new Error("planner_summary_write_failed");
      offset += written;
    }
  } finally {
    REFLECT_APPLY(TYPED_ARRAY_FILL, bytes, [0]);
  }
}

async function openFixedRailwayPlannerDatabase(
  options: PostgresReviewedPricePromotionPlannerDatabaseOptions,
) {
  assertLockedSensitiveWorkerBoundary("planner");
  return openRailwayPlannerDatabase(options);
}

function assertProductionBoundary(): void {
  assertLockedSensitiveWorkerBoundary("planner");
}

export const POSTGRES_REVIEWED_PRICE_PROMOTION_RUNTIME = Object.freeze({
  assertProductionBoundary,
  openDatabase: openFixedRailwayPlannerDatabase,
  buildPlan: buildPostgresReviewedPricePromotionPlanArtifacts,
  environment: process.env,
  expectedRootCaDerSha256:
    STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.rootCaDerSha256,
  now: () => new DATE_CONSTRUCTOR(),
  writeOutput: writeStandardOutputExact,
} satisfies PostgresReviewedPricePromotionCliDependencies);
