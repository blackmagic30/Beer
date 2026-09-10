import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assessManagedEnvironment,
  parseCustomProtectionRulesResponse,
  parseReconcileArguments,
  reconcileOperationalEnvironmentPolicy,
} from "../scripts/reconcile-github-operational-environments.mjs";
import {
  EXPECTED_OPERATIONAL_ENVIRONMENT_POLICY,
  loadAndValidateOperationalEnvironmentManifest,
  validateOperationalEnvironmentManifest,
} from "../scripts/verify-github-operational-environment-policy.mjs";

const root = path.resolve(import.meta.dirname, "..");

type Environment = {
  name: string;
  protection_rules: Array<Record<string, unknown>>;
  deployment_branch_policy: {
    protected_branches: boolean;
    custom_branch_policies: boolean;
  } | null;
};

type BranchPolicy = { id: number; name: string; type: string };
type CustomProtectionRule = { id: number };

class FakeGitHubEnvironmentApi {
  environments = new Map<string, Environment>();
  branchPolicies = new Map<string, BranchPolicy[]>();
  customProtectionRules = new Map<string, CustomProtectionRule[]>();
  mutations: Array<{ operation: string; name: string }> = [];
  nextPolicyId = 10_000;

  async listEnvironments() {
    return structuredClone([...this.environments.values()]);
  }

  async putEnvironment(
    name: string,
    body: typeof EXPECTED_OPERATIONAL_ENVIRONMENT_POLICY,
  ) {
    this.mutations.push({ operation: "put", name });
    this.environments.set(name, {
      name,
      protection_rules: [],
      deployment_branch_policy: structuredClone(
        body.deployment_branch_policy,
      ),
    });
    if (!this.branchPolicies.has(name)) {
      this.branchPolicies.set(name, []);
    }
    if (!this.customProtectionRules.has(name)) {
      this.customProtectionRules.set(name, []);
    }
  }

  async listBranchPolicies(name: string) {
    return structuredClone(this.branchPolicies.get(name) ?? []);
  }

  async createBranchPolicy(
    name: string,
    policy: { name: string; type: string },
  ) {
    this.mutations.push({ operation: "create-branch", name });
    const policies = this.branchPolicies.get(name) ?? [];
    policies.push({ id: this.nextPolicyId, ...policy });
    this.nextPolicyId += 1;
    this.branchPolicies.set(name, policies);
  }

  async listCustomProtectionRules(name: string) {
    return structuredClone(this.customProtectionRules.get(name) ?? []);
  }

  async deleteCustomProtectionRule(name: string, protectionRuleId: number) {
    this.mutations.push({ operation: "delete-custom", name });
    this.customProtectionRules.set(
      name,
      (this.customProtectionRules.get(name) ?? []).filter(
        (rule) => rule.id !== protectionRuleId,
      ),
    );
  }

  async deleteBranchPolicy(name: string, policyId: number) {
    this.mutations.push({ operation: "delete-branch", name });
    this.branchPolicies.set(
      name,
      (this.branchPolicies.get(name) ?? []).filter(
        (policy) => policy.id !== policyId,
      ),
    );
  }
}

function validatedManifest() {
  return loadAndValidateOperationalEnvironmentManifest({ root }).manifest;
}

function compliantApi(manifest = validatedManifest()) {
  const api = new FakeGitHubEnvironmentApi();
  let policyId = 1;
  for (const { name } of manifest.environments) {
    api.environments.set(name, {
      name,
      protection_rules: [],
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    });
    api.branchPolicies.set(name, [
      { id: policyId, name: "main", type: "branch" },
    ]);
    api.customProtectionRules.set(name, []);
    policyId += 1;
  }
  return api;
}

describe("GitHub operational environment policy", () => {
  it("registers every literal and bounded dynamic workflow environment", () => {
    const result = loadAndValidateOperationalEnvironmentManifest({ root });

    expect(result.workflowFileCount).toBe(36);
    expect(result.environmentReferenceCount).toBe(57);
    expect(result.workflowEnvironmentNames).toHaveLength(27);
    expect(result.manifestEnvironmentNames).toHaveLength(29);
    expect(result.dynamicBindingCount).toBe(4);
    expect(result.manifest.policy).toEqual(
      EXPECTED_OPERATIONAL_ENVIRONMENT_POLICY,
    );
  });

  it("rejects a future unregistered workflow environment", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-environment-policy-"),
    );
    try {
      fs.mkdirSync(path.join(temporaryRoot, ".github"), { recursive: true });
      fs.cpSync(
        path.join(root, ".github/workflows"),
        path.join(temporaryRoot, ".github/workflows"),
        { recursive: true },
      );
      fs.writeFileSync(
        path.join(temporaryRoot, ".github/workflows/unregistered.yml"),
        [
          "name: Unregistered environment fixture",
          "on: workflow_dispatch",
          "jobs:",
          "  fixture:",
          "    runs-on: ubuntu-24.04",
          "    environment: future-unregistered-environment",
          "    steps: []",
          "",
        ].join("\n"),
      );

      expect(() =>
        validateOperationalEnvironmentManifest(validatedManifest(), {
          root: temporaryRoot,
        }),
      ).toThrow(/future-unregistered-environment/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("cannot bypass inventory with valid YAML key whitespace or quoting", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-environment-policy-"),
    );
    try {
      fs.mkdirSync(path.join(temporaryRoot, ".github"), { recursive: true });
      fs.cpSync(
        path.join(root, ".github/workflows"),
        path.join(temporaryRoot, ".github/workflows"),
        { recursive: true },
      );
      fs.writeFileSync(
        path.join(temporaryRoot, ".github/workflows/yaml-key-bypass.yml"),
        [
          "name: YAML key bypass fixture",
          "on: workflow_dispatch",
          "jobs:",
          "  whitespace:",
          "    runs-on: ubuntu-24.04",
          "    environment : future-whitespace-environment",
          "    steps: []",
          "  quoted:",
          "    runs-on: ubuntu-24.04",
          "    'environment' : future-quoted-environment",
          "    steps: []",
          "",
        ].join("\n"),
      );

      expect(() =>
        validateOperationalEnvironmentManifest(validatedManifest(), {
          root: temporaryRoot,
        }),
      ).toThrow(/future-(?:quoted|whitespace)-environment/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a dynamic protected environment passed by a future caller", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-environment-policy-"),
    );
    try {
      fs.mkdirSync(path.join(temporaryRoot, ".github"), { recursive: true });
      fs.cpSync(
        path.join(root, ".github/workflows"),
        path.join(temporaryRoot, ".github/workflows"),
        { recursive: true },
      );
      const callerPath = path.join(
        temporaryRoot,
        ".github/workflows/configure-runtime-variable.yml",
      );
      const caller = fs.readFileSync(callerPath, "utf8").replace(
        "protected_environment: permanent-staging-provider-mutation",
        "protected_environment: ${{ inputs.protected_environment }}",
      );
      fs.writeFileSync(callerPath, caller);

      expect(() =>
        validateOperationalEnvironmentManifest(validatedManifest(), {
          root: temporaryRoot,
        }),
      ).toThrow(/must pass a literal protected_environment/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects an expanded dynamic environment input domain", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-environment-policy-"),
    );
    try {
      fs.mkdirSync(path.join(temporaryRoot, ".github"), { recursive: true });
      fs.cpSync(
        path.join(root, ".github/workflows"),
        path.join(temporaryRoot, ".github/workflows"),
        { recursive: true },
      );
      const workflowPath = path.join(
        temporaryRoot,
        ".github/workflows/enable-postgres-ha-pitr.yml",
      );
      const workflow = fs.readFileSync(workflowPath, "utf8").replace(
        "          - production\n      confirmation:",
        "          - production\n          - disaster-recovery\n      confirmation:",
      );
      fs.writeFileSync(workflowPath, workflow);

      expect(() =>
        validateOperationalEnvironmentManifest(validatedManifest(), {
          root: temporaryRoot,
        }),
      ).toThrow(/input authority does not exactly match/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("derives dynamic outcomes instead of trusting resolvesTo", () => {
    const manifest = structuredClone(validatedManifest());
    manifest.dynamicWorkflowBindings[0].resolvesTo = [
      "permanent-staging-provider-mutation",
      "production",
    ];

    expect(() => validateOperationalEnvironmentManifest(manifest, { root }))
      .toThrow(/resolvesTo does not exactly match derived expression outcomes/u);
  });

  it("rejects unsupported dynamic expression semantics", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-environment-policy-"),
    );
    try {
      fs.mkdirSync(path.join(temporaryRoot, ".github"), { recursive: true });
      fs.cpSync(
        path.join(root, ".github/workflows"),
        path.join(temporaryRoot, ".github/workflows"),
        { recursive: true },
      );
      const workflowPath = path.join(
        temporaryRoot,
        ".github/workflows/enable-postgres-ha-pitr.yml",
      );
      const unsupported = "${{ format('postgres-ha-pitr-{0}', inputs.target_environment) }}";
      fs.writeFileSync(
        workflowPath,
        fs.readFileSync(workflowPath, "utf8").replace(
          "postgres-ha-pitr-${{ inputs.target_environment }}",
          unsupported,
        ),
      );
      const manifest = structuredClone(validatedManifest());
      manifest.dynamicWorkflowBindings[1].expression = unsupported;

      expect(() =>
        validateOperationalEnvironmentManifest(manifest, {
          root: temporaryRoot,
        }),
      ).toThrow(/unsupported dynamic environment expression/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("parses reusable caller keys with YAML whitespace before authorizing them", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-environment-policy-"),
    );
    try {
      fs.mkdirSync(path.join(temporaryRoot, ".github"), { recursive: true });
      fs.cpSync(
        path.join(root, ".github/workflows"),
        path.join(temporaryRoot, ".github/workflows"),
        { recursive: true },
      );
      const callerPath = path.join(
        temporaryRoot,
        ".github/workflows/configure-runtime-variable.yml",
      );
      fs.writeFileSync(
        callerPath,
        fs.readFileSync(callerPath, "utf8").replace(
          "protected_environment: permanent-staging-provider-mutation",
          "protected_environment : production",
        ),
      );

      expect(() =>
        validateOperationalEnvironmentManifest(validatedManifest(), {
          root: temporaryRoot,
        }),
      ).toThrow(/observed unauthorized input values: production/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("accepts same-commit dollar-root reusable workflow callers", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-environment-policy-"),
    );
    try {
      fs.mkdirSync(path.join(temporaryRoot, ".github"), { recursive: true });
      fs.cpSync(
        path.join(root, ".github/workflows"),
        path.join(temporaryRoot, ".github/workflows"),
        { recursive: true },
      );
      const callerPath = path.join(
        temporaryRoot,
        ".github/workflows/configure-runtime-variable.yml",
      );
      fs.writeFileSync(
        callerPath,
        fs.readFileSync(callerPath, "utf8").replaceAll(
          "./.github/workflows/runtime-variable-worker.yml",
          "$/.github/workflows/runtime-variable-worker.yml",
        ),
      );

      expect(() =>
        validateOperationalEnvironmentManifest(validatedManifest(), {
          root: temporaryRoot,
        }),
      ).not.toThrow();
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on a fully qualified self-repository reusable workflow ref", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-environment-policy-"),
    );
    try {
      fs.mkdirSync(path.join(temporaryRoot, ".github"), { recursive: true });
      fs.cpSync(
        path.join(root, ".github/workflows"),
        path.join(temporaryRoot, ".github/workflows"),
        { recursive: true },
      );
      const callerPath = path.join(
        temporaryRoot,
        ".github/workflows/configure-runtime-variable.yml",
      );
      fs.writeFileSync(
        callerPath,
        fs.readFileSync(callerPath, "utf8").replace(
          "./.github/workflows/runtime-variable-worker.yml",
          "blackmagic30/Beer/.github/workflows/runtime-variable-worker.yml@main",
        ),
      );

      expect(() =>
        validateOperationalEnvironmentManifest(validatedManifest(), {
          root: temporaryRoot,
        }),
      ).toThrow(/fully qualified self-repository ref.*cannot be proven/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("matches a fully qualified self repository case-insensitively", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-environment-policy-"),
    );
    try {
      fs.mkdirSync(path.join(temporaryRoot, ".github"), { recursive: true });
      fs.cpSync(
        path.join(root, ".github/workflows"),
        path.join(temporaryRoot, ".github/workflows"),
        { recursive: true },
      );
      const callerPath = path.join(
        temporaryRoot,
        ".github/workflows/configure-runtime-variable.yml",
      );
      fs.writeFileSync(
        callerPath,
        fs.readFileSync(callerPath, "utf8").replace(
          "./.github/workflows/runtime-variable-worker.yml",
          "BLACKMAGIC30/bEeR/.github/workflows/runtime-variable-worker.yml@main",
        ),
      );

      expect(() =>
        validateOperationalEnvironmentManifest(validatedManifest(), {
          root: temporaryRoot,
        }),
      ).toThrow(/fully qualified self-repository ref.*cannot be proven/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a reusable environment job without the exact source-repository guard", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-environment-policy-"),
    );
    try {
      fs.mkdirSync(path.join(temporaryRoot, ".github"), { recursive: true });
      fs.cpSync(
        path.join(root, ".github/workflows"),
        path.join(temporaryRoot, ".github/workflows"),
        { recursive: true },
      );
      const workerPath = path.join(
        temporaryRoot,
        ".github/workflows/runtime-variable-worker.yml",
      );
      fs.writeFileSync(
        workerPath,
        fs.readFileSync(workerPath, "utf8").replace(
          "if: ${{ github.repository == 'blackmagic30/Beer' }}",
          "if: ${{ github.repository == 'fork-owner/Beer' }}",
        ),
      );

      expect(() =>
        validateOperationalEnvironmentManifest(validatedManifest(), {
          root: temporaryRoot,
        }),
      ).toThrow(/must have exact repository guard/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects direct reusable caller input passthrough to an environment", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-environment-policy-"),
    );
    try {
      fs.mkdirSync(path.join(temporaryRoot, ".github"), { recursive: true });
      fs.cpSync(
        path.join(root, ".github/workflows"),
        path.join(temporaryRoot, ".github/workflows"),
        { recursive: true },
      );
      const workerPath = path.join(
        temporaryRoot,
        ".github/workflows/runtime-variable-worker.yml",
      );
      const directExpression = "${{ inputs.protected_environment }}";
      fs.writeFileSync(
        workerPath,
        fs.readFileSync(workerPath, "utf8").replace(
          "${{ inputs.protected_environment == 'production-runtime-configuration' && 'production-runtime-configuration' || 'permanent-staging-provider-mutation' }}",
          directExpression,
        ),
      );
      const manifest = structuredClone(validatedManifest());
      manifest.dynamicWorkflowBindings[3].expression = directExpression;

      expect(() =>
        validateOperationalEnvironmentManifest(manifest, {
          root: temporaryRoot,
        }),
      ).toThrow(/direct caller input passthrough is forbidden/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("treats the absent zero-value rules as approval-free", () => {
    expect(
      assessManagedEnvironment(
        {
          name: "production",
          protection_rules: [],
          deployment_branch_policy: {
            protected_branches: false,
            custom_branch_policies: true,
          },
        },
        [{ id: 1, name: "main", type: "branch" }],
      ),
    ).toEqual([]);
  });

  it("accepts branch_policy but rejects unknown environment rule types", () => {
    const environment = {
      name: "production",
      protection_rules: [{ type: "branch_policy" }],
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    };
    const branches = [{ id: 1, name: "main", type: "branch" }];

    expect(assessManagedEnvironment(environment, branches, [])).toEqual([]);
    environment.protection_rules.push({ type: "future_rule" });
    expect(assessManagedEnvironment(environment, branches, []))
      .toContain('unsupported environment protection rule type "future_rule"');
  });

  it("validates custom protection rule collection IDs and counts", () => {
    expect(
      parseCustomProtectionRulesResponse(
        JSON.stringify({
          total_count: 1,
          custom_deployment_protection_rules: [{ id: 41 }],
        }),
        "fixture",
      ),
    ).toEqual([{ id: 41 }]);
    expect(() =>
      parseCustomProtectionRulesResponse(
        JSON.stringify({
          total_count: 2,
          custom_deployment_protection_rules: [{ id: 41 }],
        }),
        "fixture",
      ),
    ).toThrow(/invalid custom protection rule collection/u);
    expect(() =>
      parseCustomProtectionRulesResponse(
        JSON.stringify({
          total_count: 1,
          custom_deployment_protection_rules: [{ id: 0 }],
        }),
        "fixture",
      ),
    ).toThrow(/positive integer ID/u);
  });

  it("keeps check mode read-only while reporting drift", async () => {
    const manifest = validatedManifest();
    const api = compliantApi(manifest);
    const production = api.environments.get("production");
    expect(production).toBeDefined();
    production!.protection_rules = [
      { type: "wait_timer", wait_timer: 15 },
      {
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User", reviewer: { login: "fixture" } }],
      },
    ];

    const result = await reconcileOperationalEnvironmentPolicy({
      api,
      manifest,
      mode: "check",
    });

    expect(result.ok).toBe(false);
    expect(result.drift).toEqual([
      {
        name: "production",
        issues: [
          "wait timer is not zero",
          "required reviewers or self-review prevention are enabled",
        ],
      },
    ]);
    expect(api.mutations).toEqual([]);
    expect(result.mutations).toEqual([]);
  });

  it("keeps custom deployment protection rules visible in read-only check mode", async () => {
    const manifest = validatedManifest();
    const api = compliantApi(manifest);
    api.customProtectionRules.set("production", [{ id: 71 }]);

    const result = await reconcileOperationalEnvironmentPolicy({
      api,
      manifest,
      mode: "check",
    });

    expect(result.ok).toBe(false);
    expect(result.drift).toContainEqual({
      name: "production",
      issues: ["custom deployment protection rules are enabled (71)"],
    });
    expect(api.mutations).toEqual([]);
    expect(result.mutations).toEqual([]);
  });

  it("uses the targeted custom-rule delete endpoint and verifies the reread", async () => {
    const manifest = validatedManifest();
    const api = compliantApi(manifest);
    api.customProtectionRules.set("production", [{ id: 72 }]);

    const result = await reconcileOperationalEnvironmentPolicy({
      api,
      manifest,
      mode: "apply",
    });

    expect(result.ok).toBe(true);
    expect(api.mutations).toContainEqual({
      operation: "delete-custom",
      name: "production",
    });
    expect(result.mutations).toContainEqual({
      operation: "delete-custom-protection-rule",
      name: "production",
      protectionRuleId: 72,
    });
    expect(api.customProtectionRules.get("production")).toEqual([]);
  });

  it("refuses apply before mutation when an unknown protection rule type exists", async () => {
    const manifest = validatedManifest();
    const api = compliantApi(manifest);
    api.environments.get("production")!.protection_rules = [
      { type: "future_rule" },
    ];

    await expect(
      reconcileOperationalEnvironmentPolicy({
        api,
        manifest,
        mode: "apply",
      }),
    ).rejects.toThrow(/Refusing to apply.*production.*future_rule/u);
    expect(api.mutations).toEqual([]);
  });

  it("normalizes an unknown live environment but remains nonzero until registration", async () => {
    const manifest = validatedManifest();
    const api = compliantApi(manifest);
    api.environments.set("future-live-environment", {
      name: "future-live-environment",
      protection_rules: [
        { type: "wait_timer", wait_timer: 30 },
        {
          type: "required_reviewers",
          prevent_self_review: true,
          reviewers: [{ type: "User", reviewer: { login: "fixture" } }],
        },
      ],
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    });

    const result = await reconcileOperationalEnvironmentPolicy({
      api,
      manifest,
      mode: "apply",
    });

    expect(result.ok).toBe(false);
    expect(result.unknownEnvironments).toEqual(["future-live-environment"]);
    expect(result.unregisteredEnvironmentDrift).toEqual([]);
    expect(api.mutations).toContainEqual({
      operation: "put",
      name: "future-live-environment",
    });
    expect(api.mutations).toContainEqual({
      operation: "create-branch",
      name: "future-live-environment",
    });
    expect(api.branchPolicies.get("future-live-environment")).toEqual([
      { id: 10_000, name: "main", type: "branch" },
    ]);
  });

  it("removes extra deployment patterns and verifies the reread", async () => {
    const manifest = validatedManifest();
    const api = compliantApi(manifest);
    api.branchPolicies.get("production")!.push({
      id: 9_999,
      name: "release/*",
      type: "branch",
    });

    const result = await reconcileOperationalEnvironmentPolicy({
      api,
      manifest,
      mode: "apply",
    });

    expect(result.ok).toBe(true);
    expect(api.mutations).toEqual([
      { operation: "delete-branch", name: "production" },
    ]);
    expect(api.branchPolicies.get("production")).toEqual([
      { id: 11, name: "main", type: "branch" },
    ]);
  });

  it("requires one explicit reconciliation mode", () => {
    expect(parseReconcileArguments(["--check"]).mode).toBe("check");
    expect(parseReconcileArguments(["--apply"]).mode).toBe("apply");
    expect(() => parseReconcileArguments([])).toThrow(
      /Choose exactly one/u,
    );
    expect(() =>
      parseReconcileArguments(["--check", "--apply"]),
    ).toThrow(/Choose exactly one/u);
  });
});
