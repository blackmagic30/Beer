#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
} from "yaml";

export const OPERATIONAL_ENVIRONMENT_POLICY_SCHEMA =
  "pintpath-github-operational-environment-policy/v1";

export const EXPECTED_OPERATIONAL_ENVIRONMENT_POLICY = Object.freeze({
  wait_timer: 0,
  prevent_self_review: false,
  reviewers: [],
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true,
  },
  deployment_branch_policies: [{ name: "main", type: "branch" }],
});

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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function workflowFiles(workflowsDirectory) {
  if (!fs.existsSync(workflowsDirectory)) {
    throw new Error(`Workflow directory does not exist: ${workflowsDirectory}`);
  }
  return fs
    .readdirSync(workflowsDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")),
    )
    .map((entry) => path.join(workflowsDirectory, entry.name))
    .sort(lexicalCompare);
}

function parsedWorkflow(root, workflow) {
  const filename = path.join(root, workflow);
  const source = fs.readFileSync(filename, "utf8");
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    lineCounter,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  const diagnostics = [...document.errors, ...document.warnings];
  if (diagnostics.length > 0) {
    throw new Error(
      `${workflow} is not unambiguous YAML: ${diagnostics.map((entry) => entry.message).join("; ")}`,
    );
  }
  if (!isMap(document.contents)) {
    throw new Error(`${workflow} must contain one YAML mapping document.`);
  }
  return { document, lineCounter, workflow };
}

function nodeLine(parsed, node) {
  const offset = Array.isArray(node?.range) ? node.range[0] : 0;
  return parsed.lineCounter.linePos(offset).line;
}

function mapPair(map, key) {
  if (!isMap(map)) return null;
  return map.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === key,
  ) ?? null;
}

function requiredMap(parsed, parent, key, context) {
  const pair = mapPair(parent, key);
  if (!pair || !isMap(pair.value)) {
    throw new Error(`${parsed.workflow}: ${context}.${key} must be a mapping.`);
  }
  return pair.value;
}

function requiredString(parsed, node, context) {
  if (
    !isScalar(node) ||
    typeof node.value !== "string" ||
    !node.value.trim()
  ) {
    throw new Error(
      `${parsed.workflow}:${nodeLine(parsed, node)}: ${context} must be a non-empty string scalar.`,
    );
  }
  return node.value;
}

function workflowDispatchChoiceValues(root, workflow, inputName) {
  const parsed = parsedWorkflow(root, workflow);
  const on = requiredMap(parsed, parsed.document.contents, "on", "workflow");
  const dispatch = requiredMap(parsed, on, "workflow_dispatch", "on");
  const inputs = requiredMap(parsed, dispatch, "inputs", "workflow_dispatch");
  const input = requiredMap(parsed, inputs, inputName, "workflow_dispatch.inputs");
  const typePair = mapPair(input, "type");
  const optionsPair = mapPair(input, "options");
  const type = requiredString(
    parsed,
    typePair?.value,
    `workflow_dispatch.inputs.${inputName}.type`,
  );
  if (type !== "choice" || !optionsPair || !isSeq(optionsPair.value)) {
    throw new Error(
      `${workflow} input ${inputName} must remain an explicit choice with options.`,
    );
  }
  return optionsPair.value.items.map((option) =>
    requiredString(
      parsed,
      option,
      `workflow_dispatch.inputs.${inputName}.options`,
    ),
  );
}

function localReusableWorkflowCallerValues(
  root,
  workflow,
  inputName,
  repository,
) {
  const workflowsDirectory = path.join(root, ".github/workflows");
  const expectedUses = `./${workflow}`;
  const expectedDollarUses = `$/${workflow}`;
  const selfQualifiedSuffix = `/${workflow}@`;
  const values = [];
  let callerCount = 0;
  for (const filename of workflowFiles(workflowsDirectory)) {
    const callerWorkflow = path
      .relative(root, filename)
      .split(path.sep)
      .join("/");
    const parsed = parsedWorkflow(root, callerWorkflow);
    const jobsPair = mapPair(parsed.document.contents, "jobs");
    if (!jobsPair) continue;
    if (!isMap(jobsPair.value)) {
      throw new Error(`${callerWorkflow}: jobs must be a mapping.`);
    }
    for (const job of jobsPair.value.items) {
      if (!isScalar(job.key) || !isMap(job.value)) {
        throw new Error(`${callerWorkflow}: every job must be a named mapping.`);
      }
      const usesPair = mapPair(job.value, "uses");
      if (!usesPair) continue;
      const target = requiredString(
        parsed,
        usesPair.value,
        `jobs.${String(job.key.value)}.uses`,
      );
      const targetRepository = target.slice(0, repository.length);
      const targetAfterRepository = target.slice(repository.length);
      if (
        targetRepository.toLowerCase() === repository.toLowerCase() &&
        targetAfterRepository.startsWith(selfQualifiedSuffix)
      ) {
        throw new Error(
          `${callerWorkflow}:${nodeLine(parsed, usesPair.key)} calls ${workflow} through a fully qualified self-repository ref whose exact current commit cannot be proven.`,
        );
      }
      if (target !== expectedUses && target !== expectedDollarUses) {
        continue;
      }
      callerCount += 1;
      const withPair = mapPair(job.value, "with");
      const inputPair = isMap(withPair?.value)
        ? mapPair(withPair.value, inputName)
        : null;
      if (!inputPair) {
        throw new Error(
          `${callerWorkflow}:${nodeLine(parsed, usesPair.key)} calls ${workflow} without literal input ${inputName}.`,
        );
      }
      const value = requiredString(
        parsed,
        inputPair.value,
        `jobs.${String(job.key.value)}.with.${inputName}`,
      );
      if (value.includes("${{")) {
        throw new Error(
          `${callerWorkflow}:${nodeLine(parsed, inputPair.key)} must pass a literal ${inputName} to ${workflow}.`,
        );
      }
      values.push(value);
    }
  }
  if (callerCount === 0) {
    throw new Error(`${workflow} has no local reusable-workflow callers.`);
  }
  return [...new Set(values)].sort(lexicalCompare);
}

export function extractWorkflowEnvironmentReferences(root = moduleRoot) {
  const workflowsDirectory = path.join(root, ".github/workflows");
  const references = [];
  const files = workflowFiles(workflowsDirectory);

  for (const filename of files) {
    const workflow = path
      .relative(root, filename)
      .split(path.sep)
      .join("/");
    const parsed = parsedWorkflow(root, workflow);
    const jobsPair = mapPair(parsed.document.contents, "jobs");
    if (!jobsPair) continue;
    if (!isMap(jobsPair.value)) {
      throw new Error(`${workflow}: jobs must be a mapping.`);
    }
    for (const job of jobsPair.value.items) {
      if (!isScalar(job.key) || !isMap(job.value)) {
        throw new Error(`${workflow}: every job must be a named mapping.`);
      }
      const environmentPair = mapPair(job.value, "environment");
      if (!environmentPair) continue;
      let environmentNode = environmentPair.value;
      if (isMap(environmentNode)) {
        const namePair = mapPair(environmentNode, "name");
        if (!namePair) {
          throw new Error(
            `${workflow}:${nodeLine(parsed, environmentPair.key)}: environment object has no name field.`,
          );
        }
        environmentNode = namePair.value;
      }
      const source = requiredString(
        parsed,
        environmentNode,
        `jobs.${String(job.key.value)}.environment`,
      );
      const conditionPair = mapPair(job.value, "if");
      const condition = conditionPair
        ? requiredString(
            parsed,
            conditionPair.value,
            `jobs.${String(job.key.value)}.if`,
          )
        : null;
      const sourceLine = nodeLine(parsed, environmentNode);
      references.push({
        workflow,
        line: sourceLine,
        source,
        dynamic: source.includes("${{"),
        condition,
      });
    }
  }

  return { files, references };
}

function validateExactKeys(value, expectedKeys, location, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${location} must be an object.`);
    return;
  }
  const actualKeys = Object.keys(value).sort(lexicalCompare);
  const sortedExpected = [...expectedKeys].sort(lexicalCompare);
  if (!sameJson(actualKeys, sortedExpected)) {
    errors.push(
      `${location} must have exactly these keys: ${sortedExpected.join(", ")}.`,
    );
  }
}

function expressionStringValue(literal, location) {
  if (!/^'(?:[^']|'')*'$/u.test(literal)) {
    throw new Error(
      `${location} uses an unsupported expression string literal.`,
    );
  }
  const value = literal.slice(1, -1).replaceAll("''", "'");
  if (!value) {
    throw new Error(`${location} resolves to an empty environment name.`);
  }
  return value;
}

function resolveDynamicExpression(
  expression,
  inputName,
  authorityValues,
  location,
) {
  const conditional = expression.match(
    /^\$\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_]*)\s*==\s*('(?:[^']|'')*')\s*&&\s*('(?:[^']|'')*')\s*\|\|\s*('(?:[^']|'')*')\s*\}\}$/u,
  );
  if (conditional) {
    const [, observedInput, comparedLiteral, trueLiteral, falseLiteral] =
      conditional;
    if (observedInput !== inputName) {
      throw new Error(
        `${location} reads inputs.${observedInput} instead of inputs.${inputName}.`,
      );
    }
    const comparedValue = expressionStringValue(comparedLiteral, location);
    if (!authorityValues.includes(comparedValue)) {
      throw new Error(
        `${location} compares against ${JSON.stringify(comparedValue)} outside its input authority.`,
      );
    }
    const trueValue = expressionStringValue(trueLiteral, location);
    const falseValue = expressionStringValue(falseLiteral, location);
    return [...new Set(authorityValues.map((value) =>
      value === comparedValue ? trueValue : falseValue,
    ))].sort(lexicalCompare);
  }

  const inputReference = new RegExp(
    `\\$\\{\\{\\s*inputs\\.${inputName}\\s*\\}\\}`,
    "gu",
  );
  const matches = [...expression.matchAll(inputReference)];
  if (
    matches.length !== 1 ||
    expression.replace(inputReference, "").includes("${{") ||
    expression.replace(inputReference, "").includes("}}")
  ) {
    throw new Error(
      `${location} uses an unsupported dynamic environment expression.`,
    );
  }
  const outcomes = authorityValues.map((value) =>
    expression.replace(inputReference, value),
  );
  if (outcomes.some((value) => !value.trim() || value.includes("${{"))) {
    throw new Error(`${location} does not resolve to bounded literal names.`);
  }
  return [...new Set(outcomes)].sort(lexicalCompare);
}

export function validateOperationalEnvironmentManifest(
  manifest,
  { root = moduleRoot } = {},
) {
  const errors = [];
  validateExactKeys(
    manifest,
    [
      "schemaVersion",
      "repository",
      "scope",
      "policy",
      "environments",
      "dynamicWorkflowBindings",
    ],
    "manifest",
    errors,
  );
  if (manifest?.schemaVersion !== OPERATIONAL_ENVIRONMENT_POLICY_SCHEMA) {
    errors.push(
      `schemaVersion must be ${OPERATIONAL_ENVIRONMENT_POLICY_SCHEMA}.`,
    );
  }
  if (
    typeof manifest?.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(manifest.repository)
  ) {
    errors.push("repository must be one exact OWNER/REPO value.");
  }
  if (manifest?.scope !== "all-repository-environments") {
    errors.push('scope must be "all-repository-environments".');
  }
  if (!sameJson(manifest?.policy, EXPECTED_OPERATIONAL_ENVIRONMENT_POLICY)) {
    errors.push(
      "policy must be exactly zero wait, zero reviewers, self-review allowed, and a custom main branch-only deployment policy.",
    );
  }

  const environments = Array.isArray(manifest?.environments)
    ? manifest.environments
    : [];
  if (!Array.isArray(manifest?.environments)) {
    errors.push("environments must be an array.");
  }
  const environmentNames = [];
  const environmentOrigins = new Map();
  for (const [index, environment] of environments.entries()) {
    validateExactKeys(
      environment,
      ["name", "origin"],
      `environments[${index}]`,
      errors,
    );
    const name = environment?.name;
    if (typeof name !== "string" || !name.trim() || name !== name.trim()) {
      errors.push(`environments[${index}].name must be a trimmed string.`);
      continue;
    }
    if (environmentOrigins.has(name)) {
      errors.push(`Environment ${JSON.stringify(name)} is listed more than once.`);
      continue;
    }
    if (
      environment.origin !== "workflow" &&
      environment.origin !== "live-unreferenced"
    ) {
      errors.push(
        `Environment ${JSON.stringify(name)} has unsupported origin ${JSON.stringify(environment.origin)}.`,
      );
    }
    environmentNames.push(name);
    environmentOrigins.set(name, environment.origin);
  }
  if (!sameJson(environmentNames, [...environmentNames].sort(lexicalCompare))) {
    errors.push("environments must be sorted lexically by name.");
  }

  const bindings = Array.isArray(manifest?.dynamicWorkflowBindings)
    ? manifest.dynamicWorkflowBindings
    : [];
  if (!Array.isArray(manifest?.dynamicWorkflowBindings)) {
    errors.push("dynamicWorkflowBindings must be an array.");
  }
  const bindingByKey = new Map();
  const bindingOrder = [];
  for (const [index, binding] of bindings.entries()) {
    const location = `dynamicWorkflowBindings[${index}]`;
    validateExactKeys(
      binding,
      ["workflow", "expression", "resolvesTo", "inputAuthority"],
      location,
      errors,
    );
    if (
      typeof binding?.workflow !== "string" ||
      !/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(binding.workflow)
    ) {
      errors.push(`${location}.workflow must name one workflow file.`);
      continue;
    }
    if (
      typeof binding.expression !== "string" ||
      !binding.expression.includes("${{")
    ) {
      errors.push(`${location}.expression must be one exact dynamic expression.`);
      continue;
    }
    const resolvesTo = Array.isArray(binding?.resolvesTo)
      ? binding.resolvesTo
      : [];
    if (!Array.isArray(binding?.resolvesTo) || resolvesTo.length === 0) {
      errors.push(`${location}.resolvesTo must be a non-empty array.`);
    }
    if (
      resolvesTo.some(
        (name) => typeof name !== "string" || !environmentOrigins.has(name),
      )
    ) {
      errors.push(`${location}.resolvesTo contains an unregistered environment.`);
    }
    if (
      !sameJson(
        resolvesTo,
        [...new Set(resolvesTo)].sort(lexicalCompare),
      )
    ) {
      errors.push(`${location}.resolvesTo must be unique and lexically sorted.`);
    }
    const inputAuthority = binding?.inputAuthority;
    validateExactKeys(
      inputAuthority,
      ["kind", "input", "values"],
      `${location}.inputAuthority`,
      errors,
    );
    const authorityValues = Array.isArray(inputAuthority?.values)
      ? inputAuthority.values
      : [];
    if (
      typeof inputAuthority?.input !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(inputAuthority.input)
    ) {
      errors.push(`${location}.inputAuthority.input is invalid.`);
    }
    if (
      inputAuthority?.kind !== "workflow-dispatch-choice" &&
      inputAuthority?.kind !== "local-reusable-workflow-callers"
    ) {
      errors.push(`${location}.inputAuthority.kind is unsupported.`);
    }
    if (
      authorityValues.length === 0 ||
      authorityValues.some(
        (value) => typeof value !== "string" || !value.trim(),
      ) ||
      !sameJson(
        authorityValues,
        [...new Set(authorityValues)].sort(lexicalCompare),
      )
    ) {
      errors.push(
        `${location}.inputAuthority.values must be non-empty, unique, and lexically sorted.`,
      );
    }
    if (
      inputAuthority?.kind === "local-reusable-workflow-callers" &&
      !sameJson(authorityValues, resolvesTo)
    ) {
      errors.push(
        `${location} reusable caller values must exactly equal resolvesTo.`,
      );
    }
    try {
      const observedValues =
        inputAuthority?.kind === "workflow-dispatch-choice"
          ? workflowDispatchChoiceValues(
              root,
              binding.workflow,
              inputAuthority.input,
            )
          : localReusableWorkflowCallerValues(
              root,
              binding.workflow,
              inputAuthority.input,
              manifest.repository,
            );
      const unauthorizedValues = observedValues.filter(
        (value) => !authorityValues.includes(value),
      );
      if (unauthorizedValues.length > 0) {
        errors.push(
          `${location} observed unauthorized input values: ${unauthorizedValues.join(", ")}.`,
        );
      }
      if (!sameJson(observedValues, authorityValues)) {
        errors.push(
          `${location} input authority does not exactly match its observed values.`,
        );
      }
      const derivedValues = resolveDynamicExpression(
        binding.expression,
        inputAuthority.input,
        authorityValues,
        location,
      );
      if (!sameJson(derivedValues, resolvesTo)) {
        errors.push(
          `${location}.resolvesTo does not exactly match derived expression outcomes: ${derivedValues.join(", ")}.`,
        );
      }
    } catch (error) {
      errors.push(`${location}: ${error.message}`);
    }
    const key = `${binding.workflow}\u0000${binding.expression}`;
    if (bindingByKey.has(key)) {
      errors.push(`${location} duplicates an earlier file-scoped binding.`);
    }
    bindingByKey.set(key, binding);
    bindingOrder.push(key);
  }
  if (!sameJson(bindingOrder, [...bindingOrder].sort(lexicalCompare))) {
    errors.push("dynamicWorkflowBindings must be sorted by workflow and expression.");
  }

  let scan;
  try {
    scan = extractWorkflowEnvironmentReferences(root);
  } catch (error) {
    errors.push(error.message);
    scan = { files: [], references: [] };
  }
  const workflowEnvironmentNames = new Set();
  const usedBindings = new Set();
  for (const reference of scan.references) {
    const location = `${reference.workflow}:${reference.line}`;
    if (reference.dynamic) {
      const key = `${reference.workflow}\u0000${reference.source}`;
      const binding = bindingByKey.get(key);
      if (!binding) {
        errors.push(
          `${location}: dynamic environment ${JSON.stringify(reference.source)} has no exact file-scoped binding.`,
        );
        continue;
      }
      if (binding.inputAuthority.kind === "local-reusable-workflow-callers") {
        const requiredCondition = `\${{ github.repository == '${manifest.repository}' }}`;
        if (reference.condition !== requiredCondition) {
          errors.push(
            `${location}: reusable environment job must have exact repository guard ${JSON.stringify(requiredCondition)} before environment access.`,
          );
        }
        const boundedConditional = binding.expression.match(
          /^\$\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_]*)\s*==\s*('(?:[^']|'')*')\s*&&\s*('(?:[^']|'')*')\s*\|\|\s*('(?:[^']|'')*')\s*\}\}$/u,
        );
        if (boundedConditional?.[1] !== binding.inputAuthority.input) {
          errors.push(
            `${location}: reusable environment must use one bounded conditional over inputs.${binding.inputAuthority.input}; direct caller input passthrough is forbidden.`,
          );
        }
      }
      usedBindings.add(key);
      for (const name of binding.resolvesTo) {
        workflowEnvironmentNames.add(name);
      }
      continue;
    }
    workflowEnvironmentNames.add(reference.source);
    if (!environmentOrigins.has(reference.source)) {
      errors.push(
        `${location}: environment ${JSON.stringify(reference.source)} is not registered in the manifest.`,
      );
    }
  }
  for (const [key, binding] of bindingByKey) {
    if (!usedBindings.has(key)) {
      errors.push(
        `Dynamic binding for ${binding.workflow} and ${JSON.stringify(binding.expression)} does not match a current workflow environment reference.`,
      );
    }
  }
  for (const [name, origin] of environmentOrigins) {
    const referenced = workflowEnvironmentNames.has(name);
    if (origin === "workflow" && !referenced) {
      errors.push(
        `Environment ${JSON.stringify(name)} is marked workflow but no workflow resolves to it.`,
      );
    }
    if (origin === "live-unreferenced" && referenced) {
      errors.push(
        `Environment ${JSON.stringify(name)} is workflow-referenced and must use origin workflow.`,
      );
    }
  }
  for (const name of workflowEnvironmentNames) {
    if (!environmentOrigins.has(name)) {
      errors.push(
        `Workflow-resolved environment ${JSON.stringify(name)} is not registered in the manifest.`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `GitHub operational environment policy is invalid:\n- ${errors.join("\n- ")}`,
    );
  }

  return {
    manifest,
    manifestEnvironmentNames: environmentNames,
    workflowEnvironmentNames: [...workflowEnvironmentNames].sort(
      lexicalCompare,
    ),
    workflowFileCount: scan.files.length,
    environmentReferenceCount: scan.references.length,
    dynamicBindingCount: bindings.length,
  };
}

export function loadAndValidateOperationalEnvironmentManifest({
  root = moduleRoot,
  manifestPath = path.join(
    root,
    ".github/operational-environment-policy.json",
  ),
} = {}) {
  const source = fs.readFileSync(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${path.relative(root, manifestPath)}: ${error.message}`,
    );
  }
  return validateOperationalEnvironmentManifest(manifest, { root });
}

function parseArguments(argv) {
  let manifestPath = defaultManifestPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") {
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
  return { manifestPath };
}

function runCli() {
  const { manifestPath } = parseArguments(process.argv.slice(2));
  const result = loadAndValidateOperationalEnvironmentManifest({
    root: moduleRoot,
    manifestPath,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        schemaVersion: result.manifest.schemaVersion,
        repository: result.manifest.repository,
        workflowFiles: result.workflowFileCount,
        environmentReferences: result.environmentReferenceCount,
        workflowEnvironments: result.workflowEnvironmentNames.length,
        managedEnvironments: result.manifestEnvironmentNames.length,
        dynamicBindings: result.dynamicBindingCount,
      },
      null,
      2,
    )}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
