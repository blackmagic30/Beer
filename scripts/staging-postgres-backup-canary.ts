export {
  STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV,
  STAGING_POSTGRES_BACKUP_CANARY_CONFIG_PATH_ENV,
  STAGING_POSTGRES_BACKUP_CANARY_LOCK,
  STAGING_POSTGRES_BACKUP_CANARY_ROOT_CA_ENV,
  STAGING_POSTGRES_BACKUP_CANARY_SCHEMA,
  STAGING_POSTGRES_BACKUP_CANARY_SCOPE,
  runStagingPostgresBackupCanary,
  stagingPostgresBackupDatabaseIdentitySha256,
  type StagingPostgresBackupCanaryDependencies,
  type StagingPostgresBackupCanaryReceipt,
} from "../src/lib/postgres-staging-backup-canary.js";

import { runStagingPostgresBackupCanary } from
  "../src/lib/postgres-staging-backup-canary.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  void runStagingPostgresBackupCanary().then(
    (exitCode) => { process.exitCode = exitCode; },
    () => { process.exitCode = 1; },
  );
}
