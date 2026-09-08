#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_OPERATIONAL_ENVIRONMENT_POLICY,
  loadAndValidateOperationalEnvironmentManifest,
} from "./verify-github-operational-environment-policy.mjs";

const githubApiVersion = "2022-11-28";
const moduleRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultManifestPath = path.join(
  moduleRoot,
  ".github/operational-environment-policy.json",
);

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactDeploymentBranchPolicy(value) {
  return (
    value?.protected_branches === false &&
    value?.custom_branch_policies === true
  );
}

const supportedEnvironmentProtectionRuleTypes = new Set([
  "branch_policy",
  "required_reviewers",
  "wait_timer",
]);

function unsupportedProtectionRuleIssues(environment) {
  if (!Array.isArray(environment?.protection_rules)) {
    return ["protection rule inventory is unavailable or malformed"];
  }
  const issues = [];
  const counts = new Map();
  for (const rule of environment.protection_rules) {
    const type = rule?.type;
    if (
      typeof type !== "string" ||
      !supportedEnvironmentProtectionRuleTypes.has(type)
    ) {
      issues.push(
        `unsupported environment protection rule type ${JSON.stringify(type ?? null)}`,
      );
      continue;
    }
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  for (const [type, count] of counts) {
    if (count > 1) {
      issues.push(`environment protection rule type ${type} is duplicated`);
    }
  }
  return issues;
}

function validCustomProtectionRule(rule) {
  return Number.isSafeInteger(rule?.id) && rule.id > 0;
}

function customProtectionRuleIssues(customProtectionRules) {
  if (!Array.isArray(customProtectionRules)) {
    return ["custom deployment protection rule inventory is unavailable"];
  }
  if (customProtectionRules.some((rule) => !validCustomProtectionRule(rule))) {
    return ["custom deployment protection rule inventory is malformed"];
  }
  const ids = customProtectionRules.map((rule) => rule.id);
  if (new Set(ids).size !== ids.length) {
    return ["custom deployment protection rule IDs are duplicated"];
  }
  if (ids.length > 0) {
    return [
      `custom deployment protection rules are enabled (${ids.sort((left, right) => left - right).join(", ")})`,
    ];
  }
  return [];
}

function effectiveProtectionDrift(environment, customProtectionRules = []) {
  const drift = [];
  drift.push(...unsupportedProtectionRuleIssues(environment));
  drift.push(...customProtectionRuleIssues(customProtectionRules));
  const protectionRules = Array.isArray(environment?.protection_rules)
    ? environment.protection_rules
    : [];
  const waitRules = protectionRules.filter(
    (rule) => rule?.type === "wait_timer",
  );
  if (waitRules.some((rule) => rule.wait_timer !== 0)) {
    drift.push("wait timer is not zero");
  }
  const reviewerRules = protectionRules.filter(
    (rule) => rule?.type === "required_reviewers",
  );
  if (
    reviewerRules.some(
      (rule) =>
        !Array.isArray(rule.reviewers) ||
        rule.reviewers.length > 0 ||
        rule.prevent_self_review !== false,
    )
  ) {
    drift.push("required reviewers or self-review prevention are enabled");
  }
  if (!exactDeploymentBranchPolicy(environment?.deployment_branch_policy)) {
    drift.push("deployment branch mode is not custom-policy-only");
  }
  return drift;
}

function exactMainBranchPolicy(policy) {
  return policy?.name === "main" && policy?.type === "branch";
}

export function assessManagedEnvironment(
  environment,
  branchPolicies = [],
  customProtectionRules = [],
) {
  if (!environment) {
    return ["environment is missing"];
  }
  const drift = effectiveProtectionDrift(environment, customProtectionRules);
  if (exactDeploymentBranchPolicy(environment.deployment_branch_policy)) {
    const exactPolicies = branchPolicies.filter(exactMainBranchPolicy);
    if (exactPolicies.length !== 1 || branchPolicies.length !== 1) {
      drift.push("deployment policies are not exactly one main branch rule");
    }
  }
  return drift;
}

export function parseCustomProtectionRulesResponse(output, operation) {
  let response;
  try {
    response = JSON.parse(output);
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON: ${error.message}`);
  }
  if (
    !response ||
    !Number.isSafeInteger(response.total_count) ||
    response.total_count < 0 ||
    !Array.isArray(response.custom_deployment_protection_rules) ||
    response.total_count !== response.custom_deployment_protection_rules.length
  ) {
    throw new Error(
      `${operation} returned an invalid custom protection rule collection.`,
    );
  }
  const rules = response.custom_deployment_protection_rules;
  if (rules.some((rule) => !validCustomProtectionRule(rule))) {
    throw new Error(`${operation} returned a rule without a positive integer ID.`);
  }
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    throw new Error(`${operation} returned duplicate protection rule IDs.`);
  }
  return rules;
}

function desiredEnvironmentBody(policy) {
  return {
    wait_timer: policy.wait_timer,
    prevent_self_review: policy.prevent_self_review,
    reviewers: policy.reviewers,
    deployment_branch_policy: policy.deployment_branch_policy,
  };
}

function flattenPaginatedResponse(output, collectionKey, operation) {
  let pages;
  try {
    pages = JSON.parse(output);
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(pages)) {
    throw new Error(`${operation} did not return a paginated response array.`);
  }
  const values = [];
  for (const page of pages) {
    if (!page || !Array.isArray(page[collectionKey])) {
      throw new Error(
        `${operation} returned a page without ${collectionKey}.`,
      );
    }
    values.push(...page[collectionKey]);
  }
  return values;
}

export class GitHubEnvironmentApi {
  constructor(repository) {
    this.repository = repository;
  }

  #run(args, { input } = {}) {
    const result = spawnSync("gh", args, {
      cwd: moduleRoot,
      encoding: "utf8",
      env: { ...process.env, GH_PAGER: "cat", PAGER: "cat" },
      input,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) {
      throw new Error(`Unable to run gh: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "unknown gh error")
        .trim()
        .slice(0, 2_000);
      throw new Error(`GitHub API request failed: ${detail}`);
    }
    return result.stdout;
  }

  #headers() {
    return [
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      `X-GitHub-Api-Version: ${githubApiVersion}`,
    ];
  }

  #repositoryPath() {
    const [owner, repository] = this.repository.split("/");
    return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  }

  #environmentPath(environmentName) {
    return `${this.#repositoryPath()}/environments/${encodeURIComponent(environmentName)}`;
  }

  async listEnvironments() {
    const output = this.#run([
      "api",
      "--paginate",
      "--slurp",
      ...this.#headers(),
      `${this.#repositoryPath()}/environments?per_page=100`,
    ]);
    return flattenPaginatedResponse(
      output,
      "environments",
      "List repository environments",
    );
  }

  async putEnvironment(environmentName, body) {
    this.#run(
      [
        "api",
        "--method",
        "PUT",
        ...this.#headers(),
        this.#environmentPath(environmentName),
        "--input",
        "-",
      ],
      { input: JSON.stringify(body) },
    );
  }

  async listBranchPolicies(environmentName) {
    const output = this.#run([
      "api",
      "--paginate",
      "--slurp",
      ...this.#headers(),
      `${this.#environmentPath(environmentName)}/deployment-branch-policies?per_page=100`,
    ]);
    return flattenPaginatedResponse(
      output,
      "branch_policies",
      `List deployment policies for ${environmentName}`,
    );
  }

  async listCustomProtectionRules(environmentName) {
    const operation = `List custom deployment protection rules for ${environmentName}`;
    const output = this.#run([
      "api",
      ...this.#headers(),
      `${this.#environmentPath(environmentName)}/deployment_protection_rules`,
    ]);
    return parseCustomProtectionRulesResponse(output, operation);
  }

  async createBranchPolicy(environmentName, policy) {
    this.#run(
      [
        "api",
        "--method",
        "POST",
        ...this.#headers(),
        `${this.#environmentPath(environmentName)}/deployment-branch-policies`,
        "--input",
        "-",
      ],
      { input: JSON.stringify(policy) },
    );
  }

  async deleteBranchPolicy(environmentName, policyId) {
    if (!Number.isSafeInteger(policyId) || policyId <= 0) {
      throw new Error(
        `Refusing to delete invalid deployment policy ID for ${environmentName}.`,
      );
    }
    this.#run([
      "api",
      "--method",
      "DELETE",
      "--silent",
      ...this.#headers(),
      `${this.#environmentPath(environmentName)}/deployment-branch-policies/${policyId}`,
    ]);
  }

  async deleteCustomProtectionRule(environmentName, protectionRuleId) {
    if (!Number.isSafeInteger(protectionRuleId) || protectionRuleId <= 0) {
      throw new Error(
        `Refusing to delete invalid custom protection rule ID for ${environmentName}.`,
      );
    }
    this.#run([
      "api",
      "--method",
      "DELETE",
      "--silent",
      ...this.#headers(),
      `${this.#environmentPath(environmentName)}/deployment_protection_rules/${protectionRuleId}`,
    ]);
  }
}

async function inspectRepository({ api, manifest }) {
  const managedNames = manifest.environments.map((entry) => entry.name);
  const managedSet = new Set(managedNames);
  const environments = await api.listEnvironments();
  const environmentByName = new Map(
    environments.map((environment) => [environment.name, environment]),
  );
  const unknownEnvironments = [...environmentByName.keys()]
    .filter((name) => !managedSet.has(name))
    .sort(lexicalCompare);
  const missingEnvironments = managedNames.filter(
    (name) => !environmentByName.has(name),
  );
  const customProtectionRulesByName = new Map();
  const drift = [];
  const unregisteredEnvironmentDrift = [];

  for (const name of managedNames) {
    const environment = environmentByName.get(name);
    let branchPolicies = [];
    const customProtectionRules = environment
      ? await api.listCustomProtectionRules(name)
      : [];
    customProtectionRulesByName.set(name, customProtectionRules);
    if (exactDeploymentBranchPolicy(environment?.deployment_branch_policy)) {
      branchPolicies = await api.listBranchPolicies(name);
    }
    const issues = assessManagedEnvironment(
      environment,
      branchPolicies,
      customProtectionRules,
    );
    if (issues.length > 0) {
      drift.push({ name, issues });
    }
  }
  for (const name of unknownEnvironments) {
    const environment = environmentByName.get(name);
    let branchPolicies = [];
    const customProtectionRules = await api.listCustomProtectionRules(name);
    customProtectionRulesByName.set(name, customProtectionRules);
    if (exactDeploymentBranchPolicy(environment?.deployment_branch_policy)) {
      branchPolicies = await api.listBranchPolicies(name);
    }
    const issues = assessManagedEnvironment(
      environment,
      branchPolicies,
      customProtectionRules,
    );
    if (issues.length > 0) {
      unregisteredEnvironmentDrift.push({ name, issues });
    }
  }

  return {
    environmentByName,
    customProtectionRulesByName,
    unknownEnvironments,
    missingEnvironments,
    drift,
    unregisteredEnvironmentDrift,
  };
}

async function normalizeEnvironment({
  api,
  environment,
  name,
  policy,
  mutations,
}) {
  let effectiveEnvironment = environment;
  if (effectiveEnvironment) {
    const unsupportedIssues = unsupportedProtectionRuleIssues(
      effectiveEnvironment,
    );
    if (unsupportedIssues.length > 0) {
      throw new Error(
        `Refusing to mutate ${name}: ${unsupportedIssues.join("; ")}.`,
      );
    }
    const customProtectionRules = await api.listCustomProtectionRules(name);
    const customIssues = customProtectionRuleIssues(customProtectionRules);
    const customIds = customProtectionRules.map((rule) => rule?.id);
    if (
      customProtectionRules.some((rule) => !validCustomProtectionRule(rule)) ||
      new Set(customIds).size !== customIds.length
    ) {
      throw new Error(
        `Refusing to mutate ${name}: ${customIssues.join("; ")}.`,
      );
    }
    for (const rule of [...customProtectionRules].sort(
      (left, right) => left.id - right.id,
    )) {
      await api.deleteCustomProtectionRule(name, rule.id);
      mutations.push({
        operation: "delete-custom-protection-rule",
        name,
        protectionRuleId: rule.id,
      });
    }
  }
  const protectionDrift = effectiveEnvironment
    ? effectiveProtectionDrift(effectiveEnvironment, [])
    : ["environment is missing"];
  if (protectionDrift.length > 0) {
    await api.putEnvironment(name, desiredEnvironmentBody(policy));
    mutations.push({ operation: "put-environment-policy", name });
    effectiveEnvironment = {
      name,
      protection_rules: [],
      deployment_branch_policy: policy.deployment_branch_policy,
    };
  }

  const policies = exactDeploymentBranchPolicy(
    effectiveEnvironment.deployment_branch_policy,
  )
    ? await api.listBranchPolicies(name)
    : [];
  const exactMainPolicies = policies
    .filter(exactMainBranchPolicy)
    .sort((left, right) => left.id - right.id);
  const keepPolicy = exactMainPolicies[0];
  for (const deploymentPolicy of policies) {
    if (deploymentPolicy !== keepPolicy) {
      await api.deleteBranchPolicy(name, deploymentPolicy.id);
      mutations.push({
        operation: "delete-deployment-branch-policy",
        name,
        policyId: deploymentPolicy.id,
      });
    }
  }
  if (!keepPolicy) {
    const [mainPolicy] = policy.deployment_branch_policies;
    await api.createBranchPolicy(name, mainPolicy);
    mutations.push({
      operation: "create-main-branch-policy",
      name,
    });
  }
}

export async function reconcileOperationalEnvironmentPolicy({
  api,
  manifest,
  mode,
}) {
  if (mode !== "check" && mode !== "apply") {
    throw new Error('mode must be exactly "check" or "apply".');
  }
  const initial = await inspectRepository({ api, manifest });
  const result = {
    ok: false,
    mode,
    repository: manifest.repository,
    managedEnvironmentCount: manifest.environments.length,
    unknownEnvironments: initial.unknownEnvironments,
    missingEnvironments: initial.missingEnvironments,
    drift: initial.drift,
    unregisteredEnvironmentDrift: initial.unregisteredEnvironmentDrift,
    mutations: [],
  };

  if (mode === "check") {
    result.ok =
      result.unknownEnvironments.length === 0 && result.drift.length === 0;
    return result;
  }

  const unsafeMutationInventory = [];
  for (const [name, environment] of initial.environmentByName) {
    const issues = unsupportedProtectionRuleIssues(environment);
    const customRules = initial.customProtectionRulesByName.get(name);
    if (
      !Array.isArray(customRules) ||
      customRules.some((rule) => !validCustomProtectionRule(rule)) ||
      new Set(customRules.map((rule) => rule.id)).size !== customRules.length
    ) {
      issues.push(...customProtectionRuleIssues(customRules));
    }
    if (issues.length > 0) {
      unsafeMutationInventory.push({ name, issues });
    }
  }
  if (unsafeMutationInventory.length > 0) {
    throw new Error(
      `Refusing to apply with unsupported protection rule inventory: ${JSON.stringify(unsafeMutationInventory)}.`,
    );
  }

  const desiredPolicy = manifest.policy;
  const namesToNormalize = [
    ...manifest.environments.map((environment) => environment.name),
    ...initial.unknownEnvironments,
  ];
  for (const name of namesToNormalize) {
    await normalizeEnvironment({
      api,
      environment: initial.environmentByName.get(name),
      name,
      policy: desiredPolicy,
      mutations: result.mutations,
    });
  }

  const final = await inspectRepository({ api, manifest });
  result.unknownEnvironments = final.unknownEnvironments;
  result.missingEnvironments = final.missingEnvironments;
  result.drift = final.drift;
  result.unregisteredEnvironmentDrift = final.unregisteredEnvironmentDrift;
  result.ok =
    final.unknownEnvironments.length === 0 &&
    final.drift.length === 0 &&
    final.unregisteredEnvironmentDrift.length === 0;
  return result;
}

export function parseReconcileArguments(argv) {
  let mode = null;
  let manifestPath = defaultManifestPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check" || argument === "--apply") {
      const nextMode = argument.slice(2);
      if (mode && mode !== nextMode) {
        throw new Error("Choose exactly one of --check or --apply.");
      }
      mode = nextMode;
    } else if (argument === "--manifest") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--manifest requires a path.");
      }
      manifestPath = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!mode) {
    throw new Error("Choose exactly one of --check or --apply.");
  }
  return { mode, manifestPath };
}

async function runCli() {
  const { mode, manifestPath } = parseReconcileArguments(
    process.argv.slice(2),
  );
  const validated = loadAndValidateOperationalEnvironmentManifest({
    root: moduleRoot,
    manifestPath,
  });
  const result = await reconcileOperationalEnvironmentPolicy({
    api: new GitHubEnvironmentApi(validated.manifest.repository),
    manifest: validated.manifest,
    mode,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
