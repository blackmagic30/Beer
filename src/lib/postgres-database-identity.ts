import { z } from "zod";

import {
  sha256PostgresMigrationBytes,
} from "../db/postgres-migration-schema.js";

const JSON_OBJECT = JSON;
const JSON_STRINGIFY = JSON.stringify;
const REFLECT_APPLY = Reflect.apply;
const TYPE_ERROR = TypeError;

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
  const identity = parsePostgresDatabaseIdentity(value);
  const encode = (input: string): string => {
    const encoded = REFLECT_APPLY(JSON_STRINGIFY, JSON_OBJECT, [input]);
    if (typeof encoded !== "string") throw new TYPE_ERROR("database_identity_invalid");
    return encoded;
  };
  return `{"databaseName":${encode(identity.databaseName)},`
    + `"databaseOid":${encode(identity.databaseOid)},`
    + `"kind":${encode(identity.kind)},`
    + `"serverVersionNum":${encode(identity.serverVersionNum)},`
    + `"systemIdentifier":${encode(identity.systemIdentifier)},`
    + `"version":1}\n`;
}

export function sha256PostgresDatabaseIdentity(
  value: PostgresDatabaseIdentityFields,
): string {
  return sha256PostgresMigrationBytes(canonicalPostgresDatabaseIdentityJson(
    buildPostgresDatabaseIdentity(value),
  ));
}
