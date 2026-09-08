import crypto from "node:crypto";

const PRIMARY_REGION = "asia-southeast1-eqsg3a";
const LEGACY_STAGING_REGION = "europe-west4-drams3a";

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function snapshot(
  regions: readonly { readonly region: string; readonly numReplicas: number }[],
  legacyAggregateReplicas: number | null,
) {
  const configuredRegions = [...regions]
    .sort((left, right) => left.region < right.region ? -1
      : left.region > right.region ? 1 : 0)
    .map(({ region, numReplicas }) => ({ region, numReplicas }));
  const configuredReplicas = configuredRegions.reduce(
    (total, entry) => total + entry.numReplicas,
    0,
  );
  const configured = { configuredReplicas, configuredRegions };
  return {
    ...configured,
    configuredTopologySha256: sha256(canonical(configured)),
    legacyAggregateReplicas,
  };
}

export function productionScaleTopologyFixture(
  options: {
    readonly attempts?: 0 | 1;
    readonly legacyBefore?: number | null;
    readonly legacyImmediatelyBeforeWrite?: number | null;
    readonly legacyAfter?: number | null;
  } = {},
) {
  const attempts = options.attempts ?? 1;
  const beforeReplicas = attempts === 0 ? 2 : 1;
  const before = snapshot(
    [{ region: PRIMARY_REGION, numReplicas: beforeReplicas }],
    options.legacyBefore ?? null,
  );
  return {
    authoritySource: "environment.config(decryptVariables:false)",
    primaryRegion: PRIMARY_REGION,
    allowedRegions: [PRIMARY_REGION],
    before,
    immediatelyBeforeWrite: attempts === 0
      ? null
      : snapshot(
          [{ region: PRIMARY_REGION, numReplicas: 1 }],
          options.legacyImmediatelyBeforeWrite ?? 47,
        ),
    after: snapshot(
      [{ region: PRIMARY_REGION, numReplicas: 2 }],
      options.legacyAfter ?? null,
    ),
    commandAssignments: attempts === 0 ? [] : [`${PRIMARY_REGION}=2`],
  };
}

export function productionRouteTopologyFixture(
  options: {
    readonly legacyBefore?: number | null;
    readonly legacyImmediatelyBeforeWrite?: number | null;
    readonly legacyAfter?: number | null;
  } = {},
) {
  const before = snapshot(
    [{ region: PRIMARY_REGION, numReplicas: 2 }],
    options.legacyBefore ?? null,
  );
  return {
    authoritySource: "environment.config(decryptVariables:false)",
    primaryRegion: PRIMARY_REGION,
    allowedRegions: [PRIMARY_REGION],
    before,
    immediatelyBeforeWrite: snapshot(
      [{ region: PRIMARY_REGION, numReplicas: 2 }],
      options.legacyImmediatelyBeforeWrite ?? null,
    ),
    after: snapshot(
      [{ region: PRIMARY_REGION, numReplicas: 2 }],
      options.legacyAfter ?? null,
    ),
  };
}

export function stagingQuiesceScaleTopologyFixture() {
  const beforeRegions = [{ region: LEGACY_STAGING_REGION, numReplicas: 1 }];
  return {
    authoritySource: "environment.config(decryptVariables:false)",
    primaryRegion: PRIMARY_REGION,
    allowedRegions: [PRIMARY_REGION, LEGACY_STAGING_REGION],
    before: snapshot(beforeRegions, null),
    immediatelyBeforeWrite: snapshot(beforeRegions, 1),
    after: snapshot([
      { region: PRIMARY_REGION, numReplicas: 0 },
      { region: LEGACY_STAGING_REGION, numReplicas: 0 },
    ], null),
    commandAssignments: [
      `${PRIMARY_REGION}=0`,
      `${LEGACY_STAGING_REGION}=0`,
    ],
  };
}

export function stagingRestoreScaleTopologyFixture() {
  const beforeRegions = [
    { region: PRIMARY_REGION, numReplicas: 0 },
    { region: LEGACY_STAGING_REGION, numReplicas: 0 },
  ];
  return {
    authoritySource: "environment.config(decryptVariables:false)",
    primaryRegion: PRIMARY_REGION,
    allowedRegions: [PRIMARY_REGION, LEGACY_STAGING_REGION],
    before: snapshot(beforeRegions, null),
    immediatelyBeforeWrite: snapshot(beforeRegions, 29),
    after: snapshot([
      { region: PRIMARY_REGION, numReplicas: 1 },
      { region: LEGACY_STAGING_REGION, numReplicas: 0 },
    ], null),
    commandAssignments: [
      `${PRIMARY_REGION}=1`,
      `${LEGACY_STAGING_REGION}=0`,
    ],
  };
}
