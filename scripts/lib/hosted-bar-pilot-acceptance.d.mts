export const HOSTED_PILOT_ACCEPTANCE_SCHEMA: "pintpath-hosted-bar-pilot-acceptance/v1";
export const HOSTED_PILOT_ORIGIN: "https://beer-staging.up.railway.app";
export const HOSTED_PILOT_CHECKS: readonly string[];
export interface HostedPilotAcceptanceExpected {
  candidateSha: string;
  stagingRunId: string | number;
  stagingDeploymentIdSha256: string;
  sourceIdentitySha256: string;
  now: string | Date;
}
export interface HostedPilotAcceptanceBinding {
  readonly schemaVersion: typeof HOSTED_PILOT_ACCEPTANCE_SCHEMA;
  readonly reportSha256: string;
  readonly candidateSha: string;
  readonly stagingRunId: string;
  readonly stagingDeploymentIdSha256: string;
  readonly sourceIdentitySha256: string;
  readonly completedAt: string;
  readonly checksPassed: number;
}
export function parseHostedBarPilotAcceptance(value: unknown, expected: HostedPilotAcceptanceExpected): Record<string, unknown> | null;
export function assertHostedBarPilotAcceptance(input: HostedPilotAcceptanceExpected & {
  filePath: string;
  expectedSha256: string;
}): HostedPilotAcceptanceBinding;
