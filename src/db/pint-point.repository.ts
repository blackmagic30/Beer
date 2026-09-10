import crypto from "node:crypto";
import { AppError } from "../lib/errors.js";
import { redactSecrets } from '../lib/redact.js';
import type { SqlDatabase } from './sql-database.js';
import type { AccountDiscountPass, PintPointDrinkRecord, PintPointDrinkRecordStatus, VenuePintPointActivity, PintPointLedgerType, PintPointLedgerEntry, FreePintRewardCode, FreePintRewardCodeStatus, FreePintRewardRedemption } from './business.repository.js';
interface AccountDiscountPassRow {
    id: string;
    user_id: string;
    session_token_hash: string;
    code_hash: string;
    status: "active" | "revoked";
    created_at: string;
    expires_at: string;
    revoked_at: string | null;
    last_used_at: string | null;
}
interface PintPointDrinkRecordRow {
    id: string;
    user_id: string;
    venue_id: string;
    venue_name: string;
    suburb: string | null;
    item_name: string | null;
    beverage_category: string;
    quantity: number;
    is_alcoholic: number;
    points_awarded: number;
    source: string;
    reward_code_id: string | null;
    recorded_by_user_id: string | null;
    idempotency_key: string | null;
    status: PintPointDrinkRecordStatus;
    voided_at: string | null;
    voided_by_user_id: string | null;
    void_reason: string | null;
    recorded_at: string;
    metadata_json: string;
    created_at: string;
}
interface VenuePintPointActivityRow {
    id: string;
    public_account_id: string;
    item_name: string | null;
    beverage_category: string;
    quantity: number;
    points_awarded: number;
    source: string;
    recorded_by_user_id: string | null;
    status: PintPointDrinkRecordStatus;
    voided_at: string | null;
    voided_by_user_id: string | null;
    void_reason: string | null;
    recorded_at: string;
}
interface PintPointLedgerRow {
    id: string;
    user_id: string;
    venue_id: string | null;
    drink_record_id: string | null;
    reward_code_id: string | null;
    type: PintPointLedgerType;
    points_delta: number;
    points_reserved_delta: number;
    description: string;
    created_at: string;
    metadata_json: string;
}
interface FreePintRewardCodeRow {
    id: string;
    user_id: string;
    public_account_id: string;
    code_hash: string;
    eligible_venue_scope: string;
    status: FreePintRewardCodeStatus;
    points_reserved: number;
    created_at: string;
    expires_at: string;
    used_at: string | null;
    cancelled_at: string | null;
    rejected_at: string | null;
    rejected_reason: string | null;
    redeemed_by_user_id: string | null;
    redeemed_venue_id: string | null;
    metadata_json: string;
}
interface FreePintRewardRedemptionRow {
    id: string;
    user_id: string;
    public_account_id: string;
    reward_code_id: string;
    venue_id: string;
    venue_name: string;
    suburb: string | null;
    redeemed_by_user_id: string | null;
    redeemed_at: string;
    metadata_json: string;
    created_at: string;
}
function toAccountDiscountPass(row: AccountDiscountPassRow): AccountDiscountPass {
    return {
        id: row.id,
        userId: row.user_id,
        sessionTokenHash: row.session_token_hash,
        codeHash: row.code_hash,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        lastUsedAt: row.last_used_at,
    };
}
function toPintPointDrinkRecord(row: PintPointDrinkRecordRow): PintPointDrinkRecord {
    return {
        id: row.id,
        userId: row.user_id,
        venueId: row.venue_id,
        venueName: row.venue_name,
        suburb: row.suburb,
        itemName: row.item_name,
        beverageCategory: row.beverage_category,
        quantity: Number(row.quantity),
        isAlcoholic: Boolean(row.is_alcoholic),
        pointsAwarded: Number(row.points_awarded ?? 0),
        source: row.source,
        rewardCodeId: row.reward_code_id,
        recordedByUserId: row.recorded_by_user_id,
        idempotencyKey: row.idempotency_key,
        status: row.status ?? "active",
        voidedAt: row.voided_at,
        voidedByUserId: row.voided_by_user_id,
        voidReason: row.void_reason,
        recordedAt: row.recorded_at,
        metadata: parseJsonObject(row.metadata_json),
        createdAt: row.created_at,
    };
}
function toPintPointLedgerEntry(row: PintPointLedgerRow): PintPointLedgerEntry {
    return {
        id: row.id,
        userId: row.user_id,
        venueId: row.venue_id,
        drinkRecordId: row.drink_record_id,
        rewardCodeId: row.reward_code_id,
        type: row.type,
        pointsDelta: Number(row.points_delta),
        pointsReservedDelta: Number(row.points_reserved_delta),
        description: row.description,
        createdAt: row.created_at,
        metadata: parseJsonObject(row.metadata_json),
    };
}
function toFreePintRewardCode(row: FreePintRewardCodeRow): FreePintRewardCode {
    return {
        id: row.id,
        userId: row.user_id,
        publicAccountId: row.public_account_id,
        codeHash: row.code_hash,
        eligibleVenueScope: row.eligible_venue_scope,
        status: row.status,
        pointsReserved: Number(row.points_reserved),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        cancelledAt: row.cancelled_at,
        rejectedAt: row.rejected_at,
        rejectedReason: row.rejected_reason,
        redeemedByUserId: row.redeemed_by_user_id,
        redeemedVenueId: row.redeemed_venue_id,
        metadata: parseJsonObject(row.metadata_json),
    };
}
function toFreePintRewardRedemption(row: FreePintRewardRedemptionRow): FreePintRewardRedemption {
    return {
        id: row.id,
        userId: row.user_id,
        publicAccountId: row.public_account_id,
        rewardCodeId: row.reward_code_id,
        venueId: row.venue_id,
        venueName: row.venue_name,
        suburb: row.suburb,
        redeemedByUserId: row.redeemed_by_user_id,
        redeemedAt: row.redeemed_at,
        metadata: parseJsonObject(row.metadata_json),
        createdAt: row.created_at,
    };
}
function parseJsonObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    }
    catch {
        return {};
    }
}
export class PintPointRepository {
    constructor(private readonly database: SqlDatabase) { }
    // Every value-changing operation serializes on the customer. This also protects
    // aggregate ledger balances when two different rewards are presented together.
    private async lockCustomer(userId: string): Promise<void> {
        if (this.database.dialect === "postgres") {
            await this.database.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`pint-points:${userId}`);
        }
        const customer = await this.database.prepare("SELECT status FROM accounts WHERE id = ?").get(userId);
        if (!customer || customer.status !== "active") throw new AppError("This customer cannot use Pint Points right now.", 403);
    }
    private async authorizeOperator(actorUserId: string | null, venueId: string, managerOnly = false): Promise<"manager" | "counter_staff"> {
        const suffix = this.database.dialect === "postgres" ? " FOR SHARE" : "";
        const actor = await this.database.prepare("SELECT role, subscription_status, status FROM accounts WHERE id = ?" + suffix).get(actorUserId);
        if (!actor || actor.status !== "active") throw new AppError("Staff access is no longer active. Sign in again.", 403);
        if (actor.role === "admin" || actor.subscription_status === "admin") return "manager";
        const assignment = await this.database.prepare("SELECT access_level FROM venue_manager_assignments WHERE user_id = ? AND venue_id = ? AND status = 'active'" + suffix).get(actorUserId, venueId);
        if (!assignment || (managerOnly && assignment.access_level !== "manager")) throw new AppError("You are not authorised for this venue action.", 403);
        return assignment.access_level === "manager" ? "manager" : "counter_staff";
    }
    async prepareDemoBalance(input: { userId: string; venueId: string; actorUserId: string; target: 49 | 50; now: string }) {
        return this.database.transaction(async () => {
            await this.lockCustomer(input.userId);
            await this.authorizeOperator(input.actorUserId, input.venueId, true);
            await this.releaseActiveRewards(input.userId, input.now);
            const balance = await this.getPintPointBalance(input.userId);
            await this.createPintPointLedgerEntry({ id: crypto.randomUUID(), userId: input.userId, venueId: input.venueId, drinkRecordId: null, rewardCodeId: null, type: "admin_adjustment", pointsDelta: input.target - balance.balance, pointsReservedDelta: 0, description: "Pilot demonstration balance prepared (not a purchase).", createdAt: input.now, metadata: { pilotDemo: true, actorUserId: input.actorUserId, target: input.target } });
            return this.getPintPointBalance(input.userId);
        })();
    }
    private async releaseActiveRewards(userId: string, now: string) {
        const codes = await this.listFreePintRewardCodesForUser(userId, 100);
        for (const code of codes.filter(item => item.status === "active")) {
            const result = await this.database.prepare("UPDATE free_pint_reward_codes SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'active'").run(now, code.id);
            if (result.changes) await this.createPintPointLedgerEntry({ id: crypto.randomUUID(), userId, venueId: null, drinkRecordId: null, rewardCodeId: code.id, type: "reward_cancelled", pointsDelta: 0, pointsReservedDelta: -code.pointsReserved, description: "Reward cancelled for a balance correction.", createdAt: now, metadata: {} });
        }
    }
    async listVenueRewardHistory(venueId: string, limit = 25) {
        const rows = await this.database.prepare("SELECT r.*, a.public_account_id AS operator_public_account_id FROM free_pint_reward_redemptions r LEFT JOIN accounts a ON a.id = r.redeemed_by_user_id WHERE r.venue_id = ? ORDER BY r.redeemed_at DESC LIMIT ?").all(venueId, limit) as (FreePintRewardRedemptionRow & { operator_public_account_id: string | null })[];
        return rows.map(row => ({...toFreePintRewardRedemption(row), operatorPublicAccountId: row.operator_public_account_id}));
    }
    async listVenueLedgerHistory(venueId: string, limit = 50) {
        const rows = await this.database.prepare("SELECT l.*, a.public_account_id FROM pint_point_ledger l JOIN accounts a ON a.id = l.user_id WHERE l.venue_id = ? ORDER BY l.created_at DESC LIMIT ?").all(venueId, limit);
        return rows.map(row => ({ ...toPintPointLedgerEntry(row as unknown as PintPointLedgerRow), publicAccountId: row.public_account_id }));
    }
    async createDiscountPass(input: {
        id: string;
        userId: string;
        sessionTokenHash: string;
        codeHash: string;
        createdAt: string;
        expiresAt: string;
    }): Promise<AccountDiscountPass> {
        await this.database
            .prepare(`INSERT INTO account_discount_passes (
          id, user_id, session_token_hash, code_hash, status, created_at, expires_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?)`)
            .run(input.id, input.userId, input.sessionTokenHash, input.codeHash, input.createdAt, input.expiresAt);
        return (await this.getDiscountPassById(input.id))!;
    }
    async getDiscountPassById(id: string): Promise<AccountDiscountPass | null> {
        const row = await this.database
            .prepare("SELECT * FROM account_discount_passes WHERE id = ?")
            .get(id) as AccountDiscountPassRow | undefined;
        return row ? toAccountDiscountPass(row) : null;
    }
    async getActiveDiscountPassByCodeHash(input: {
        codeHash: string;
        now: string;
    }): Promise<AccountDiscountPass | null> {
        const row = await this.database
            .prepare(`SELECT p.* FROM account_discount_passes p
         JOIN auth_sessions s ON s.token_hash = p.session_token_hash AND s.user_id = p.user_id
         WHERE p.code_hash = ? AND p.status = 'active' AND p.revoked_at IS NULL
           AND p.expires_at > ? AND s.revoked_at IS NULL AND s.expires_at > ?
         LIMIT 1`)
            .get(input.codeHash, input.now, input.now) as AccountDiscountPassRow | undefined;
        return row ? toAccountDiscountPass(row) : null;
    }
    async getDiscountPassByCodeHash(codeHash: string): Promise<AccountDiscountPass | null> {
        const row = await this.database
            .prepare("SELECT * FROM account_discount_passes WHERE code_hash = ? LIMIT 1")
            .get(codeHash) as AccountDiscountPassRow | undefined;
        return row ? toAccountDiscountPass(row) : null;
    }
    async revokeDiscountPassesForSession(input: {
        sessionTokenHash: string;
        revokedAt: string;
    }): Promise<number> {
        const result = await this.database
            .prepare(`UPDATE account_discount_passes
         SET status = 'revoked', revoked_at = ?
         WHERE session_token_hash = ?
           AND status = 'active'
           AND revoked_at IS NULL`)
            .run(input.revokedAt, input.sessionTokenHash);
        return result.changes;
    }
    async markDiscountPassUsed(input: {
        id: string;
        lastUsedAt: string;
    }): Promise<boolean> {
        const result = await this.database
            .prepare(`UPDATE account_discount_passes
         SET status = 'revoked',
             last_used_at = ?,
             revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ? AND status = 'active' AND revoked_at IS NULL AND expires_at > ?`)
            .run(input.lastUsedAt, input.lastUsedAt, input.id, input.lastUsedAt);
        return result.changes === 1;
    }
    async createPintPointDrinkRecord(input: {
        id: string;
        userId: string;
        venueId: string;
        venueName: string;
        suburb: string | null;
        itemName: string | null;
        beverageCategory: string;
        quantity: number;
        isAlcoholic: boolean;
        pointsAwarded?: number;
        dailyCap?: number;
        dailySince?: string;
        source: string;
        recordedByUserId: string | null;
        idempotencyKey: string;
        recordedAt: string;
        metadata: Record<string, unknown>;
    }): Promise<PintPointDrinkRecord> {
        let pointsAwarded = 0;
        let resultId = input.id;
        const create = this.database.transaction(async () => {
            if (this.database.dialect === "postgres") await this.database.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`pint-points-receipt:${input.venueId}:${input.idempotencyKey}`);
            await this.lockCustomer(input.userId);
            await this.authorizeOperator(input.recordedByUserId, input.venueId);
            const existing = await this.getPintPointDrinkRecordByIdempotencyKey(input);
            if (existing) {
                if (existing.userId !== input.userId || existing.quantity !== input.quantity || existing.beverageCategory !== input.beverageCategory || existing.itemName !== input.itemName) throw new AppError("That receipt reference is already attached to a different purchase.", 409);
                resultId = existing.id;
                return;
            }
            if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 20 || input.isAlcoholic !== (input.beverageCategory === "alcoholic")) throw new AppError("Choose a valid purchased drink.", 400);
            if (input.source === "venue_portal" && typeof input.metadata.memberPassId !== "string") throw new AppError("Check the customer code before recording this purchase.", 400);
            if (typeof input.metadata.memberPassId === "string") {
                const pass = await this.getDiscountPassById(input.metadata.memberPassId);
                if (!pass || pass.userId !== input.userId || !(await this.getActiveDiscountPassByCodeHash({codeHash: pass.codeHash, now: input.recordedAt})) || !(await this.markDiscountPassUsed({id: pass.id, lastUsedAt: input.recordedAt}))) throw new AppError("Customer code expired or already used. Ask the customer to refresh it.", 410);
            }
            const requestedPoints = Math.max(0, Math.min(input.quantity, input.isAlcoholic ? input.quantity : 0));
            if (input.dailyCap != null && input.dailySince) {
                const awarded = await this.countPintPointsAwardedSince({ userId: input.userId, since: input.dailySince });
                pointsAwarded = Math.min(requestedPoints, Math.max(0, input.dailyCap - awarded));
            }
            else {
                pointsAwarded = requestedPoints;
            }
            await this.database
                .prepare(`INSERT INTO pint_point_drink_records (
            id, user_id, venue_id, venue_name, suburb, item_name, beverage_category,
            quantity, is_alcoholic, points_awarded, source, reward_code_id, recorded_by_user_id,
            idempotency_key, recorded_at, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
                .run(input.id, input.userId, input.venueId, input.venueName, input.suburb, input.itemName, input.beverageCategory, input.quantity, this.database.dialect === 'postgres' ? input.isAlcoholic : input.isAlcoholic ? 1 : 0, pointsAwarded, input.source, input.recordedByUserId, input.idempotencyKey, input.recordedAt, JSON.stringify(redactSecrets(input.metadata)), input.recordedAt);
            if (pointsAwarded > 0) {
                await this.createPintPointLedgerEntry({
                    id: crypto.randomUUID(),
                    userId: input.userId,
                    venueId: input.venueId,
                    drinkRecordId: input.id,
                    rewardCodeId: null,
                    type: input.source === "manual_entry" ? "manual_drink_entry" : "drink_scan",
                    pointsDelta: pointsAwarded,
                    pointsReservedDelta: 0,
                    description: pointsAwarded === 1 ? "Alcoholic beverage recorded." : `${pointsAwarded} alcoholic beverages recorded.`,
                    createdAt: input.recordedAt,
                    metadata: {
                        itemName: input.itemName,
                        quantity: input.quantity,
                        source: input.source,
                    },
                });
            }
        });
        await create();
        return (await this.getPintPointDrinkRecordById(resultId))!;
    }
    async getPintPointDrinkRecordById(id: string): Promise<PintPointDrinkRecord | null> {
        const row = await this.database
            .prepare("SELECT * FROM pint_point_drink_records WHERE id = ?")
            .get(id) as PintPointDrinkRecordRow | undefined;
        return row ? toPintPointDrinkRecord(row) : null;
    }
    async getPintPointDrinkRecordByIdempotencyKey(input: {
        venueId: string;
        idempotencyKey: string;
    }): Promise<PintPointDrinkRecord | null> {
        const row = await this.database
            .prepare(`SELECT * FROM pint_point_drink_records
         WHERE venue_id = ? AND idempotency_key = ?
         LIMIT 1`)
            .get(input.venueId, input.idempotencyKey) as PintPointDrinkRecordRow | undefined;
        return row ? toPintPointDrinkRecord(row) : null;
    }
    async listPintPointDrinkRecordsForUser(userId: string, limit: number): Promise<PintPointDrinkRecord[]> {
        const rows = await this.database
            .prepare(`SELECT * FROM pint_point_drink_records
         WHERE user_id = ? AND status = 'active'
         ORDER BY recorded_at DESC
         LIMIT ?`)
            .all(userId, limit) as PintPointDrinkRecordRow[];
        return rows.map(toPintPointDrinkRecord);
    }
    async listPintPointDrinkRecordsForVenue(venueId: string, limit: number, offset = 0): Promise<VenuePintPointActivity[]> {
        const rows = await this.database
            .prepare(`SELECT
           r.id,
           COALESCE(a.public_account_id, 'Pint Path member') AS public_account_id,
           r.item_name,
           r.beverage_category,
           r.quantity,
           r.points_awarded,
           r.source,
           r.recorded_by_user_id,
           r.status,
           r.voided_at,
           r.voided_by_user_id,
           r.void_reason,
           r.recorded_at
         FROM pint_point_drink_records r
         LEFT JOIN accounts a ON a.id = r.user_id
         WHERE r.venue_id = ?
         ORDER BY r.recorded_at DESC
         LIMIT ? OFFSET ?`)
            .all(venueId, Math.max(1, Math.min(limit, 100)), Math.max(0, offset)) as VenuePintPointActivityRow[];
        return rows.map((row) => ({
            id: row.id,
            publicAccountId: row.public_account_id,
            itemName: row.item_name,
            beverageCategory: row.beverage_category,
            quantity: Number(row.quantity),
            pointsAwarded: Number(row.points_awarded),
            source: row.source,
            recordedByUserId: row.recorded_by_user_id,
            status: row.status ?? "active",
            voidedAt: row.voided_at,
            voidedByUserId: row.voided_by_user_id,
            voidReason: row.void_reason,
            recordedAt: row.recorded_at,
        }));
    }
    async countPintPointDrinkRecordsForVenue(venueId: string): Promise<number> {
        const row = await this.database
            .prepare("SELECT count(*) AS count FROM pint_point_drink_records WHERE venue_id = ?")
            .get(venueId) as {
            count: number;
        } | undefined;
        return Number(row?.count ?? 0);
    }
    async countPintPointsAwardedSince(input: {
        userId: string;
        since: string;
    }): Promise<number> {
        const row = await this.database
            .prepare(`SELECT COALESCE(sum(points_awarded), 0) AS points
         FROM pint_point_drink_records
         WHERE user_id = ? AND recorded_at >= ? AND status = 'active'`)
            .get(input.userId, input.since) as {
            points: number;
        } | undefined;
        return Number(row?.points ?? 0);
    }
    async voidPintPointDrinkRecord(input: {
        recordId: string;
        venueId: string;
        actorUserId: string;
        reason: string;
        voidedAt: string;
    }): Promise<{
        record: PintPointDrinkRecord;
        idempotentReplay: boolean;
    } | null> {
        let idempotentReplay = false;
        const applyVoid = this.database.transaction(async () => {
            const original = await this.getPintPointDrinkRecordById(input.recordId);
            if (!original || original.venueId !== input.venueId) return null;
            await this.lockCustomer(original.userId);
            const access = await this.authorizeOperator(input.actorUserId, input.venueId);
            const current = await this.getPintPointDrinkRecordById(input.recordId);
            if (!current || current.venueId !== input.venueId) {
                return null;
            }
            if (access === "counter_staff" && (current.recordedByUserId !== input.actorUserId || (current.status === "active" && (Date.parse(input.voidedAt) - Date.parse(current.recordedAt) < 0 || Date.parse(input.voidedAt) - Date.parse(current.recordedAt) > 15 * 60_000)))) throw new AppError("Ask a venue manager to reverse this purchase.", 403);
            if (current.status === "void") {
                idempotentReplay = true;
                return current;
            }
            const balance = await this.getPintPointBalance(current.userId);
            if (balance.balance < current.pointsAwarded) throw new AppError("These points have already been spent. This purchase cannot be reversed while the balance is too low.", 409);
            if (balance.available < current.pointsAwarded) await this.releaseActiveRewards(current.userId, input.voidedAt);
            const updated = await this.database
                .prepare(`UPDATE pint_point_drink_records
           SET status = 'void', voided_at = ?, voided_by_user_id = ?, void_reason = ?
           WHERE id = ? AND venue_id = ? AND status = 'active'`)
                .run(input.voidedAt, input.actorUserId, input.reason, input.recordId, input.venueId);
            if (updated.changes !== 1) {
                idempotentReplay = true;
                return await this.getPintPointDrinkRecordById(input.recordId);
            }
            if (current.pointsAwarded > 0) {
                await this.createPintPointLedgerEntry({
                    id: crypto.randomUUID(),
                    userId: current.userId,
                    venueId: current.venueId,
                    drinkRecordId: current.id,
                    rewardCodeId: null,
                    type: "drink_void",
                    pointsDelta: -current.pointsAwarded,
                    pointsReservedDelta: 0,
                    description: current.pointsAwarded === 1
                        ? "Voided purchase: 1 Pint Point reversed."
                        : `Voided purchase: ${current.pointsAwarded} Pint Points reversed.`,
                    createdAt: input.voidedAt,
                    metadata: {
                        reason: input.reason,
                        voidedByUserId: input.actorUserId,
                    },
                });
            }
            return await this.getPintPointDrinkRecordById(input.recordId);
        });
        const record = await applyVoid();
        return record ? { record, idempotentReplay } : null;
    }
    async createPintPointLedgerEntry(input: {
        id: string;
        userId: string;
        venueId: string | null;
        drinkRecordId: string | null;
        rewardCodeId: string | null;
        type: PintPointLedgerType;
        pointsDelta: number;
        pointsReservedDelta: number;
        description: string;
        createdAt: string;
        metadata: Record<string, unknown>;
    }): Promise<PintPointLedgerEntry> {
        await this.database
            .prepare(`INSERT INTO pint_point_ledger (
          id, user_id, venue_id, drink_record_id, reward_code_id, type,
          points_delta, points_reserved_delta, description, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(input.id, input.userId, input.venueId, input.drinkRecordId, input.rewardCodeId, input.type, input.pointsDelta, input.pointsReservedDelta, input.description, input.createdAt, JSON.stringify(redactSecrets(input.metadata)));
        return (await this.getPintPointLedgerEntryById(input.id))!;
    }
    async getPintPointLedgerEntryById(id: string): Promise<PintPointLedgerEntry | null> {
        const row = await this.database
            .prepare("SELECT * FROM pint_point_ledger WHERE id = ?")
            .get(id) as PintPointLedgerRow | undefined;
        return row ? toPintPointLedgerEntry(row) : null;
    }
    async listPintPointLedgerForUser(userId: string, limit: number): Promise<PintPointLedgerEntry[]> {
        const rows = await this.database
            .prepare("SELECT * FROM pint_point_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
            .all(userId, limit) as PintPointLedgerRow[];
        return rows.map(toPintPointLedgerEntry);
    }
    async getPintPointBalance(userId: string): Promise<{
        balance: number;
        reserved: number;
        available: number;
        lifetimeEarned: number;
        lifetimeRedeemed: number;
    }> {
        const row = await this.database
            .prepare(`SELECT
           COALESCE(sum(points_delta), 0) AS balance,
           COALESCE(sum(points_reserved_delta), 0) AS reserved,
           COALESCE(sum(CASE WHEN points_delta > 0 THEN points_delta ELSE 0 END), 0) AS lifetime_earned,
           ABS(COALESCE(sum(CASE WHEN type = 'reward_redeemed' THEN points_delta ELSE 0 END), 0)) AS lifetime_redeemed
         FROM pint_point_ledger
         WHERE user_id = ?`)
            .get(userId) as {
            balance: number;
            reserved: number;
            lifetime_earned: number;
            lifetime_redeemed: number;
        } | undefined;
        const balance = Number(row?.balance ?? 0);
        const reserved = Number(row?.reserved ?? 0);
        return {
            balance,
            reserved,
            available: Math.max(0, balance - reserved),
            lifetimeEarned: Number(row?.lifetime_earned ?? 0),
            lifetimeRedeemed: Number(row?.lifetime_redeemed ?? 0),
        };
    }
    async createFreePintRewardCode(input: {
        id: string;
        userId: string;
        publicAccountId: string;
        codeHash: string;
        createdAt: string;
        expiresAt: string;
        metadata: Record<string, unknown>;
    }): Promise<FreePintRewardCode> {
        const create = this.database.transaction(async () => {
            await this.lockCustomer(input.userId);
            const wallet = await this.getPintPointBalance(input.userId);
            if (wallet.available < 50) {
                throw new Error("INSUFFICIENT_PINT_POINTS");
            }
            await this.database
                .prepare(`INSERT INTO free_pint_reward_codes (
            id, user_id, public_account_id, code_hash, eligible_venue_scope, status,
            points_reserved, created_at, expires_at, metadata_json
          ) VALUES (?, ?, ?, ?, 'affiliated', 'active', 50, ?, ?, ?)`)
                .run(input.id, input.userId, input.publicAccountId, input.codeHash, input.createdAt, input.expiresAt, JSON.stringify(redactSecrets(input.metadata)));
            await this.createPintPointLedgerEntry({
                id: crypto.randomUUID(),
                userId: input.userId,
                venueId: null,
                drinkRecordId: null,
                rewardCodeId: input.id,
                type: "reward_code_created",
                pointsDelta: 0,
                pointsReservedDelta: 50,
                description: "Free Pint Reward code created.",
                createdAt: input.createdAt,
                metadata: { expiresAt: input.expiresAt },
            });
        });
        await create();
        return (await this.getFreePintRewardCodeById(input.id))!;
    }
    async getFreePintRewardCodeById(id: string): Promise<FreePintRewardCode | null> {
        const row = await this.database
            .prepare("SELECT * FROM free_pint_reward_codes WHERE id = ?")
            .get(id) as FreePintRewardCodeRow | undefined;
        return row ? toFreePintRewardCode(row) : null;
    }
    async getFreePintRewardCodeByCodeHash(codeHash: string): Promise<FreePintRewardCode | null> {
        const row = await this.database
            .prepare("SELECT * FROM free_pint_reward_codes WHERE code_hash = ? LIMIT 1")
            .get(codeHash) as FreePintRewardCodeRow | undefined;
        return row ? toFreePintRewardCode(row) : null;
    }
    async listFreePintRewardCodesForUser(userId: string, limit: number): Promise<FreePintRewardCode[]> {
        const rows = await this.database
            .prepare("SELECT * FROM free_pint_reward_codes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
            .all(userId, limit) as FreePintRewardCodeRow[];
        return rows.map(toFreePintRewardCode);
    }
    async expireFreePintRewardCodesForUser(input: {
        userId: string;
        now: string;
    }): Promise<number> {
        const rows = await this.database
            .prepare(`SELECT * FROM free_pint_reward_codes
         WHERE user_id = ?
           AND status = 'active'
           AND expires_at <= ?`)
            .all(input.userId, input.now) as FreePintRewardCodeRow[];
        let expired = 0;
        const expire = this.database.transaction(async () => {
            await this.lockCustomer(input.userId);
            for (const row of rows) {
                const updated = await this.database
                    .prepare("UPDATE free_pint_reward_codes SET status = 'expired' WHERE id = ? AND status = 'active'")
                    .run(row.id);
                if (updated.changes !== 1) {
                    continue;
                }
                expired += 1;
                await this.createPintPointLedgerEntry({
                    id: crypto.randomUUID(),
                    userId: row.user_id,
                    venueId: null,
                    drinkRecordId: null,
                    rewardCodeId: row.id,
                    type: "reward_code_expired",
                    pointsDelta: 0,
                    pointsReservedDelta: -row.points_reserved,
                    description: "Free Pint Reward code expired.",
                    createdAt: input.now,
                    metadata: { expiresAt: row.expires_at },
                });
            }
        });
        await expire();
        return expired;
    }
    async rejectFreePintRewardCode(input: {
        codeId: string;
        venueId: string;
        actorUserId: string | null;
        reason: string | null;
        now: string;
        metadata: Record<string, unknown>;
    }): Promise<FreePintRewardCode | null> {
        const code = await this.getFreePintRewardCodeById(input.codeId);
        if (!code || code.status !== "active") {
            return null;
        }
        const reject = this.database.transaction(async () => {
            await this.lockCustomer(code.userId);
            await this.authorizeOperator(input.actorUserId, input.venueId);
            const updated = await this.database
                .prepare(`UPDATE free_pint_reward_codes
           SET status = 'rejected',
               rejected_at = ?,
               rejected_reason = ?,
               redeemed_by_user_id = ?,
               redeemed_venue_id = ?
           WHERE id = ? AND status = 'active'`)
                .run(input.now, input.reason, input.actorUserId, input.venueId, input.codeId);
            if (updated.changes !== 1) {
                return;
            }
            await this.createPintPointLedgerEntry({
                id: crypto.randomUUID(),
                userId: code.userId,
                venueId: input.venueId,
                drinkRecordId: null,
                rewardCodeId: code.id,
                type: "reward_rejected",
                pointsDelta: 0,
                pointsReservedDelta: -code.pointsReserved,
                description: "Free Pint Reward rejected by venue.",
                createdAt: input.now,
                metadata: {
                    reason: input.reason,
                    ...input.metadata,
                },
            });
        });
        await reject();
        return await this.getFreePintRewardCodeById(input.codeId);
    }
    async redeemFreePintRewardCode(input: {
        codeId: string;
        userId: string;
        publicAccountId: string;
        venueId: string;
        venueName: string;
        suburb: string | null;
        redeemedByUserId: string | null;
        redeemedAt: string;
        metadata: Record<string, unknown>;
    }): Promise<FreePintRewardRedemption | null> {
        const code = await this.getFreePintRewardCodeById(input.codeId);
        if (!code || code.status !== "active" || code.userId !== input.userId) {
            return null;
        }
        const redemptionId = crypto.randomUUID();
        const redeem = this.database.transaction(async () => {
            await this.lockCustomer(input.userId);
            await this.authorizeOperator(input.redeemedByUserId, input.venueId);
            const current = await this.getFreePintRewardCodeById(input.codeId);
            const wallet = await this.getPintPointBalance(input.userId);
            if (!current || current.status !== "active" || current.userId !== input.userId || current.publicAccountId !== input.publicAccountId || current.expiresAt <= input.redeemedAt || current.pointsReserved !== 50 || wallet.balance < 50 || wallet.reserved < 50) return;
            if (current.metadata.requestedVenueId && current.metadata.requestedVenueId !== input.venueId) throw new AppError("This reward is for another venue.", 403);
            const update = await this.database
                .prepare(`UPDATE free_pint_reward_codes
           SET status = 'used',
               used_at = ?,
               redeemed_by_user_id = ?,
               redeemed_venue_id = ?
           WHERE id = ? AND status = 'active'`)
                .run(input.redeemedAt, input.redeemedByUserId, input.venueId, input.codeId);
            if (update.changes !== 1) {
                return;
            }
            await this.database
                .prepare(`INSERT INTO free_pint_reward_redemptions (
            id, user_id, public_account_id, reward_code_id, venue_id, venue_name,
            suburb, redeemed_by_user_id, redeemed_at, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(redemptionId, input.userId, input.publicAccountId, input.codeId, input.venueId, input.venueName, input.suburb, input.redeemedByUserId, input.redeemedAt, JSON.stringify(redactSecrets(input.metadata)), input.redeemedAt);
            await this.createPintPointLedgerEntry({
                id: crypto.randomUUID(),
                userId: input.userId,
                venueId: input.venueId,
                drinkRecordId: null,
                rewardCodeId: input.codeId,
                type: "reward_redeemed",
                pointsDelta: -50,
                pointsReservedDelta: -50,
                description: "Free Pint Reward redeemed.",
                createdAt: input.redeemedAt,
                metadata: {
                    venueName: input.venueName,
                    suburb: input.suburb,
                },
            });
        });
        await redeem();
        return await this.getFreePintRewardRedemptionById(redemptionId);
    }
    async getFreePintRewardRedemptionById(id: string): Promise<FreePintRewardRedemption | null> {
        const row = await this.database
            .prepare("SELECT * FROM free_pint_reward_redemptions WHERE id = ?")
            .get(id) as FreePintRewardRedemptionRow | undefined;
        return row ? toFreePintRewardRedemption(row) : null;
    }
    async listFreePintRewardRedemptionsForUser(userId: string, limit: number): Promise<FreePintRewardRedemption[]> {
        const rows = await this.database
            .prepare("SELECT * FROM free_pint_reward_redemptions WHERE user_id = ? ORDER BY redeemed_at DESC LIMIT ?")
            .all(userId, limit) as FreePintRewardRedemptionRow[];
        return rows.map(toFreePintRewardRedemption);
    }
    async getPintPointStatsForVenue(input: {
        venueId: string;
        startIso?: string | null | undefined;
        endIso?: string | null | undefined;
    }): Promise<{
        pointsIssued: number;
        drinkRecords: number;
        alcoholicDrinks: number;
        freeRewardsRedeemed: number;
        expiredOrRejectedCodes: number;
    }> {
        const drinkClauses = ["venue_id = ?"];
        const drinkValues: unknown[] = [input.venueId];
        const rewardClauses = ["redeemed_venue_id = ?"];
        const rewardValues: unknown[] = [input.venueId];
        if (input.startIso) {
            drinkClauses.push("recorded_at >= ?");
            drinkValues.push(input.startIso);
            rewardClauses.push("COALESCE(used_at, rejected_at, cancelled_at, expires_at) >= ?");
            rewardValues.push(input.startIso);
        }
        if (input.endIso) {
            drinkClauses.push("recorded_at < ?");
            drinkValues.push(input.endIso);
            rewardClauses.push("COALESCE(used_at, rejected_at, cancelled_at, expires_at) < ?");
            rewardValues.push(input.endIso);
        }
        const drinkRow = await this.database
            .prepare(`SELECT
           COALESCE(sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS drink_records,
           COALESCE(sum(CASE WHEN status = 'active' AND is_alcoholic = ${this.database.dialect === 'postgres' ? 'true' : '1'} THEN quantity ELSE 0 END), 0) AS alcoholic_drinks,
           COALESCE(sum(CASE WHEN status = 'active' THEN points_awarded ELSE 0 END), 0) AS points_issued
         FROM pint_point_drink_records
         WHERE ${drinkClauses.join(" AND ")}`)
            .get(...drinkValues) as {
            drink_records: number;
            alcoholic_drinks: number;
            points_issued: number;
        } | undefined;
        const rewardRow = await this.database
            .prepare(`SELECT
           COALESCE(sum(CASE WHEN status = 'used' THEN 1 ELSE 0 END), 0) AS redeemed,
           COALESCE(sum(CASE WHEN status IN ('expired', 'rejected') THEN 1 ELSE 0 END), 0) AS failed
         FROM free_pint_reward_codes
         WHERE ${rewardClauses.join(" AND ")}`)
            .get(...rewardValues) as {
            redeemed: number;
            failed: number;
        } | undefined;
        return {
            pointsIssued: Number(drinkRow?.points_issued ?? 0),
            drinkRecords: Number(drinkRow?.drink_records ?? 0),
            alcoholicDrinks: Number(drinkRow?.alcoholic_drinks ?? 0),
            freeRewardsRedeemed: Number(rewardRow?.redeemed ?? 0),
            expiredOrRejectedCodes: Number(rewardRow?.failed ?? 0),
        };
    }
}
