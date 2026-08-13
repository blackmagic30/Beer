import { CURRENT_LEGAL_POLICY_VERSION } from "../config/legal.js";
import { redactSecrets } from "../lib/redact.js";
import type { SqlDatabase, SqlRunResult } from "./sql-database.js";

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_PROFILE_TEXT_LENGTH = 320;
const MAX_AVATAR_URL_LENGTH = 2_048;
const MAX_PREFERENCE_ITEMS = 20;
const MAX_PREFERENCE_ITEM_LENGTH = 80;
const MAX_SAVED_ITEM_TEXT_LENGTH = 180;
const MAX_SAVED_METADATA_JSON_LENGTH = 16_384;
const MAX_RECENT_SEARCH_LIMIT = 100;
const EFFECTIVELY_UNBOUNDED_QUERY_LIMIT = 2_147_483_647;

export const ACCOUNT_PROFILE_PREFERENCES_CONTRACT_VERSION = "2026-08-08";
export const RECENT_SEARCH_UNBOUNDED_LIMIT = -1;
export const ACCOUNT_PROFILE_PREFERENCES_TABLES = Object.freeze([
  "accounts",
  "profiles",
  "account_preferences",
  "account_privacy_settings",
  "saved_items",
  "events",
] as const);

export type AccountProfileRole = "user" | "admin" | "venue_manager";
export type AccountProfileStatus = "active" | "warned" | "suspended";
export type AccountAgeVerificationStatus =
  | "not_started"
  | "pending"
  | "verified"
  | "rejected"
  | "expired";
export type SavedItemType = "venue" | "beer" | "suburb" | "night_plan";
export type AccountPrivacyEventScope = "optional_analytics" | "venue_insight";
export type AccountPreferredUseCase =
  | "cheapest_beer"
  | "happy_hours"
  | "specific_beers"
  | "recently_verified"
  | "contributing_data";

export interface AccountProfile {
  id: string;
  publicAccountId: string | null;
  email: string | null;
  displayName: string | null;
  displayNameKey: string | null;
  username: string | null;
  avatarUrl: string | null;
  role: AccountProfileRole;
  accountStatus: AccountProfileStatus;
  ageVerificationStatus: AccountAgeVerificationStatus;
  isOver18Verified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccountPreferences {
  userId: string;
  preferredSuburbs: string[];
  preferredBeers: string[];
  preferredUseCases: AccountPreferredUseCase[];
  onboardingCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountPrivacySettings {
  userId: string;
  optionalAnalyticsEnabled: boolean;
  venueReportInclusionEnabled: boolean;
  productResearchEnabled: boolean;
  emailUpdatesEnabled: boolean;
  consentVersion: string;
  consentedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedItem {
  id: string;
  userId: string;
  itemType: SavedItemType;
  itemId: string;
  label: string;
  suburb: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RecentSearch {
  eventType: "search_performed" | "beer_search_performed" | "suburb_search_performed";
  label: string;
  suburb: string | null;
  createdAt: string;
}

export interface UpsertAccountProfileInput {
  id: string;
  publicAccountId?: string | null | undefined;
  email: string | null;
  displayName: string | null;
  displayNameKey?: string | null | undefined;
  username: string | null;
  avatarUrl: string | null;
  role: AccountProfileRole;
  accountStatus: AccountProfileStatus;
  ageVerificationStatus: AccountAgeVerificationStatus;
  isOver18Verified: boolean;
  now: string;
}

export interface UpsertAccountPreferencesInput {
  userId: string;
  preferredSuburbs: string[];
  preferredBeers: string[];
  preferredUseCases: AccountPreferredUseCase[];
  onboardingCompletedAt: string | null;
  now: string;
  /** Null creates only; a timestamp conditionally updates exactly that revision. */
  expectedUpdatedAt: string | null;
}

export interface UpsertAccountPrivacySettingsInput {
  userId: string;
  optionalAnalyticsEnabled: boolean;
  venueReportInclusionEnabled: boolean;
  productResearchEnabled: boolean;
  emailUpdatesEnabled: boolean;
  consentVersion: string;
  now: string;
  /** Null creates only; a timestamp conditionally updates exactly that revision. */
  expectedUpdatedAt: string | null;
}

export interface SaveItemInput {
  id: string;
  userId: string;
  itemType: SavedItemType;
  itemId: string;
  label: string;
  suburb: string | null;
  metadata: Record<string, unknown>;
  now: string;
}

export type AccountProfilePreferencesRepositoryErrorCode =
  | "invalid_input"
  | "account_not_found"
  | "write_conflict"
  | "stored_data_invalid"
  | "persistence_failed";

const ERROR_MESSAGES: Readonly<Record<AccountProfilePreferencesRepositoryErrorCode, string>> = {
  invalid_input: "The account profile or preference input is invalid.",
  account_not_found: "The account does not exist.",
  write_conflict: "The account preference revision has changed.",
  stored_data_invalid: "Stored account profile or preference data is invalid.",
  persistence_failed: "The account profile or preference change could not be persisted.",
};

/** Stable failures never interpolate account identifiers, metadata, or database details. */
export class AccountProfilePreferencesRepositoryError extends Error {
  readonly code: AccountProfilePreferencesRepositoryErrorCode;

  constructor(code: AccountProfilePreferencesRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AccountProfilePreferencesRepositoryError";
    this.code = code;
  }
}

interface ProfileRow extends Record<string, unknown> {
  id: string;
  public_account_id: string | null;
  email: string | null;
  display_name: string | null;
  display_name_key: string | null;
  username: string | null;
  avatar_url: string | null;
  role: string;
  account_status: string;
  age_verification_status: string;
  is_over_18_verified: boolean | number;
  created_at: string;
  updated_at: string;
}

interface AccountPreferencesRow extends Record<string, unknown> {
  user_id: string;
  preferred_suburbs_json: string;
  preferred_beers_json: string;
  preferred_use_cases_json: string;
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AccountPrivacySettingsRow extends Record<string, unknown> {
  user_id: string;
  optional_analytics_enabled: boolean | number;
  venue_report_inclusion_enabled: boolean | number;
  product_research_enabled: boolean | number;
  email_updates_enabled: boolean | number;
  consent_version: string;
  consented_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SavedItemRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  item_type: string;
  item_id: string;
  label: string;
  suburb: string | null;
  metadata_json: string;
  created_at: string;
}

interface RecentSearchRow extends Record<string, unknown> {
  id: string;
  event_type: string;
  suburb: string | null;
  metadata_json: string;
  created_at: string;
}

function invalidInput(): never {
  throw new AccountProfilePreferencesRepositoryError("invalid_input");
}

function storedDataInvalid(): never {
  throw new AccountProfilePreferencesRepositoryError("stored_data_invalid");
}

function requireIdentifier(value: string): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > MAX_IDENTIFIER_LENGTH
    || /[\r\n\0]/.test(value)
  ) invalidInput();
  return value;
}

function requireCanonicalUtc(value: string): string {
  try {
    if (
      typeof value !== "string"
      || !CANONICAL_UTC_TIMESTAMP.test(value)
      || new Date(value).toISOString() !== value
    ) invalidInput();
    return value;
  } catch {
    return invalidInput();
  }
}

function requireStoredCanonicalUtc(value: unknown): string {
  try {
    if (
      typeof value !== "string"
      || !CANONICAL_UTC_TIMESTAMP.test(value)
      || new Date(value).toISOString() !== value
    ) storedDataInvalid();
    return value;
  } catch {
    return storedDataInvalid();
  }
}

function requireNullableInputText(
  value: string | null | undefined,
  maximumLength: number,
): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximumLength
    || /[\r\n\0]/.test(value)
  ) invalidInput();
  return value;
}

function requireInputText(value: string, maximumLength: number): string {
  const required = requireNullableInputText(value, maximumLength);
  if (required === null) invalidInput();
  return required;
}

function requireStoredNullableText(value: unknown, maximumLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximumLength || /[\r\n\0]/.test(value)) {
    storedDataInvalid();
  }
  return value;
}

function requireStoredText(value: unknown, maximumLength: number): string {
  const required = requireStoredNullableText(value, maximumLength);
  if (required === null || !required || required !== required.trim()) storedDataInvalid();
  return required;
}

function requireEnum<Value extends string>(value: string, allowed: readonly Value[]): Value {
  if (!(allowed as readonly string[]).includes(value)) invalidInput();
  return value as Value;
}

function requireStoredEnum<Value extends string>(value: unknown, allowed: readonly Value[]): Value {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) storedDataInvalid();
  return value as Value;
}

function requireStringList<Value extends string>(
  value: Value[],
  allowed?: readonly Value[],
): Value[] {
  if (!Array.isArray(value) || value.length > MAX_PREFERENCE_ITEMS) invalidInput();
  const seen = new Set<string>();
  const result = value.map((entry) => {
    if (
      typeof entry !== "string"
      || !entry
      || entry !== entry.trim()
      || entry.length > MAX_PREFERENCE_ITEM_LENGTH
      || /[\r\n\0]/.test(entry)
      || seen.has(entry)
      || (allowed && !(allowed as readonly string[]).includes(entry))
    ) invalidInput();
    seen.add(entry);
    return entry;
  });
  return result;
}

function assertJsonValue(value: unknown, depth = 0): void {
  if (depth > 8) invalidInput();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidInput();
    return;
  }
  if (typeof value === "string") {
    if (value.length > 2_000 || /\0/.test(value)) invalidInput();
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) invalidInput();
    for (const entry of value) assertJsonValue(entry, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidInput();
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 50) invalidInput();
    for (const [key, entry] of entries) {
      if (!key || key.length > 100 || /[\r\n\0]/.test(key)) invalidInput();
      assertJsonValue(entry, depth + 1);
    }
    return;
  }
  invalidInput();
}

function serializeMetadata(value: Record<string, unknown>): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidInput();
  assertJsonValue(value);
  try {
    const serialized = JSON.stringify(redactSecrets(value));
    if (!serialized || serialized.length > MAX_SAVED_METADATA_JSON_LENGTH) invalidInput();
    return serialized;
  } catch {
    return invalidInput();
  }
}

function parseStoredStringArray<Value extends string>(
  value: string,
  allowed?: readonly Value[],
): Value[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length > MAX_PREFERENCE_ITEMS
      || !parsed.every((entry) => (
        typeof entry === "string"
        && entry.length > 0
        && entry.length <= MAX_PREFERENCE_ITEM_LENGTH
        && entry === entry.trim()
        && !/[\r\n\0]/.test(entry)
        && (!allowed || (allowed as readonly string[]).includes(entry))
      ))
    ) storedDataInvalid();
    return parsed as Value[];
  } catch (error) {
    if (error instanceof AccountProfilePreferencesRepositoryError) throw error;
    return storedDataInvalid();
  }
}

function parseStoredObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) storedDataInvalid();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AccountProfilePreferencesRepositoryError) throw error;
    return storedDataInvalid();
  }
}

function decodeBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return storedDataInvalid();
}

function validateExpectedRevision(now: string, expectedUpdatedAt: string | null): string | null {
  if (expectedUpdatedAt === null) return null;
  const expected = requireCanonicalUtc(expectedUpdatedAt);
  if (now <= expected) invalidInput();
  return expected;
}

const PROFILE_ROLES = ["user", "admin", "venue_manager"] as const;
const PROFILE_STATUSES = ["active", "warned", "suspended"] as const;
const AGE_VERIFICATION_STATUSES = ["not_started", "pending", "verified", "rejected", "expired"] as const;
const SAVED_ITEM_TYPES = ["venue", "beer", "suburb", "night_plan"] as const;
const PREFERRED_USE_CASES = [
  "cheapest_beer",
  "happy_hours",
  "specific_beers",
  "recently_verified",
  "contributing_data",
] as const;
const RECENT_SEARCH_EVENT_TYPES = [
  "search_performed",
  "beer_search_performed",
  "suburb_search_performed",
] as const;

function decodeProfile(row: ProfileRow): AccountProfile {
  return {
    id: requireStoredText(row.id, MAX_IDENTIFIER_LENGTH),
    publicAccountId: requireStoredNullableText(row.public_account_id, MAX_PROFILE_TEXT_LENGTH),
    email: requireStoredNullableText(row.email, MAX_PROFILE_TEXT_LENGTH),
    displayName: requireStoredNullableText(row.display_name, MAX_PROFILE_TEXT_LENGTH),
    displayNameKey: requireStoredNullableText(row.display_name_key, MAX_PROFILE_TEXT_LENGTH),
    username: requireStoredNullableText(row.username, MAX_PROFILE_TEXT_LENGTH),
    avatarUrl: requireStoredNullableText(row.avatar_url, MAX_AVATAR_URL_LENGTH),
    role: requireStoredEnum(row.role, PROFILE_ROLES),
    accountStatus: requireStoredEnum(row.account_status, PROFILE_STATUSES),
    ageVerificationStatus: requireStoredEnum(row.age_verification_status, AGE_VERIFICATION_STATUSES),
    isOver18Verified: decodeBoolean(row.is_over_18_verified),
    createdAt: requireStoredCanonicalUtc(row.created_at),
    updatedAt: requireStoredCanonicalUtc(row.updated_at),
  };
}

function decodePreferences(row: AccountPreferencesRow): AccountPreferences {
  return {
    userId: requireStoredText(row.user_id, MAX_IDENTIFIER_LENGTH),
    preferredSuburbs: parseStoredStringArray(row.preferred_suburbs_json),
    preferredBeers: parseStoredStringArray(row.preferred_beers_json),
    preferredUseCases: parseStoredStringArray(row.preferred_use_cases_json, PREFERRED_USE_CASES),
    onboardingCompletedAt: row.onboarding_completed_at === null
      ? null
      : requireStoredCanonicalUtc(row.onboarding_completed_at),
    createdAt: requireStoredCanonicalUtc(row.created_at),
    updatedAt: requireStoredCanonicalUtc(row.updated_at),
  };
}

function decodePrivacySettings(row: AccountPrivacySettingsRow): AccountPrivacySettings {
  return {
    userId: requireStoredText(row.user_id, MAX_IDENTIFIER_LENGTH),
    optionalAnalyticsEnabled: decodeBoolean(row.optional_analytics_enabled),
    venueReportInclusionEnabled: decodeBoolean(row.venue_report_inclusion_enabled),
    productResearchEnabled: decodeBoolean(row.product_research_enabled),
    emailUpdatesEnabled: decodeBoolean(row.email_updates_enabled),
    consentVersion: requireStoredText(row.consent_version, 40),
    consentedAt: row.consented_at === null ? null : requireStoredCanonicalUtc(row.consented_at),
    createdAt: requireStoredCanonicalUtc(row.created_at),
    updatedAt: requireStoredCanonicalUtc(row.updated_at),
  };
}

function decodeSavedItem(row: SavedItemRow): SavedItem {
  return {
    id: requireStoredText(row.id, MAX_IDENTIFIER_LENGTH),
    userId: requireStoredText(row.user_id, MAX_IDENTIFIER_LENGTH),
    itemType: requireStoredEnum(row.item_type, SAVED_ITEM_TYPES),
    itemId: requireStoredText(row.item_id, MAX_SAVED_ITEM_TEXT_LENGTH),
    label: requireStoredText(row.label, MAX_SAVED_ITEM_TEXT_LENGTH),
    suburb: requireStoredNullableText(row.suburb, MAX_SAVED_ITEM_TEXT_LENGTH),
    metadata: parseStoredObject(row.metadata_json),
    createdAt: requireStoredCanonicalUtc(row.created_at),
  };
}

export class AccountProfilePreferencesRepository {
  constructor(private readonly database: SqlDatabase) {}

  private one<Row extends Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row | undefined> {
    return this.database.prepare(sql).get<Row>(...bindings);
  }

  private all<Row extends Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row[]> {
    return this.database.prepare(sql).all<Row>(...bindings);
  }

  private run(sql: string, ...bindings: unknown[]): Promise<SqlRunResult> {
    return this.database.prepare(sql).run(...bindings);
  }

  private booleanBinding(value: boolean): boolean | number {
    return this.database.dialect === "postgres" ? value : value ? 1 : 0;
  }

  private async withStableErrors<Result>(work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AccountProfilePreferencesRepositoryError) throw error;
      throw new AccountProfilePreferencesRepositoryError("persistence_failed");
    }
  }

  private async lockAccount(userId: string): Promise<void> {
    const rowLock = this.database.dialect === "postgres" ? " FOR KEY SHARE" : "";
    const account = await this.one<{ id: string }>(
      `SELECT id FROM accounts WHERE id = ?${rowLock}`,
      userId,
    );
    if (!account) throw new AccountProfilePreferencesRepositoryError("account_not_found");
  }

  private profileSql(): string {
    return `SELECT id, public_account_id, email, display_name, display_name_key,
                   username, avatar_url, role, account_status, age_verification_status,
                   is_over_18_verified, created_at, updated_at
              FROM profiles WHERE id = ?`;
  }

  private preferencesSql(): string {
    return `SELECT user_id, preferred_suburbs_json, preferred_beers_json,
                   preferred_use_cases_json, onboarding_completed_at, created_at, updated_at
              FROM account_preferences WHERE user_id = ?`;
  }

  private privacySettingsSql(): string {
    return `SELECT user_id, optional_analytics_enabled, venue_report_inclusion_enabled,
                   product_research_enabled, email_updates_enabled, consent_version,
                   consented_at, created_at, updated_at
              FROM account_privacy_settings WHERE user_id = ?`;
  }

  private savedItemProjection(): string {
    return `id, user_id, item_type, item_id, label, suburb, metadata_json, created_at`;
  }

  async upsertProfile(input: UpsertAccountProfileInput): Promise<AccountProfile> {
    const id = requireIdentifier(input.id);
    const publicAccountId = requireNullableInputText(input.publicAccountId, MAX_PROFILE_TEXT_LENGTH);
    const email = requireNullableInputText(input.email, MAX_PROFILE_TEXT_LENGTH);
    const displayName = requireNullableInputText(input.displayName, MAX_PROFILE_TEXT_LENGTH);
    const displayNameKey = requireNullableInputText(input.displayNameKey, MAX_PROFILE_TEXT_LENGTH);
    const username = requireNullableInputText(input.username, MAX_PROFILE_TEXT_LENGTH);
    const avatarUrl = requireNullableInputText(input.avatarUrl, MAX_AVATAR_URL_LENGTH);
    const role = requireEnum(input.role, PROFILE_ROLES);
    const accountStatus = requireEnum(input.accountStatus, PROFILE_STATUSES);
    const ageVerificationStatus = requireEnum(input.ageVerificationStatus, AGE_VERIFICATION_STATUSES);
    if (typeof input.isOver18Verified !== "boolean") invalidInput();
    const now = requireCanonicalUtc(input.now);

    return this.withStableErrors(() => this.database.transaction(async () => {
      await this.lockAccount(id);
      const row = await this.one<ProfileRow>(
        `INSERT INTO profiles (
           id, public_account_id, email, display_name, display_name_key, username,
           avatar_url, role, account_status, age_verification_status,
           is_over_18_verified, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           public_account_id = COALESCE(excluded.public_account_id, profiles.public_account_id),
           email = excluded.email,
           display_name = excluded.display_name,
           display_name_key = excluded.display_name_key,
           avatar_url = excluded.avatar_url,
           role = excluded.role,
           account_status = excluded.account_status,
           age_verification_status = excluded.age_verification_status,
           is_over_18_verified = excluded.is_over_18_verified,
           updated_at = excluded.updated_at
         RETURNING id, public_account_id, email, display_name, display_name_key,
                   username, avatar_url, role, account_status, age_verification_status,
                   is_over_18_verified, created_at, updated_at`,
        id,
        publicAccountId,
        email,
        displayName,
        displayNameKey,
        username,
        avatarUrl,
        role,
        accountStatus,
        ageVerificationStatus,
        this.booleanBinding(input.isOver18Verified),
        now,
        now,
      );
      if (!row) throw new AccountProfilePreferencesRepositoryError("persistence_failed");
      return decodeProfile(row);
    })());
  }

  async getProfileById(idInput: string): Promise<AccountProfile | null> {
    const id = requireIdentifier(idInput);
    return this.withStableErrors(async () => {
      const row = await this.one<ProfileRow>(this.profileSql(), id);
      return row ? decodeProfile(row) : null;
    });
  }

  async getAccountPreferences(userIdInput: string): Promise<AccountPreferences | null> {
    const userId = requireIdentifier(userIdInput);
    return this.withStableErrors(async () => {
      const row = await this.one<AccountPreferencesRow>(this.preferencesSql(), userId);
      return row ? decodePreferences(row) : null;
    });
  }

  async upsertAccountPreferences(input: UpsertAccountPreferencesInput): Promise<AccountPreferences> {
    const userId = requireIdentifier(input.userId);
    const preferredSuburbs = requireStringList(input.preferredSuburbs);
    const preferredBeers = requireStringList(input.preferredBeers);
    const preferredUseCases = requireStringList(input.preferredUseCases, PREFERRED_USE_CASES);
    const onboardingCompletedAt = input.onboardingCompletedAt === null
      ? null
      : requireCanonicalUtc(input.onboardingCompletedAt);
    const now = requireCanonicalUtc(input.now);
    const expectedUpdatedAt = validateExpectedRevision(now, input.expectedUpdatedAt);
    const suburbsJson = JSON.stringify(preferredSuburbs);
    const beersJson = JSON.stringify(preferredBeers);
    const useCasesJson = JSON.stringify(preferredUseCases);

    return this.withStableErrors(() => this.database.transaction(async () => {
      await this.lockAccount(userId);
      const row = expectedUpdatedAt === null
        ? await this.one<AccountPreferencesRow>(
            `INSERT INTO account_preferences (
               user_id, preferred_suburbs_json, preferred_beers_json,
               preferred_use_cases_json, onboarding_completed_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO NOTHING
             RETURNING user_id, preferred_suburbs_json, preferred_beers_json,
                       preferred_use_cases_json, onboarding_completed_at, created_at, updated_at`,
            userId,
            suburbsJson,
            beersJson,
            useCasesJson,
            onboardingCompletedAt,
            now,
            now,
          )
        : await this.one<AccountPreferencesRow>(
            `UPDATE account_preferences
                SET preferred_suburbs_json = ?, preferred_beers_json = ?,
                    preferred_use_cases_json = ?,
                    onboarding_completed_at = COALESCE(?, onboarding_completed_at),
                    updated_at = ?
              WHERE user_id = ? AND updated_at = ?
              RETURNING user_id, preferred_suburbs_json, preferred_beers_json,
                        preferred_use_cases_json, onboarding_completed_at, created_at, updated_at`,
            suburbsJson,
            beersJson,
            useCasesJson,
            onboardingCompletedAt,
            now,
            userId,
            expectedUpdatedAt,
          );
      if (!row) throw new AccountProfilePreferencesRepositoryError("write_conflict");
      return decodePreferences(row);
    })());
  }

  async getAccountPrivacySettings(userIdInput: string): Promise<AccountPrivacySettings | null> {
    const userId = requireIdentifier(userIdInput);
    return this.withStableErrors(async () => {
      const row = await this.one<AccountPrivacySettingsRow>(this.privacySettingsSql(), userId);
      return row ? decodePrivacySettings(row) : null;
    });
  }

  async getDefaultAccountPrivacySettings(
    userIdInput: string,
    nowInput = new Date().toISOString(),
  ): Promise<AccountPrivacySettings> {
    const userId = requireIdentifier(userIdInput);
    const now = requireCanonicalUtc(nowInput);
    return {
      userId,
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
      consentVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async upsertAccountPrivacySettings(
    input: UpsertAccountPrivacySettingsInput,
  ): Promise<AccountPrivacySettings> {
    const userId = requireIdentifier(input.userId);
    for (const value of [
      input.optionalAnalyticsEnabled,
      input.venueReportInclusionEnabled,
      input.productResearchEnabled,
      input.emailUpdatesEnabled,
    ]) if (typeof value !== "boolean") invalidInput();
    if (!input.optionalAnalyticsEnabled && input.venueReportInclusionEnabled) invalidInput();
    const consentVersion = requireInputText(input.consentVersion, 40);
    const now = requireCanonicalUtc(input.now);
    const expectedUpdatedAt = validateExpectedRevision(now, input.expectedUpdatedAt);
    const scopes: AccountPrivacyEventScope[] = !input.optionalAnalyticsEnabled
      ? ["optional_analytics", "venue_insight"]
      : !input.venueReportInclusionEnabled
        ? ["venue_insight"]
        : [];

    return this.withStableErrors(() => this.database.transaction(async () => {
      await this.lockAccount(userId);
      const bindings = [
        this.booleanBinding(input.optionalAnalyticsEnabled),
        this.booleanBinding(input.venueReportInclusionEnabled),
        this.booleanBinding(input.productResearchEnabled),
        this.booleanBinding(input.emailUpdatesEnabled),
        consentVersion,
        now,
      ];
      const row = expectedUpdatedAt === null
        ? await this.one<AccountPrivacySettingsRow>(
            `INSERT INTO account_privacy_settings (
               user_id, optional_analytics_enabled, venue_report_inclusion_enabled,
               product_research_enabled, email_updates_enabled, consent_version,
               consented_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO NOTHING
             RETURNING user_id, optional_analytics_enabled, venue_report_inclusion_enabled,
                       product_research_enabled, email_updates_enabled, consent_version,
                       consented_at, created_at, updated_at`,
            userId,
            ...bindings,
            now,
            now,
          )
        : await this.one<AccountPrivacySettingsRow>(
            `UPDATE account_privacy_settings
                SET optional_analytics_enabled = ?, venue_report_inclusion_enabled = ?,
                    product_research_enabled = ?, email_updates_enabled = ?,
                    consent_version = ?, consented_at = ?, updated_at = ?
              WHERE user_id = ? AND updated_at = ?
              RETURNING user_id, optional_analytics_enabled, venue_report_inclusion_enabled,
                        product_research_enabled, email_updates_enabled, consent_version,
                        consented_at, created_at, updated_at`,
            ...bindings,
            now,
            userId,
            expectedUpdatedAt,
          );
      if (!row) throw new AccountProfilePreferencesRepositoryError("write_conflict");

      if (scopes.length > 0) {
        const placeholders = scopes.map(() => "?").join(", ");
        const privacyScopeExpression = this.database.dialect === "postgres"
          ? "metadata_json ->> 'privacyScope'"
          : "CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.privacyScope') ELSE '__pintpath_invalid_json__' END";
        const invalidJsonClause = this.database.dialect === "postgres"
          ? ""
          : " OR CASE WHEN json_valid(metadata_json) THEN NULL ELSE '__pintpath_invalid_json__' END = '__pintpath_invalid_json__'";
        await this.run(
          `DELETE FROM events
            WHERE user_id = ?
              AND (${privacyScopeExpression} IN (${placeholders})${invalidJsonClause})`,
          userId,
          ...scopes,
        );
      }
      return decodePrivacySettings(row);
    })());
  }

  async saveItem(input: SaveItemInput): Promise<SavedItem> {
    const id = requireIdentifier(input.id);
    const userId = requireIdentifier(input.userId);
    const itemType = requireEnum(input.itemType, SAVED_ITEM_TYPES);
    const itemId = requireInputText(input.itemId, MAX_SAVED_ITEM_TEXT_LENGTH);
    const label = requireInputText(input.label, MAX_SAVED_ITEM_TEXT_LENGTH);
    const suburb = requireNullableInputText(input.suburb, MAX_SAVED_ITEM_TEXT_LENGTH);
    const metadataJson = serializeMetadata(input.metadata);
    const now = requireCanonicalUtc(input.now);

    return this.withStableErrors(() => this.database.transaction(async () => {
      await this.lockAccount(userId);
      const row = await this.one<SavedItemRow>(
        `INSERT INTO saved_items (
           id, user_id, item_type, item_id, label, suburb, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET
           label = excluded.label,
           suburb = excluded.suburb,
           metadata_json = excluded.metadata_json
         RETURNING ${this.savedItemProjection()}`,
        id,
        userId,
        itemType,
        itemId,
        label,
        suburb,
        metadataJson,
        now,
      );
      if (!row) throw new AccountProfilePreferencesRepositoryError("persistence_failed");
      return decodeSavedItem(row);
    })());
  }

  async removeSavedItem(input: {
    userId: string;
    itemType: SavedItemType;
    itemId: string;
  }): Promise<boolean> {
    const userId = requireIdentifier(input.userId);
    const itemType = requireEnum(input.itemType, SAVED_ITEM_TYPES);
    const itemId = requireInputText(input.itemId, MAX_SAVED_ITEM_TEXT_LENGTH);
    return this.withStableErrors(async () => (
      await this.run(
        "DELETE FROM saved_items WHERE user_id = ? AND item_type = ? AND item_id = ?",
        userId,
        itemType,
        itemId,
      )
    ).changes > 0);
  }

  async listSavedItems(userIdInput: string): Promise<SavedItem[]> {
    const userId = requireIdentifier(userIdInput);
    return this.withStableErrors(async () => (
      await this.all<SavedItemRow>(
        `SELECT ${this.savedItemProjection()} FROM saved_items
          WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
        userId,
      )
    ).map(decodeSavedItem));
  }

  async listRecentSearches(userIdInput: string, limitInput: number): Promise<RecentSearch[]> {
    const userId = requireIdentifier(userIdInput);
    if (
      !Number.isSafeInteger(limitInput)
      || (limitInput !== RECENT_SEARCH_UNBOUNDED_LIMIT
        && (limitInput < 0 || limitInput > MAX_RECENT_SEARCH_LIMIT))
    ) invalidInput();
    const limit = limitInput === RECENT_SEARCH_UNBOUNDED_LIMIT
      ? EFFECTIVELY_UNBOUNDED_QUERY_LIMIT
      : limitInput;

    return this.withStableErrors(async () => {
      const rows = await this.all<RecentSearchRow>(
        `SELECT id, event_type, suburb, metadata_json, created_at
           FROM events
          WHERE user_id = ?
            AND event_type IN ('search_performed', 'beer_search_performed', 'suburb_search_performed')
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        userId,
        limit,
      );
      return rows.map((row) => {
        const eventType = requireStoredEnum(row.event_type, RECENT_SEARCH_EVENT_TYPES);
        const metadata = parseStoredObject(row.metadata_json);
        return {
          eventType,
          label: String(metadata.query || metadata.label || row.suburb || eventType),
          suburb: requireStoredNullableText(row.suburb, MAX_SAVED_ITEM_TEXT_LENGTH),
          createdAt: requireStoredCanonicalUtc(row.created_at),
        };
      });
    });
  }
}
