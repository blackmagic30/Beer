import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalPostgresToolRuntimeClosureV4PolicyJson,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_CAPABILITY,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_DATA_FILES,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_EXPECTED_POLICY_SHA256,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_POLICY_SHA256,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REQUIRED_LIVE_EVIDENCE,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REQUIRED_SANDBOX,
} from "../src/lib/postgres-tool-runtime-closure-v4.js";

describe("PostgreSQL V4 pinned OCI tool-runtime closure contract", () => {
  it("pins one exact official PG17.10 linux/amd64 image and its attestations", () => {
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE).toEqual({
      registry: "registry-1.docker.io",
      repository: "library/postgres",
      tag: "17.10-alpine3.23",
      reference: "docker.io/library/postgres:17.10-alpine3.23",
      indexMediaType: "application/vnd.oci.image.index.v1+json",
      indexDigest: "sha256:8189a1f6e40904781fc9e2612687877791d21679866db58b1de996b31fc312e4",
      indexBytes: 10_301,
      platform: { os: "linux", architecture: "amd64" },
      platformManifestMediaType: "application/vnd.oci.image.manifest.v1+json",
      platformManifestDigest:
        "sha256:c529722b47431f2478e5bef927f61bfc60433c8fa04e3d011b545192068ec677",
      platformManifestBytes: 2_866,
      configMediaType: "application/vnd.oci.image.config.v1+json",
      configDigest:
        "sha256:7d612f69c8b54228ef0a3ff3af3bb9df2f4348836ec03cebafe063e0cdca80ab",
      configBytes: 8_730,
      attestationManifestDigest:
        "sha256:aec4fc8ad2bf01d591faa184eaecdb25c94e18aaf45d991908fbad70891a6aec",
      attestationManifestBytes: 840,
      attestationConfigDigest:
        "sha256:3ae043e8a279d98b999e814032da7df0a4fe632445c495502992506ad6c80017",
      attestationConfigBytes: 241,
      sbomLayerDigest:
        "sha256:ce264702cdf0eb666980a396cab5672bc2e279b1e6e01d21efb0d93b1d3e82f9",
      sbomLayerBytes: 597_458,
      provenanceLayerDigest:
        "sha256:6ad8a8cd3e0f5adaefefbcc21fb32296a0006e7a5c3a08c84fc2530572274582",
      provenanceLayerBytes: 41_065,
      baseImageReference: "alpine:3.23",
      baseImageDigest:
        "sha256:1beb0dc0a51de7ff38e3b5274078a2e0b81113ba5c7535e1a03d5913a5edbda3",
      sourceRepository: "https://github.com/docker-library/postgres.git",
      sourceRevision: "4f9ced003ba58a854656ba150d146243d27ae3ac",
      sourceDirectory: "17/alpine3.23",
      imageVersion: "17.10-alpine3.23",
      createdAt: "2026-07-07T17:44:46.000Z",
      provenanceBuilder: "https://github.com/docker-library",
      provenanceBuildType: "https://mobyproject.org/buildkit@v1",
    });
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS).toHaveLength(10);
    expect(new Set(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS.map(({ digest }) => digest)).size)
      .toBe(10);
    expect(new Set(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS.map(({ diffId }) => diffId)).size)
      .toBe(10);
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS.reduce(
      (sum, { bytes }) => sum + bytes,
      0,
    )).toBe(116_649_305);
  });

  it("freezes the exact recursive loader/shared-library closure and data inputs", () => {
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES).toHaveLength(19);
    const paths = POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.map(({ path: file }) => file);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain("/usr/local/bin/pg_dump");
    expect(paths).toContain("/usr/local/bin/pg_restore");
    expect(paths).toContain("/lib/ld-musl-x86_64.so.1");
    expect(paths).toContain("/usr/local/lib/libpq.so.5");
    expect(paths).toContain("/usr/lib/libcrypto.so.3");
    expect(paths).toContain("/usr/lib/libssl.so.3");
    expect(paths).not.toContain("/usr/lib/libxml2.so.2");
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.every(
      ({ bytes, sha256 }) => Number.isSafeInteger(bytes)
        && bytes > 0 && /^[a-f0-9]{64}$/.test(sha256),
    )).toBe(true);
    const symlinks = POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.filter(
      ({ nodeKind }) => nodeKind === "symlink",
    );
    expect(symlinks).toHaveLength(14);
    expect(symlinks.every(({ linkTarget, path: file, resolvedPath }) =>
      typeof linkTarget === "string"
        && linkTarget.length > 0
        && resolvedPath !== file)).toBe(true);
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.filter(
      ({ nodeKind }) => nodeKind === "file",
    ).every(({ linkTarget, path: file, resolvedPath }) =>
      linkTarget === null && resolvedPath === file)).toBe(true);
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.find(
      ({ path: file }) => file === "/lib/libc.musl-x86_64.so.1",
    )).toMatchObject({
      nodeKind: "symlink",
      linkTarget: "ld-musl-x86_64.so.1",
      resolvedPath: "/lib/ld-musl-x86_64.so.1",
    });
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.find(
      ({ path: file }) => file === "/usr/local/lib/libpq.so.5",
    )).toMatchObject({
      nodeKind: "symlink",
      linkTarget: "libpq.so.5.17",
      resolvedPath: "/usr/local/lib/libpq.so.5.17",
    });
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.find(
      ({ path: file }) => file === "/usr/local/bin/pg_dump",
    )?.sha256).toBe("fb3b6f653eae3eb4709c83117355dd9e033dd96332167c4042981ce37aefa6df");
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.find(
      ({ path: file }) => file === "/usr/local/bin/pg_restore",
    )?.sha256).toBe("6d408461d62238fb4bc0e92831d56bf40bcbd16f2e524addd19efe4909bda7b5");
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_DATA_FILES.map(({ path: file }) => file)).toEqual([
      "/etc/ssl/certs/ca-certificates.crt",
      "/etc/ssl/openssl.cnf",
      "/usr/share/zoneinfo/UTC",
    ]);
  });

  it("requires a read-only least-privilege sandbox and complete live evidence", () => {
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REQUIRED_SANDBOX).toMatchObject({
      platform: "linux/amd64",
      imageReferenceMustUsePlatformManifestDigest: true,
      rootFilesystemReadOnly: true,
      runAsNonRoot: true,
      capabilityDropAll: true,
      noNewPrivileges: true,
      privilegedForbidden: true,
      arbitraryHostFilesystemMountsForbidden: true,
      onlyReviewedReadOnlyCaAndCredentialInputsPermitted: true,
      dockerSocketMountForbidden: true,
      exactClosedLibpqEnvironmentRequired: true,
      pgRequireAuthScramSha256Required: true,
      credentialValueInContainerConfigOrArgumentsForbidden: true,
      protectedCredentialFileDeliveryRequired: true,
      injectedNetworkConfigurationMustBeObservedAndHashed: true,
      networkEgressRestrictedToReviewedPostgresEndpointRequired: true,
      dnsResolutionAndTlsPeerEvidenceRequired: true,
      archivePathInsideContainerForbidden: true,
      retainedHostArchiveDescriptorCustodyRequired: true,
    });
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REQUIRED_LIVE_EVIDENCE).toMatchObject({
      everyCompressedLayerBytesHashedBeforeUse: true,
      everyRootfsDiffIdRecomputed: true,
      exactSbomBytesHashedAndSubjectMatched: true,
      exactProvenanceBytesHashedAndSubjectMatched: true,
      exactRuntimeFileSetAndHashesVerifiedInsideRootfs: true,
      exactRuntimeFileNodeKindsLinksAndResolvedPathsVerified: true,
      recursiveElfNeededClosureRecomputed: true,
      exactImageConfigEnvironmentVerified: true,
      injectedNetworkConfigurationFilesHashed: true,
      sourceSpecificCaAndCredentialInputsHashedAndCustodied: true,
      credentialAbsentFromContainerConfigArgumentsAndLogs: true,
      networkDestinationAllowlistVerified: true,
      dnsResolutionAndTlsPeerIdentityVerified: true,
      exactPgDumpVersionObserved: "17.10",
      exactPgRestoreVersionObserved: "17.10",
      vulnerabilityDispositionForExactRuntimeClosureRequired: true,
      independentLiveRuntimeRecorderBrandRequired: true,
    });
  });

  it("is canonical, hash-pinned, passive, and non-authorizing", () => {
    const canonical = canonicalPostgresToolRuntimeClosureV4PolicyJson();
    expect(canonical.endsWith("\n")).toBe(true);
    expect(crypto.createHash("sha256").update(canonical).digest("hex"))
      .toBe(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_POLICY_SHA256);
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_POLICY_SHA256)
      .toBe(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_EXPECTED_POLICY_SHA256);
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_EXPECTED_POLICY_SHA256)
      .toBe("4000a760bc4e6526c20664c6eba9818e2f234fda82c18fb3b5c8ea18c11bf97f");
    expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_CAPABILITY).toMatchObject({
      implementationState: "PASSIVE_PINNED_OCI_RUNTIME_CONTRACT_ONLY",
      runtimeFileVerificationImplemented: false,
      sandboxExecutionImplemented: false,
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
    });
  });

  it("has a passive import graph and cannot execute or retrieve the image", () => {
    const source = fs.readFileSync(path.resolve(
      "src/lib/postgres-tool-runtime-closure-v4.ts",
    ), "utf8");
    expect(source.match(/^import .*;$/gm)).toEqual([
      'import crypto from "node:crypto";',
    ]);
    for (const forbidden of [
      "node:fs", "node:path", "node:child_process", "node:http", "node:https",
      "node:net", 'from "pg"', "docker.sock", "spawn(", "execFile(", "fetch(",
    ]) expect(source).not.toContain(forbidden);
    expect(source).not.toContain("nativeRuntimeClosureVerified: true");
    expect(source).not.toContain("artifactEmissionAuthorized: true");
  });
});
