import { z } from "zod";

import {
  canonicalPostgresLogicalStateJson,
  sha256CanonicalPostgresLogicalState,
} from "./postgres-logical-state.js";

export const POSTGRES_DATABASE_IDENTITY_KIND =
  "pintpath-postgres-logical-source-database" as const;
export const POSTGRES_DATABASE_IDENTITY_VERSION = 1 as const;

const decimalIdentifierSchema = z.string().regex(/^\d+$/);
const databaseNameSchema = z.string()
  .min(1)
  .max(63)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));

export const postgresDatabaseIdentityFieldsSchema = z.object({
  systemIdentifier: decimalIdentifierSchema,
  databaseOid: decimalIdentifierSchema,
  databaseName: databaseNameSchema,
  serverVersionNum: z.string().regex(/^17\d{4}$/),
}).strict();

export type PostgresDatabaseIdentityFields = z.infer<
  typeof postgresDatabaseIdentityFieldsSchema
>;

export const postgresDatabaseIdentitySchema = z.object({
  kind: z.literal(POSTGRES_DATABASE_IDENTITY_KIND),
  version: z.literal(POSTGRES_DATABASE_IDENTITY_VERSION),
  systemIdentifier: decimalIdentifierSchema,
  databaseOid: decimalIdentifierSchema,
  databaseName: databaseNameSchema,
  serverVersionNum: z.string().regex(/^17\d{4}$/),
}).strict();

export type PostgresDatabaseIdentity = z.infer<
  typeof postgresDatabaseIdentitySchema
>;

/**
 * Projects a role-bearing catalog row onto the canonical physical database
 * identity. Login and effective-role fields are deliberately outside the hash
 * domain so independently scoped roles bind to the same physical database.
 */
export function buildPostgresDatabaseIdentity(
  value: PostgresDatabaseIdentityFields,
): PostgresDatabaseIdentity {
  return postgresDatabaseIdentitySchema.parse({
    kind: POSTGRES_DATABASE_IDENTITY_KIND,
    version: POSTGRES_DATABASE_IDENTITY_VERSION,
    systemIdentifier: value.systemIdentifier,
    databaseOid: value.databaseOid,
    databaseName: value.databaseName,
    serverVersionNum: value.serverVersionNum,
  });
}

export function parsePostgresDatabaseIdentity(
  value: unknown,
): PostgresDatabaseIdentity {
  return postgresDatabaseIdentitySchema.parse(value);
}

export function canonicalPostgresDatabaseIdentityJson(
  value: PostgresDatabaseIdentity,
): string {
  return canonicalPostgresLogicalStateJson(
    parsePostgresDatabaseIdentity(value),
  );
}

export function sha256PostgresDatabaseIdentity(
  value: PostgresDatabaseIdentityFields,
): string {
  return sha256CanonicalPostgresLogicalState(
    buildPostgresDatabaseIdentity(value),
  );
}
