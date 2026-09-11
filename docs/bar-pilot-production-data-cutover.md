# Bar pilot production data cutover

This is preparation for the authorised bar pilot, not a claim that production
has migrated. Production writes and the connection switch wait for the staged
hosted acceptance and recovery gates. Do not copy staging accounts, test points
or synthetic venue data into production.

## What exists and what was observed

The existing `scripts/postgres-migration.ts` owns the unsanitized source snapshot,
deterministic plan, restricted import and independent verification. Reuse it.
The checked-in migration/recovery tests and historical staging import prove the
implementation; they do not prove a production import or production rollback.

Read-only observations on 11 September 2026:

- Production Beer remains deployment `a171afac-9104-41ca-b0c2-d50bfc47824a`,
  source `95b9f2da5e9a99692c8cfafba90d2c29e63ccbc8`. Its SQLite source is schema
  **11**, with **55 tables, 8 accounts, 319 price records and 39 venue profiles**.
  `quick_check` passed and `foreign_key_check` returned zero violations. These
  are live aggregate observations, not a frozen snapshot or data reconciliation.
- The candidate importer requires the exact schema-16 conversion contract.
  Calling its snapshot command directly on the live schema-11 source must fail.
- A private point-in-time rehearsal showed that the existing additive upgrade
  reaches version 16 but retains 59 tables, 776 columns and 64 foreign keys.
  The three extra tables are `beer_price_results`, `call_runs` and `call_sessions`;
  canonical tables also retain historical column order, defaults, numeric
  affinities and missing foreign keys. Version 16 alone is not import authority.
  The scoped `normalize-source` preparation now converts only that exact reviewed
  physical fingerprint into a new canonical copy. Its real-copy rehearsal passed
  on 11 September at 09:24 UTC: all 56 canonical tables reconciled by full values,
  keys and counts; 252 legacy price-result rows and 597 call-run rows were
  preserved cell-for-cell in the existing quarantine history. No call-session
  rows existed. The final copy matched 56 tables, 717 columns and 76 foreign keys;
  integrity and foreign-key checks passed. Production and its sealed copy were
  unchanged and every private temporary copy was removed. This proves conversion
  compatibility, not final source freshness, native import or production recovery.
- Production PostgreSQL service `4a2334a1-71e7-4745-970a-2cd95da10169`, deployment
  `f31d3dbd-a997-42cf-b3a8-970b8c337841`, is PostgreSQL 17. Normal authorised
  Railway SSH can perform a catalog-only transaction using its existing local
  administration credential. The configured bootstrap database has no private
  application/operations schema; runtime and migrator groups each have a login
  member, and no maintenance group exists. A separate unique application target
  could not be established from the direct CONNECT-grant check. **Do not infer
  that the intended application database is empty or select the bootstrap
  database as the target on that basis.** Exact target identity is still required.
- The production app currently has `DATABASE_PATH`, not the canonical database
  URL/trust/identity settings. Existing Redis and Supabase credential names are
  present, but presence is not proof that a candidate configuration authenticates.
- Protected environment `production-postgres-migration-verifier-authority`
  currently has no secrets or variables. The production deployment environment
  has the three existing Railway metadata/deploy credential names. Values were
  not exported. Short-lived migration authority inputs are operator provisioning
  work after the preceding gates, not an assumed owner-only impossibility.

## Preservation and execution order

1. Complete the required staged hosted account/reward acceptance and recovery
   proof. Pin the reviewed current candidate and the exact production resources.
   Retain the current production image and source records, but do not call them
   a PostgreSQL-compatible rollback until the recovery procedure proves it.
2. Read and export the independent deletion-ledger authority with the existing
   `ledger-export` command while production still serves. Use the exact production
   and operational-copy origins and the scoped offsite server key. The export
   must contain mutually consistent genesis, checkpoint, current ledger and
   immutable-set bindings. This reads storage; it does not create an account.
3. In the approved cutover window, stop **every SQLite writer**, including HTTP
   mutations and legacy workers. Keep that freeze through final reconciliation
   and the connection switch. A worker feature flag alone does not prove HTTP
   writes stopped. Use SQLite's online backup API for an unsanitized cold copy
   and retain the source-evidence tree and deletion authority in private custody.
   Record the original bytes/hash before any transformation. Do not use
   `data:backup` or the automatic pre-migration backup as the import source: those
   intentionally sanitize account-deletion recipient ciphertext.
4. Upgrade a **separate private copy** from schema 11 to 16 with the existing
   `initializeDatabaseSchema` migration in `src/db/database.ts`. Never point it
   at the live source or sealed original. Close/checkpoint this isolated file,
   retain its hash, then run `normalize-source` below. Its exact recognized
   physical-schema fingerprint is checked in; an arbitrary observed file cannot
   register its own authority. The new copy retains every canonical value and
   archives every cell of the three named legacy tables, including typed binary,
   integer and floating values. It preserves privacy choices and historical
   timestamps rather than resetting them to new defaults. Unknown schema, unsafe
   numeric conversion, invalid new constraints or unexplained reconciliation
   fail closed. No existing destination is overwritten. Retain the sealed
   original, intermediate hash and normalization receipt in private custody.
5. Run the native `snapshot` command against the normalized copy and its retained
   evidence/deletion authority, then `plan`. The candidate-bound manifest commits
   to the unsanitized schema-16 source used for import. Preserve the original
   schema-11 copy separately for pre-switch recovery.
6. Establish the exact approved production database, strict pinned-CA transport
   and isolated runtime/migrator/maintenance roles. Inspect it before applying
   DDL. Apply the generated base schema and reviewed forward migrations in their
   prescribed order; never reset an occupied target. Provision the independently
   protected verifier authority with the existing workflow, then retire its
   short-lived provisioner before import. Import with the restricted migrator.
7. Execute `apply`, then `verify-target` with the existing independent Ed25519
   approval and key. Verify all tables, IDs, counts, transformed data, key ranges,
   foreign keys and state totals. An `awaiting-verification` apply receipt alone
   cannot open production. Keep secrets and raw database/evidence files out of
   GitHub artifacts; retain only the allowed native hash-bound receipts there.
8. Before switching app configuration, run the native receipt gate and the live
   runtime gate described below using the intended restricted connection. Prove
   canonical Redis and complete candidate environment validation as well. Keep
   the source freeze in force. Only then may the protected configuration/source
   path switch to the imported database. Prove all three runtime routes and the
   recovery procedure before opening ordinary mutations again.

## Existing callable commands

Use the exact full arguments in the [migration runbook](full-scale-postgres-migration-runbook.md#exact-importer-command-sequence).
The following are the existing commands, not replacement migration tools:

| Command | Purpose and execution boundary |
| --- | --- |
| `npm run db:postgres:schema:check` | Check generated DDL bytes locally. |
| `npm run db:postgres:migration:contract:check` | Check the reviewed source conversion contract locally. |
| `npm run db:postgres:migration -- ledger-export …` | Read the exact production deletion authority into private custody. |
| `npm run db:postgres:migration -- normalize-source …` | Prepare a new canonical copy from the exact reviewed, sealed legacy profile; preserve original values and obsolete rows. |
| `npm run db:postgres:migration -- snapshot …` | Capture the isolated upgraded source, under the real write-maintenance boundary. Requires `PINTPATH_SQLITE_WRITE_MAINTENANCE=confirmed`. |
| `npm run db:postgres:migration -- plan …` | Produce deterministic source/table/chunk hashes. |
| `npm run db:postgres:migration -- inspect-target …` | Read exact target, URL, TLS and live-schema authority; no import. |
| `provision-postgres-migration-verifier-authority.yml` | Existing protected, candidate-bound one-write verifier authority provisioner. |
| `npm run db:postgres:migration -- apply …` | Restricted target import; requires `PINTPATH_POSTGRES_MIGRATION_APPLY=confirmed`. |
| `npm run db:postgres:migration -- verify-target …` | Independent reconciliation and ready receipt; this finalizes target import metadata and is **not** a read-only preflight. |
| `node dist/scripts/verify-postgres-runtime.js` | Existing bounded restricted-runtime readiness probe on the approved private network. |
| `node dist/scripts/backup-postgres-logical.js …` | Existing PostgreSQL-17 logical archive/state capture after import, with pinned binaries, URL and root CA. |
| `node dist/scripts/restore-postgres-logical.js inspect-target …` / `restore …` | Existing isolated recovery target inspection/restore; see the [restore runbook](postgres-logical-restore-rehearsal.md). |

No command above has been executed as a production mutation for this preparation.

The source normalizer is an offline preparation command. Run it in the isolated
preparer with the existing schema initializer's ordinary local configuration,
not the production server process. Its explicit input must be the closed,
private **copy** after the additive upgrade, never the live database:

```sh
npm run db:postgres:migration -- normalize-source \
  --source-sqlite /absolute/private/release-id/upgraded-copy.sqlite \
  --source-sha256 <independently-recorded-upgraded-copy-sha256> \
  --output-dir /absolute/private/release-id/normalized-source \
  --candidate-sha <reviewed-current-main-sha> \
  --operator-id <private-authorised-operator-reference>
```

The resulting `pint-path.sqlite` and `normalization-receipt.json` stay private.
This receipt documents source preservation; it cannot replace the native
snapshot manifest, apply receipt, independent verification or source write freeze.

## Configuration inputs to prepare privately

- `DATABASE_URL` must contain the restricted runtime login; the separate
  `DATABASE_MAINTENANCE_URL` must use the same database with only the approved
  maintenance role. Both require the held Railway root CA PEM/DER pin and the
  existing `railway-stock-localhost-ca-v1` transport. Never reuse the admin URL.
- Provide `PINTPATH_EXPECTED_DATABASE_URL_SHA256`, actual/expected database
  resource IDs, forbidden database URL/resource sets and current permanent-
  staging exclusions. Derive pins from the independently verified intended
  target, not from an arbitrary configured URL. Clear the `DATABASE_PATH` value
  only at the guarded connection switch; its provider row, data files and volume
  remain intact.
- Keep the existing production Redis instance. Verify its credential/reference
  and prepare its expected URL digest, actual/expected resource IDs and staging
  exclusions. Set `REQUIRE_REDIS_RATE_LIMITING=true` and
  `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false`; do not create a local
  rate-limit fallback.
- Validate the entire candidate configuration through the existing `env.ts`
  checks with secrets held in process memory. Preserve primary/offsite Supabase,
  email, source-evidence and deletion-notice secrets. Missing sealed values in a
  CLI listing must not be mistaken for missing running values.
- Keep automatic maintenance fenced to the exact candidate and disabled until
  its approved activation. Keep unrelated paid/commercial features off.
  Production demo preparation stays disabled; enrol only approved real pilot
  venues when hosted account/venue acceptance is ready.
- Enabling production `BAR_PILOT_ENABLED` also requires the existing
  `ALCOHOL_PROMOTION_APPROVAL_REFERENCE` gate. The owner must supply a genuine
  approval reference after the appropriate alcohol-promotion/reward review;
  software tests do not create or establish that approval.
- The existing verifier workflow needs its target URL, root CA, separate opaque
  operator/verifier IDs, Ed25519 public key and target/URL/CA identity pins.
  The signing private key remains with the independently authorised verifier.
  These inputs are not passwords or MFA codes to request from pilot customers.

### Existing protected configuration switch

Use the existing `configure-runtime-variable.yml`, with target `production`.
It calls `runtime-variable-worker.yml` and the existing one-operation
`execute-protected-runtime-variable-upsert.ts` executor. Each operation keeps
`skipDeploys=true`; it does not itself restart the app or mutate database rows.
The production-only options include database/Redis identity pins and rate-limit
enforcement flags alongside the existing restricted URLs and CA settings.

For production `DATABASE_URL`, the worker uses the approved `private-postgres`
runner and materializes the same six native files and independent pins described
below. The live gate in `production-runtime-variable-import-gate.ts` opens the
actual restricted runtime connection with the reviewed CA transport, verifies
the native target/import metadata, and reasserts that read immediately before
the configuration mutation. The executor also requires the stopped-writer
deployment observations. Neither a connection string's own hash nor a supplied
`passed: true` claim can replace this check.

After the real source freeze, import, independent verification and runtime
preflight, the operator dispatches the existing explicit operations for the
reviewed current-main SHA:

```sh
gh workflow run configure-runtime-variable.yml --ref main \
  -f candidate_sha=<reviewed-current-main-sha> -f target=production \
  -f variable_name=DATABASE_PATH -f confirmation=CLEAR_DATABASE_PATH_IN_PRODUCTION

gh workflow run configure-runtime-variable.yml --ref main \
  -f candidate_sha=<reviewed-current-main-sha> -f target=production \
  -f variable_name=DATABASE_URL -f confirmation=UPSERT_DATABASE_URL_IN_PRODUCTION
```

`CLEAR_DATABASE_PATH_IN_PRODUCTION` has one compile-time empty value; there is no
operator-supplied replacement path. It preserves the provider variable row and
all files/volumes. `DATABASE_URL` comes from the protected existing production
secret and passes the actual live gate. Any uncertain operation requires its
normal read-only reconciliation rather than an automatic retry. Complete the
remaining exact settings and full candidate environment validation before the
separate source deployment; a successful individual setter does not establish
that the whole configuration is ready.

## Enforced preflight contract

`scripts/lib/bar-pilot-production-runtime-preflight.ts` reuses native snapshot,
apply, final verification and Ed25519-approval contracts. The caller supplies
independently approved exact artifact/authority/target hashes, never hashes
calculated from untrusted files to make them pass. The gate rejects staging
evidence, incomplete imports, different candidates/targets, mismatched counts or
state commitments, unsigned approvals and altered files. Approval validity is
checked at the native verification event, whose timestamp cannot be in the future.

Its separate `assertBarPilotProductionLiveImport` performs an actual read-only
transaction on the intended restricted runtime connection: native catalog/RLS
readiness, database name/OID/version and the exact imported metadata commitment
must match the native verified receipt. The caller holds exact URL/resource/TLS
authority and reasserts the source freeze and artifact custody immediately before
any switch. **A JSON `passed: true` flag, a staging backup or this document cannot
replace either gate.** This preparation does not itself authorize production
mutation or claim a completed hosted import/recovery.

### Protected deployment inputs

The existing `deploy-production.yml` materializes six native metadata files from
the protected `production-deployment` environment. No existing workflow currently
publishes a complete native production `verify-target` artifact; the verifier
authority provisioner's intent/terminal/receipt is a different operation and
cannot substitute for an imported-data receipt.

After the real native commands and independent verification succeed, the operator
retains those exact bytes and supplies the following gzip-then-base64 values
through the existing protected secret custody. Encoding changes only transport,
never native file content or signed payloads.

| Protected secret suffix, after `PINTPATH_PRODUCTION_MIGRATION_` | Fixed native file |
| --- | --- |
| `SNAPSHOT_MANIFEST_GZIP_BASE64` | `snapshot-manifest.json` |
| `APPLY_RECEIPT_GZIP_BASE64` | `apply-receipt.json` |
| `VERIFICATION_RECEIPT_GZIP_BASE64` | `verification-receipt.json` |
| `VERIFICATION_APPROVAL_GZIP_BASE64` | `verification-approval.json` |
| `VERIFIER_PUBLIC_KEY_GZIP_BASE64` | `verifier-public-key.pem` |
| `TARGET_IDENTITY_GZIP_BASE64` | `target-identity.json` |

Each encoded secret is limited to 48 KiB and each decompressed file to 1 MiB;
larger inputs fail closed. There is no tar extraction, arbitrary output path,
SQLite/row payload or private signing-key channel. `PINS_BASE64` contains the
canonical JSON of the exact `BarPilotProductionMigrationPins` fields, and the
separately reviewed `PINS_SHA256` commits to those bytes. Populate expected pins
from independent approved custody, never by accepting an uploaded file's own
claims. The candidate and every native source/target/authority commitment must
agree.

The materializer validates all native schemas/signatures before writing into
owner-only `0700` directories under `$RUNNER_TEMP`, using fixed `0600` files.
The upload executor reopens these with no-follow descriptor checks and holds
directory identities; it reasserts native verification and unchanged pins before
the provider write. Input files are removed after the attempt and are excluded
from the uploaded deployment evidence. The evidence may retain only the native
hash binding. Missing genuine inputs block the upload. This artifact check still
does not replace the private-network live runtime check or the actual source
write freeze before configuration changes.
