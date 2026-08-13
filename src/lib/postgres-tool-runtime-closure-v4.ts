import crypto from "node:crypto";

/**
 * Passive PostgreSQL 17 tool-runtime closure contract.
 *
 * The platform manifest digest binds the complete OCI root filesystem. The
 * file projection below additionally freezes the exact ELF loader and every
 * recursively resolved DT_NEEDED object used by pg_dump/pg_restore. This
 * module performs no registry access, image pull, process launch, database
 * access, filesystem access, or vulnerability lookup. A future Linux runner
 * must independently prove every live observation and retain a non-serialized
 * in-process brand before this contract can contribute runtime authority.
 */
export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_PROFILE =
  "pintpath-postgres-17.10-official-oci-linux-amd64-v1" as const;

export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_CAPABILITY = Object.freeze({
  implementationState: "PASSIVE_PINNED_OCI_RUNTIME_CONTRACT_ONLY",
  registryRetrievalImplemented: false,
  imageManifestVerificationImplemented: false,
  imageSignatureVerificationImplemented: false,
  sbomVerificationImplemented: false,
  provenanceVerificationImplemented: false,
  runtimeFileVerificationImplemented: false,
  runtimeInjectedFileVerificationImplemented: false,
  sandboxExecutionImplemented: false,
  processLifecycleImplemented: false,
  archiveCustodyImplemented: false,
  networkDestinationRestrictionImplemented: false,
  credentialContainmentImplemented: false,
  vulnerabilityDispositionImplemented: false,
  independentLiveRuntimeRecorderBrandRequired: true,
  independentLiveRuntimeRecorderBrandSerialized: false,
  serializedContractIsRuntimeAuthority: false,
  nativeRuntimeClosureVerified: false,
  operationalToolAuthorityGranted: false,
  sourceAuthorityGranted: false,
  archiveContentAuthorityGranted: false,
  artifactEmissionAuthorized: false,
  activationAuthorized: false,
  productionCutoverAuthorized: false,
} as const);

export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE = Object.freeze({
  registry: "registry-1.docker.io",
  repository: "library/postgres",
  tag: "17.10-alpine3.23",
  reference: "docker.io/library/postgres:17.10-alpine3.23",
  indexMediaType: "application/vnd.oci.image.index.v1+json",
  indexDigest: "sha256:8189a1f6e40904781fc9e2612687877791d21679866db58b1de996b31fc312e4",
  indexBytes: 10_301,
  platform: Object.freeze({ os: "linux", architecture: "amd64" }),
  platformManifestMediaType: "application/vnd.oci.image.manifest.v1+json",
  platformManifestDigest:
    "sha256:c529722b47431f2478e5bef927f61bfc60433c8fa04e3d011b545192068ec677",
  platformManifestBytes: 2_866,
  configMediaType: "application/vnd.oci.image.config.v1+json",
  configDigest: "sha256:7d612f69c8b54228ef0a3ff3af3bb9df2f4348836ec03cebafe063e0cdca80ab",
  configBytes: 8_730,
  attestationManifestDigest:
    "sha256:aec4fc8ad2bf01d591faa184eaecdb25c94e18aaf45d991908fbad70891a6aec",
  attestationManifestBytes: 840,
  attestationConfigDigest:
    "sha256:3ae043e8a279d98b999e814032da7df0a4fe632445c495502992506ad6c80017",
  attestationConfigBytes: 241,
  sbomLayerDigest: "sha256:ce264702cdf0eb666980a396cab5672bc2e279b1e6e01d21efb0d93b1d3e82f9",
  sbomLayerBytes: 597_458,
  provenanceLayerDigest:
    "sha256:6ad8a8cd3e0f5adaefefbcc21fb32296a0006e7a5c3a08c84fc2530572274582",
  provenanceLayerBytes: 41_065,
  baseImageReference: "alpine:3.23",
  baseImageDigest: "sha256:1beb0dc0a51de7ff38e3b5274078a2e0b81113ba5c7535e1a03d5913a5edbda3",
  sourceRepository: "https://github.com/docker-library/postgres.git",
  sourceRevision: "4f9ced003ba58a854656ba150d146243d27ae3ac",
  sourceDirectory: "17/alpine3.23",
  imageVersion: "17.10-alpine3.23",
  createdAt: "2026-07-07T17:44:46.000Z",
  provenanceBuilder: "https://github.com/docker-library",
  provenanceBuildType: "https://mobyproject.org/buildkit@v1",
} as const);

export interface PostgresToolRuntimeClosureV4Layer {
  readonly digest: `sha256:${string}`;
  readonly bytes: number;
  readonly diffId: `sha256:${string}`;
}

export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS = Object.freeze([
  Object.freeze({
    digest: "sha256:e6f31ffc071e5560b82a8685fba8214954e5721e3e49269d00958316edbe89fe",
    bytes: 3_844_421,
    diffId: "sha256:31ad4a471c6852bfec14d757cc75a566c82a9769f12c3918cf6bf52cc0eeb3d0",
  }),
  Object.freeze({
    digest: "sha256:7a09c10db362498cce2a6a2fab887c0d80078091e9ef4d1fc41d31e699172fab",
    bytes: 973,
    diffId: "sha256:a07e7a00e93029a61ab8b3eef587b80e0a5ca55a2df648e1a4a354009a34dc8b",
  }),
  Object.freeze({
    digest: "sha256:841dec6c4c30017e59e3468428371f47e7cd26bda4b34fa62e98c49514934c6c",
    bytes: 900_263,
    diffId: "sha256:0640f8b5b4ef8a7e21cfcc061fc2ee118d9a50ec9fc036b2db7b0c38c6bef2e1",
  }),
  Object.freeze({
    digest: "sha256:02500ebfa877bc45d0105557c5c48e5f954b940b017c288923149a30a61daa3f",
    bytes: 116,
    diffId: "sha256:c14b332296908cf848c5a50aa654876b2ee5ba19be8f418ab7e0f3eb91e9d5cc",
  }),
  Object.freeze({
    digest: "sha256:2441001522f5ad2b94c162f091fbf84e2dc490a6502cd4f541a6b7ff4d79783d",
    bytes: 111_886_991,
    diffId: "sha256:c5b116cff9e493c94b71f693d28f79195516314cc34fd3c9b7e68c79cc08e2cd",
  }),
  Object.freeze({
    digest: "sha256:c98ac8d00c5e823a4aae403e56677ab5bec0eb2737af8cd1dc93d9eb5adf34a3",
    bytes: 9_950,
    diffId: "sha256:37c3400c9e27230e034483ccd166db059abe98e6e3fce87ad6239af0a2d0197d",
  }),
  Object.freeze({
    digest: "sha256:59f9227c54992a1799c357ef0a96902ab3d4a1532e4ccdac75303b1663690e76",
    bytes: 128,
    diffId: "sha256:86eaaea0fbe053fe8225201a63baa06bcce8cd74ded2288d35067c50eaebb670",
  }),
  Object.freeze({
    digest: "sha256:8df85f55d33d1bccb569892f8a07642beb6ccb7e09388f581d8bd21b0a8988ec",
    bytes: 170,
    diffId: "sha256:792279d9cef12184eeedc52272678c5dcd66aa45d51743d3b7b83a406cbd24b0",
  }),
  Object.freeze({
    digest: "sha256:c628ae46b0b6e5fe1d15574b5deb9033e19624255c7874b7c85895825f3f9bd5",
    bytes: 6_109,
    diffId: "sha256:009d82996228ca3bc38373e9e175872a0c01a9c815168a28ddbc2cc7b13351fa",
  }),
  Object.freeze({
    digest: "sha256:6aa277c7539e6be99bf9b5bae50ebc8b5cf1d30b521aca3ca43fbd6fcbb27ec9",
    bytes: 184,
    diffId: "sha256:f397960727a286ee1ceb21d4b5a9e225bf789fcfdb29ae61eb2783bb36df3764",
  }),
] as const satisfies readonly PostgresToolRuntimeClosureV4Layer[]);

export interface PostgresToolRuntimeClosureV4File {
  readonly path: `/${string}`;
  readonly nodeKind: "file" | "symlink";
  readonly linkTarget: string | null;
  readonly resolvedPath: `/${string}`;
  readonly bytes: number;
  readonly sha256: string;
  readonly classification: "elf-executable" | "elf-loader" | "shared-library";
}

function runtimeFile(
  path: `/${string}`,
  bytes: number,
  sha256: string,
  classification: PostgresToolRuntimeClosureV4File["classification"],
): Readonly<PostgresToolRuntimeClosureV4File> {
  return Object.freeze({
    path,
    nodeKind: "file" as const,
    linkTarget: null,
    resolvedPath: path,
    bytes,
    sha256,
    classification,
  });
}

function runtimeSymlink(
  path: `/${string}`,
  linkTarget: string,
  resolvedPath: `/${string}`,
  bytes: number,
  sha256: string,
  classification: PostgresToolRuntimeClosureV4File["classification"],
): Readonly<PostgresToolRuntimeClosureV4File> {
  return Object.freeze({
    path,
    nodeKind: "symlink" as const,
    linkTarget,
    resolvedPath,
    bytes,
    sha256,
    classification,
  });
}

export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES = Object.freeze([
  runtimeFile("/lib/ld-musl-x86_64.so.1", 666_216,
    "99eab0629ed5e6bc258bea735a128d1de30c5a8b52f39eed4919452d03c6c4ee",
    "elf-loader"),
  runtimeSymlink("/lib/libc.musl-x86_64.so.1", "ld-musl-x86_64.so.1",
    "/lib/ld-musl-x86_64.so.1", 666_216,
    "99eab0629ed5e6bc258bea735a128d1de30c5a8b52f39eed4919452d03c6c4ee",
    "shared-library"),
  runtimeSymlink("/usr/lib/libcom_err.so.2", "libcom_err.so.2.1",
    "/usr/lib/libcom_err.so.2.1", 18_112,
    "9f485d7f67c164ec4344c920c8dda6cf0c30c823d52667eed93fb79cc83e141d",
    "shared-library"),
  runtimeFile("/usr/lib/libcrypto.so.3", 4_985_616,
    "5e860b4eb92cd6671dfe557ecffd506778f6549030b0e6142e94cb8e340c871d",
    "shared-library"),
  runtimeSymlink("/usr/lib/libgssapi_krb5.so.2", "libgssapi_krb5.so.2.2",
    "/usr/lib/libgssapi_krb5.so.2.2", 274_624,
    "f387a1dc70ee0a70e08cc30176161c2eb1336695f7f5ebb1fd8e47601c306731",
    "shared-library"),
  runtimeSymlink("/usr/lib/libk5crypto.so.3", "libk5crypto.so.3.1",
    "/usr/lib/libk5crypto.so.3.1", 165_936,
    "d948b651be212201da165f3f48a92797d66b1715d155bf9ba825c131d940eba6",
    "shared-library"),
  runtimeSymlink("/usr/lib/libkeyutils.so.1", "libkeyutils.so.1.10",
    "/usr/lib/libkeyutils.so.1.10", 18_192,
    "32286b8fc216df250c6b50e541cddc7802d79d012e2335a93116e76be9dff492",
    "shared-library"),
  runtimeSymlink("/usr/lib/libkrb5.so.3", "libkrb5.so.3.3",
    "/usr/lib/libkrb5.so.3.3", 710_840,
    "fa39a8be0c4c84c9fbe9ac2a6ca7e4cc5638c30c381fdd97822a2471bd213a36",
    "shared-library"),
  runtimeSymlink("/usr/lib/libkrb5support.so.0", "libkrb5support.so.0.1",
    "/usr/lib/libkrb5support.so.0.1", 43_064,
    "d0986e73e96c4e2406467fbcd3df74c106af2e06890cfe8330542836a7004e99",
    "shared-library"),
  runtimeSymlink("/usr/lib/liblber.so.2", "liblber.so.2.0.200",
    "/usr/lib/liblber.so.2.0.200", 51_224,
    "521c84619d295415df37edc185e3ace616fde3e53cdeed52e1b20161606f55be",
    "shared-library"),
  runtimeSymlink("/usr/lib/libldap.so.2", "libldap.so.2.0.200",
    "/usr/lib/libldap.so.2.0.200", 322_496,
    "1fd9a9edd014a95d5fc6179b5c793e925a963ebda8300ee87d83aa267801f4a8",
    "shared-library"),
  runtimeSymlink("/usr/lib/liblz4.so.1", "liblz4.so.1.10.0",
    "/usr/lib/liblz4.so.1.10.0", 169_664,
    "78a71fdcb0d0d54c204f909120efc2caf9835c326a2803ddbf993de2f7cbc2d0",
    "shared-library"),
  runtimeSymlink("/usr/lib/libsasl2.so.3", "libsasl2.so.3.0.0",
    "/usr/lib/libsasl2.so.3.0.0", 100_920,
    "3e98af6838fb0b53ace34fdaee353e0ca24d2b0320931f252884b81e1c1bc853",
    "shared-library"),
  runtimeFile("/usr/lib/libssl.so.3", 839_544,
    "e5511fdc20200c254a01ff8c801828139cfc36be4fca2d52b3fdac54f041f978",
    "shared-library"),
  runtimeSymlink("/usr/lib/libz.so.1", "libz.so.1.3.2",
    "/usr/lib/libz.so.1.3.2", 108_376,
    "60997f0db81cadd7cd12e787f3cc7de3c1e0946bc9bf28160c10199cceb59fef",
    "shared-library"),
  runtimeSymlink("/usr/lib/libzstd.so.1", "libzstd.so.1.5.7",
    "/usr/lib/libzstd.so.1.5.7", 710_336,
    "bbc46638607e551ffc8e9b4f0b02afb75cd52c8c560b386f7436a42fe840047f",
    "shared-library"),
  runtimeFile("/usr/local/bin/pg_dump", 525_064,
    "fb3b6f653eae3eb4709c83117355dd9e033dd96332167c4042981ce37aefa6df",
    "elf-executable"),
  runtimeFile("/usr/local/bin/pg_restore", 286_888,
    "6d408461d62238fb4bc0e92831d56bf40bcbd16f2e524addd19efe4909bda7b5",
    "elf-executable"),
  runtimeSymlink("/usr/local/lib/libpq.so.5", "libpq.so.5.17",
    "/usr/local/lib/libpq.so.5.17", 397_968,
    "e3f5f26da6ed9865c62c19a6527ce3aaaec49cc5cc3570fe095a04e1d5694152",
    "shared-library"),
] as const satisfies readonly PostgresToolRuntimeClosureV4File[]);

export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_DATA_FILES = Object.freeze([
  Object.freeze({ path: "/etc/ssl/certs/ca-certificates.crt", bytes: 179_359,
    sha256: "b8d837841b88bfaa1a0fa827cbca8e2576418dd47c9fc4bb7f1f9d89c83111b9" }),
  Object.freeze({ path: "/etc/ssl/openssl.cnf", bytes: 12_411,
    sha256: "a65a2cb9f4ee8ffdc7ef4f0ac600c0bdafb95b7b1ab457188ac610a62f5ad6b3" }),
  Object.freeze({ path: "/usr/share/zoneinfo/UTC", bytes: 114,
    sha256: "8b85846791ab2c8a5463c83a5be3c043e2570d7448434d41398969ed47e3e6f2" }),
] as const);

export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REQUIRED_SANDBOX = Object.freeze({
  platform: "linux/amd64",
  imageReferenceMustUsePlatformManifestDigest: true,
  imagePullByTagForbidden: true,
  mutableTagExecutionForbidden: true,
  rootFilesystemReadOnly: true,
  runAsNonRoot: true,
  capabilityDropAll: true,
  noNewPrivileges: true,
  defaultSeccompRequired: true,
  privilegedForbidden: true,
  hostPidForbidden: true,
  hostIpcForbidden: true,
  hostUtsForbidden: true,
  deviceMountsForbidden: true,
  arbitraryHostFilesystemMountsForbidden: true,
  onlyReviewedReadOnlyCaAndCredentialInputsPermitted: true,
  dockerSocketMountForbidden: true,
  arbitraryEnvironmentForwardingForbidden: true,
  exactClosedLibpqEnvironmentRequired: true,
  pgRequireAuthScramSha256Required: true,
  credentialValueInContainerConfigOrArgumentsForbidden: true,
  protectedCredentialFileDeliveryRequired: true,
  injectedNetworkConfigurationMustBeObservedAndHashed: true,
  networkEgressRestrictedToReviewedPostgresEndpointRequired: true,
  dnsResolutionAndTlsPeerEvidenceRequired: true,
  stdoutArchiveStreamingRequired: true,
  archivePathInsideContainerForbidden: true,
  rawListingStdinStreamingRequired: true,
  boundedStdoutAndStderrRequired: true,
  externalAbsoluteDeadlineRequired: true,
  containerCreatedBeforeStartCleanupArmed: true,
  containerRemovalRequired: true,
  zeroResidualContainersRequired: true,
  zeroResidualVolumesRequired: true,
  zeroResidualWritableLayersRequired: true,
  retainedHostArchiveDescriptorCustodyRequired: true,
} as const);

export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REQUIRED_LIVE_EVIDENCE = Object.freeze({
  trustedLinuxKernelAndOciRuntimeTcbDeclared: true,
  registryTlsAndDigestRetrievalVerified: true,
  trustedPublicationOfExactIndexDigestVerified: true,
  exactIndexBytesHashed: true,
  exactPlatformManifestBytesHashed: true,
  exactConfigBytesHashed: true,
  everyCompressedLayerBytesHashedBeforeUse: true,
  everyRootfsDiffIdRecomputed: true,
  exactPlatformSelected: true,
  exactSbomBytesHashedAndSubjectMatched: true,
  exactProvenanceBytesHashedAndSubjectMatched: true,
  exactRuntimeFileSetAndHashesVerifiedInsideRootfs: true,
  exactRuntimeFileNodeKindsLinksAndResolvedPathsVerified: true,
  recursiveElfNeededClosureRecomputed: true,
  noUnexpectedElfNeededObjectAccepted: true,
  exactImageConfigEnvironmentVerified: true,
  injectedNetworkConfigurationFilesHashed: true,
  sourceSpecificCaAndCredentialInputsHashedAndCustodied: true,
  credentialAbsentFromContainerConfigArgumentsAndLogs: true,
  networkDestinationAllowlistVerified: true,
  dnsResolutionAndTlsPeerIdentityVerified: true,
  exactPgDumpVersionObserved: "17.10",
  exactPgRestoreVersionObserved: "17.10",
  exactSandboxConfigurationInspectedBeforeStart: true,
  exactContainerIdentityPinnedBeforeStart: true,
  liveProcessExitAndSignalVerified: true,
  containerRemovedAfterEveryOutcome: true,
  vulnerabilityDispositionForExactRuntimeClosureRequired: true,
  independentLiveRuntimeRecorderBrandRequired: true,
} as const);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("runtime_closure_contract_invalid");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(",")}}`;
}

export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_POLICY = Object.freeze({
  profile: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_PROFILE,
  image: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE,
  layers: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS,
  runtimeFiles: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES,
  dataFiles: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_DATA_FILES,
  requiredSandbox: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REQUIRED_SANDBOX,
  requiredLiveEvidence: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REQUIRED_LIVE_EVIDENCE,
  capability: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_CAPABILITY,
} as const);

export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_POLICY_SHA256 = crypto
  .createHash("sha256")
  .update(`${canonicalJson(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_POLICY)}\n`, "utf8")
  .digest("hex");

export const POSTGRES_TOOL_RUNTIME_CLOSURE_V4_EXPECTED_POLICY_SHA256 =
  "4000a760bc4e6526c20664c6eba9818e2f234fda82c18fb3b5c8ea18c11bf97f" as const;

if (POSTGRES_TOOL_RUNTIME_CLOSURE_V4_POLICY_SHA256
  !== POSTGRES_TOOL_RUNTIME_CLOSURE_V4_EXPECTED_POLICY_SHA256) {
  throw new Error("postgres_tool_runtime_closure_v4_static_contract_drift");
}

export function canonicalPostgresToolRuntimeClosureV4PolicyJson(): string {
  return `${canonicalJson(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_POLICY)}\n`;
}
