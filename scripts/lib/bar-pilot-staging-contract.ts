// The pilot recovers the known stopped staging deployment by uploading fresh
// source. It never restarts the retained image or changes its configured region.
export const BAR_PILOT_STAGING_POLICY_ID = "pintpath-bar-pilot-staging-app-source-upload";
export const BAR_PILOT_STOPPED_DEPLOYMENT_ID = "6300a324-9407-4b1c-b651-749c47e9537f";
export const BAR_PILOT_STOPPED_SOURCE_SHA = "12c0d24f6619a0286e16b8daf56fc27aaa1e3aba";
export const BAR_PILOT_PACKAGE_LOCK_SHA256 = "9b18e1ba2a9fa0f279ccfef94ccc449458dbcf7d953c33b533f461894ff5a724";

export function barPilotCurrentDeploymentExact(value: unknown, expectedId: string): boolean {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(expectedId)
    || expectedId === BAR_PILOT_STOPPED_DEPLOYMENT_ID || !value || typeof value !== "object") return false;
  const instance = value as Record<string, unknown>;
  const latest = instance.latestDeployment as Record<string, unknown> | undefined;
  return latest?.id === expectedId && latest.status === "SUCCESS" && latest.deploymentStopped === false
    && Array.isArray(instance.activeDeployments) && instance.activeDeployments.length === 1
    && instance.activeDeployments.every((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const row = entry as Record<string, unknown>;
      return row.id === expectedId && row.status === "SUCCESS" && row.deploymentStopped === false;
    });
}

export function barPilotStoppedDeploymentExact(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const instance = value as Record<string, unknown>;
  const latest = instance.latestDeployment as Record<string, unknown> | undefined;
  return latest?.id === BAR_PILOT_STOPPED_DEPLOYMENT_ID
    && latest.status === "SUCCESS"
    && latest.deploymentStopped === true
    && Array.isArray(instance.activeDeployments)
    && instance.activeDeployments.length <= 1
    && instance.activeDeployments.every((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const row = entry as Record<string, unknown>;
      return row.id === BAR_PILOT_STOPPED_DEPLOYMENT_ID
        && row.status === "SUCCESS" && row.deploymentStopped === true;
    });
}

export const BAR_PILOT_STAGING_VARIABLES = Object.freeze([
  "BAR_PILOT_ENABLED",
  "BAR_PILOT_VENUE_IDS",
  "BAR_PILOT_DEMO_ENABLED",
  "BAR_PILOT_DEMO_CUSTOMER_IDS",
  "PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED",
  "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
] as const);

export function barPilotVariableValueExact(name: string, value: string, candidate: string): boolean {
  if (name === "PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED") return value === "false";
  if (name === "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA") return value === candidate;
  if (name === "BAR_PILOT_ENABLED" || name === "BAR_PILOT_DEMO_ENABLED") {
    return value === "true" || value === "false";
  }
  if (name === "BAR_PILOT_VENUE_IDS" || name === "BAR_PILOT_DEMO_CUSTOMER_IDS") {
    const ids = value.split(",");
    return ids.length >= 1 && ids.length <= 20 && new Set(ids).size === ids.length
      && ids.every((id) => /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(id));
  }
  return true;
}
