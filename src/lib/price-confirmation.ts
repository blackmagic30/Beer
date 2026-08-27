import crypto from "node:crypto";

import type { PublicVenuePriceRecord } from "../db/business.repository.js";

/**
 * Opaque fingerprint for the persisted record version a person saw. The
 * fingerprint deliberately excludes the low-entropy exact price so account
 * exports cannot become an offline price oracle after access expires.
 */
export function priceConfirmationVersion(record: PublicVenuePriceRecord): string {
  const stablePriceVersion = JSON.stringify({
    schemaVersion: 2,
    id: record.id,
    lastVerifiedAt: record.lastVerifiedAt,
    priceVerifiedAt: record.priceVerifiedAt ?? null,
    updatedAt: record.updatedAt,
  });
  return crypto.createHash("sha256").update(stablePriceVersion).digest("hex");
}
