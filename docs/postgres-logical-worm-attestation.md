# PostgreSQL logical WORM attestation

Status: **IMPLEMENTED, NOT PROVISIONED — the code and offline tests are
complete; the separately administered AWS recovery account, Melbourne bucket,
roles, live attestation, independent later retrieval, and restore evidence are
still open.**

This command writes a verified PostgreSQL logical-backup set to Amazon S3
Object Lock in `COMPLIANCE` mode. It complements the private Supabase
operational copy; it does not turn that mutable copy into WORM storage and does
not close PITR, private Storage, deletion-tombstone, RPO/RTO, or full-restore
gates.

No AWS account, bucket, role, credential, or object was created while this
foundation was integrated on 2026-08-09.

## Recovery-administrator gate

An authorized recovery administrator, independently controlled from the
application and ordinary deployment administrators, must:

1. approve and create the dedicated recovery AWS account and its billing and
   security controls;
2. opt that account into Asia Pacific (Melbourne), `ap-southeast-4`;
3. create a private general-purpose S3 bucket with Object Lock enabled,
   Versioning `Enabled`, default retention `COMPLIANCE` for exactly 30 days,
   all four Block Public Access settings enabled, Bucket owner enforced object
   ownership, SSE-S3 (`AES256`) default encryption, no Requester Pays, and no
   public bucket policy;
4. create distinct, no-custom-path IAM roles for the writer and reader. Attach
   the exact policies produced by `buildPostgresLogicalWormWriterPolicy` and
   `buildPostgresLogicalWormReaderPolicy` in
   `src/lib/postgres-logical-worm.ts`;
5. keep account/root and retention administration outside both roles, protect
   administrator access with MFA, and provide short-lived local AWS profiles
   rather than application environment credentials; and
6. record the account, bucket, role, region, retention, and reviewer identity
   pins in the private recovery register. Never commit raw credentials.

The writer policy has only `s3:PutObject` on the content-addressed WORM prefix
and requires `If-None-Match: *` plus `AES256`. It has no read, list, delete,
ACL, multipart, retention, or bucket-configuration action. The separate reader
can inspect the pinned bucket controls, enumerate exact object versions, read
those versions, and read their retention, but has no write or delete action.

The provider contract follows the AWS documentation for
[Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html),
[default retention](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-configure.html),
[conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html),
and [additional checksums](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html).

## Offline checks

These commands do not contact AWS because the integration test's three live
confirmation gates are absent:

```bash
npx vitest run \
  test/postgres-logical-worm.test.ts \
  test/postgres-logical-worm.integration.test.ts
npm run build
```

Ordinary CI sets all three gates to `disabled`, supplies no AWS profile or
credential, and verifies that the live integration remains skipped.

## Deliberate live synthetic integration

The live integration creates an immutable synthetic object set that cannot be
removed before retention expires. Run it only after the recovery administrator
has approved that write and installed both local profiles:

```bash
export PINTPATH_TEST_POSTGRES_LOGICAL_WORM_AWS=confirmed
export PINTPATH_POSTGRES_LOGICAL_WORM=confirmed
export PINTPATH_POSTGRES_LOGICAL_WORM_AWS=confirmed
export PINTPATH_TEST_WORM_BUCKET='replace-with-private-bucket'
export PINTPATH_TEST_WORM_WRITER_PROFILE='replace-with-writer-profile'
export PINTPATH_TEST_WORM_READER_PROFILE='replace-with-reader-profile'
export PINTPATH_TEST_WORM_RECOVERY_ACCOUNT_ID='123456789012'
export PINTPATH_TEST_WORM_WRITER_ARN_SHA256='replace-with-64-lowercase-hex'
export PINTPATH_TEST_WORM_READER_ARN_SHA256='replace-with-64-lowercase-hex'
# If Pint Path owns any other AWS accounts, pin their comma-separated IDs:
# export PINTPATH_TEST_WORM_FORBIDDEN_ACCOUNT_IDS='210987654321'

npm run test:db:postgres:backup:logical:worm:aws
```

The test must remain skipped unless all three exact confirmation values are
present. A missing setting after all three gates are confirmed is a failure,
not a skip.

## Attest a reviewed staging logical backup

Use the exact mode-700 backup directory and manifest hash produced by
`db:postgres:backup:logical`. Pin the bucket, recovery account, and stable IAM
role ARNs by SHA-256. The AWS SDK resolves short-lived credentials from the two
named profiles; do not pass access keys as arguments.

Generate each pin over the exact UTF-8 value with no trailing newline, for
example `printf %s "$WORM_BUCKET" | shasum -a 256`. Role pins use the stable
`arn:aws:iam::<account>:role/<role-name>` ARN, not the STS session ARN.

```bash
export PINTPATH_POSTGRES_LOGICAL_WORM=confirmed
export PINTPATH_POSTGRES_LOGICAL_WORM_AWS=confirmed
export POSTGRES_LOGICAL_WORM_RECOVERY_ACCOUNT_ID='123456789012'
# If Pint Path owns any other AWS accounts, pin their comma-separated IDs:
# export POSTGRES_LOGICAL_WORM_FORBIDDEN_ACCOUNT_IDS='210987654321'

npm run --silent db:postgres:backup:logical:worm -- \
  --backup-directory="$BACKUP_DIRECTORY" \
  --backup-manifest-sha256="$EXPECTED_MANIFEST_SHA256" \
  --bucket-name="$WORM_BUCKET" \
  --expected-bucket-name-sha256="$WORM_BUCKET_SHA256" \
  --expected-recovery-account-id-sha256="$WORM_ACCOUNT_SHA256" \
  --expected-writer-principal-arn-sha256="$WORM_WRITER_ARN_SHA256" \
  --expected-reader-principal-arn-sha256="$WORM_READER_ARN_SHA256" \
  --operator-id="$OPERATOR_REFERENCE" \
  --writer-profile="$WORM_WRITER_PROFILE" \
  --reader-profile="$WORM_READER_PROFILE" \
  > "$WORM_ATTESTATION_RESULT"
```

The command fails closed unless it proves the exact account and distinct role
identities, Melbourne region, private bucket controls, conditional SHA-256
SSE-S3 writes, one exact version per key, byte/hash/checksum/metadata equality,
`COMPLIANCE` retention through the required window, and writer `AccessDenied`
canaries for exact-version read, list, delete, retention read, and bucket-lock
inspection. It then writes and independently verifies a content-addressed
immutable receipt. Output contains timestamps and hashes, not credentials,
profiles, paths, bucket names, account IDs, role ARNs, object keys, or version
IDs.

## Evidence and remaining launch gate

Store the hash-only result in the private release evidence directory with mode
600 and record the frozen candidate SHA, logical manifest hash, UTC time,
operator, recovery administrator, reviewer, and command version. Re-run the
independent reader from a separate recovery session and restore the exact WORM
set into a newly created disposable environment before calling the recovery
gate complete.

The launch gate remains **OPEN** until all of the following exist:

- separately administered account/bucket/role approval and live identity pins;
- passing synthetic and real staging WORM attestations;
- independent later retrieval of the exact object versions and immutable
  receipt;
- verified restore plus private Storage and non-zero deletion-tombstone replay;
- approved RPO/RTO evidence and two-person review; and
- proof that production and permanent staging were not mutated by the drill.
