import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_CLI_BLOCKED_RECEIPT,
} from "../scripts/execute-permanent-staging-supabase-key-replacement.js";
import {
  createPermanentStagingSupabaseKeyCustody,
} from "../scripts/lib/permanent-staging-supabase-key-input.js";
import {
  PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_ACK_SCHEMA,
  PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_CANONICAL_POLICY_SOURCE,
  PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_OBSERVATION_SCHEMA,
  PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY,
  evaluatePermanentStagingSupabaseKeyReplacementState,
  parsePermanentStagingSupabaseKeyReplacementAcknowledgement,
  parsePermanentStagingSupabaseKeyReplacementObservation,
  parsePermanentStagingSupabaseKeyReplacementPolicy,
  runPermanentStagingSupabaseKeyReplacementFixtureAttempt,
} from "../scripts/lib/permanent-staging-supabase-key-replacement.js";

const target = PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.railwayTarget;
const deploymentId = "235d6994-7bd4-4a13-b1dc-f255775d5dc0";
const canaryDeploymentId = "335d6994-7bd4-4a13-b1dc-f255775d5dc0";

function keyBuffers() {
  return {
    SUPABASE_ANON_KEY: Buffer.from(`sb_publishable_${"a".repeat(32)}`),
    SUPABASE_SERVICE_ROLE_KEY: Buffer.from(`sb_secret_${"b".repeat(32)}`),
  };
}

function observationObject() {
  return {
    schemaVersion: PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_OBSERVATION_SCHEMA,
    projectId: target.projectId,
    environmentId: target.environmentId,
    inventoryComplete: true,
    externalMutationFreezeActive: true,
    variables: PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.keys.flatMap(
      (key) => [
        {
          name: key.name,
          serviceId: target.applicationServiceId,
          isSealed: key.expectedSealed,
          reference: null,
        },
        {
          name: key.name,
          serviceId: target.canaryServiceId,
          isSealed: key.expectedSealed,
          reference: {
            sourceServiceId: target.applicationServiceId,
            sourceVariableName: key.name,
          },
        },
      ],
    ),
    stagedPatchNames: [] as string[],
    deployments: [
      { id: deploymentId, serviceId: target.applicationServiceId, status: "SUCCESS" },
      { id: canaryDeploymentId, serviceId: target.canaryServiceId, status: "SUCCESS" },
    ],
  };
}

function observation(
  mutate: (value: ReturnType<typeof observationObject>) => void = () => undefined,
): string {
  const value = observationObject();
  mutate(value);
  return JSON.stringify(value);
}

function acknowledgement(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_ACK_SCHEMA,
    operationName: "variableCollectionUpsert",
    projectId: target.projectId,
    environmentId: target.environmentId,
    serviceId: target.applicationServiceId,
    skipDeploys: true,
    mergedVariableNames: [
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    ],
    acknowledged: true,
    ...overrides,
  });
}

describe("permanent-staging Supabase two-key replacement contract", () => {
  it("pins a hard-disabled exact two-key, one-merge, skip-deploy policy", () => {
    const checkedIn = fs.readFileSync(
      path.resolve("ops/railway/permanent-staging-supabase-key-replacement-policy.json"),
      "utf8",
    );
    expect(checkedIn).toBe(
      PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_CANONICAL_POLICY_SOURCE,
    );
    expect(parsePermanentStagingSupabaseKeyReplacementPolicy(checkedIn)).toBe(
      PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY,
    );
    expect(PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY).toMatchObject({
      activationState: "HARD_DISABLED_REVIEW_REQUIRED",
      mutation: {
        operationName: "variableCollectionUpsert",
        mergeCardinality: "exactly-one-all-or-nothing",
        skipDeploys: true,
        maximumAttempts: 1,
        retriesAllowed: false,
        sharedEnvironmentTargetAllowed: false,
        stagedPatchAllowed: false,
        deploymentDeltaAllowed: false,
      },
    });
    expect(PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_POLICY.keys.map(
      (key) => [key.name, key.format],
    )).toEqual([
      ["SUPABASE_ANON_KEY", "sb_publishable"],
      ["SUPABASE_SERVICE_ROLE_KEY", "sb_secret"],
    ]);
    expect(parsePermanentStagingSupabaseKeyReplacementPolicy(
      checkedIn.replace("HARD_DISABLED", "ENABLED"),
    )).toBeNull();
    expect(parsePermanentStagingSupabaseKeyReplacementPolicy(`${checkedIn}\n`))
      .toBeNull();
  });

  it("accepts only exact targets, app literals, canary references, no patch, and no deployment delta", () => {
    const before = parsePermanentStagingSupabaseKeyReplacementObservation(
      observation(),
    )!;
    const ack = parsePermanentStagingSupabaseKeyReplacementAcknowledgement(
      acknowledgement(),
    )!;
    const after = parsePermanentStagingSupabaseKeyReplacementObservation(
      observation(),
    )!;
    expect(evaluatePermanentStagingSupabaseKeyReplacementState(
      before,
      ack,
      after,
    )).toEqual({
      targetExact: true,
      noSharedShadows: true,
      noStagedPatch: true,
      deploymentUnchanged: true,
      externalMutationFreezeActive: true,
      passed: true,
    });
  });

  it.each([
    ["partial set", (value: ReturnType<typeof observationObject>) => {
      value.variables.pop();
    }, "noSharedShadows"],
    ["extra shadow", (value: ReturnType<typeof observationObject>) => {
      value.variables.push({
        name: "SUPABASE_ANON_KEY",
        serviceId: "735d6994-7bd4-4a13-b1dc-f255775d5dc0",
        isSealed: false,
        reference: null,
      });
    }, "noSharedShadows"],
    ["shared shadow", (value: ReturnType<typeof observationObject>) => {
      value.variables.push({
        name: "SUPABASE_ANON_KEY",
        serviceId: null as unknown as string,
        isSealed: false,
        reference: null,
      });
    }, "noSharedShadows"],
    ["staged patch", (value: ReturnType<typeof observationObject>) => {
      value.stagedPatchNames.push("SUPABASE_ANON_KEY");
    }, "noStagedPatch"],
  ])("fails closed on %s", (_label, mutate, failedCheck) => {
    const before = parsePermanentStagingSupabaseKeyReplacementObservation(
      observation(),
    )!;
    const after = parsePermanentStagingSupabaseKeyReplacementObservation(
      observation(mutate),
    )!;
    const result = evaluatePermanentStagingSupabaseKeyReplacementState(
      before,
      parsePermanentStagingSupabaseKeyReplacementAcknowledgement(acknowledgement())!,
      after,
    );
    expect(result[failedCheck as keyof typeof result]).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("rejects a wrong target, partial acknowledgement, extra key, or retry-shaped acknowledgement", () => {
    expect(parsePermanentStagingSupabaseKeyReplacementObservation(observation(
      (value) => { value.environmentId = "435d6994-7bd4-4a13-b1dc-f255775d5dc0"; },
    ))).not.toBeNull();
    expect(parsePermanentStagingSupabaseKeyReplacementAcknowledgement(
      acknowledgement({ mergedVariableNames: ["SUPABASE_ANON_KEY"] }),
    )).toBeNull();
    expect(parsePermanentStagingSupabaseKeyReplacementAcknowledgement(
      acknowledgement({
        mergedVariableNames: [
          "SUPABASE_ANON_KEY",
          "SUPABASE_SERVICE_ROLE_KEY",
          "EXTRA",
        ],
      }),
    )).toBeNull();
    expect(parsePermanentStagingSupabaseKeyReplacementAcknowledgement(
      acknowledgement({ attempt: 2 }),
    )).toBeNull();
  });

  it("detects any deployment inventory delta", () => {
    const before = parsePermanentStagingSupabaseKeyReplacementObservation(
      observation(),
    )!;
    const after = parsePermanentStagingSupabaseKeyReplacementObservation(
      observation((value) => { value.deployments[0]!.status = "DEPLOYING"; }),
    )!;
    const result = evaluatePermanentStagingSupabaseKeyReplacementState(
      before,
      parsePermanentStagingSupabaseKeyReplacementAcknowledgement(acknowledgement())!,
      after,
    );
    expect(result.deploymentUnchanged).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("runs one fixture-only mocked transport attempt after durable intent and zeroizes all values", async () => {
    const source = keyBuffers();
    const custody = createPermanentStagingSupabaseKeyCustody(source);
    const intents: unknown[] = [];
    const terminals: unknown[] = [];
    let retained: readonly Buffer[] = [];
    const transport = vi.fn(async (request: { variables: Record<string, Buffer> }) => {
      retained = Object.values(request.variables);
      expect(request).toMatchObject({
        operationName: "variableCollectionUpsert",
        projectId: target.projectId,
        environmentId: target.environmentId,
        serviceId: target.applicationServiceId,
        skipDeploys: true,
        attemptOrdinal: 1,
      });
      expect(retained.every((value) => value.some((byte) => byte !== 0))).toBe(true);
      expect(intents).toHaveLength(1);
      return {
        acknowledgementSource: acknowledgement(),
        postflightSource: observation(),
      };
    });
    const result = await runPermanentStagingSupabaseKeyReplacementFixtureAttempt({
      fixtureOnly: true,
      preflightSource: observation(),
      custody,
      signal: new AbortController().signal,
      persistIntent: async (value) => { intents.push(value); },
      transport,
      persistTerminal: async (value) => { terminals.push(value); },
    });
    expect(result.outcome).toBe("passed");
    expect(result.attempts).toBe(1);
    expect(result.retryAllowed).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(intents).toHaveLength(1);
    expect(terminals).toEqual([result]);
    expect(retained.every((value) => value.equals(Buffer.alloc(value.length))))
      .toBe(true);
    const evidence = JSON.stringify({ intents, terminals });
    expect(evidence).not.toContain("sb_publishable_");
    expect(evidence).not.toContain("sb_secret_");
    expect(evidence).not.toContain("commitment");
  });

  it("stops without retry on an ambiguous transport outcome", async () => {
    const transport = vi.fn(async () => {
      throw new Error(`private-${"sb_secret_"}-diagnostic`);
    });
    const terminals: unknown[] = [];
    const result = await runPermanentStagingSupabaseKeyReplacementFixtureAttempt({
      fixtureOnly: true,
      preflightSource: observation(),
      custody: createPermanentStagingSupabaseKeyCustody(keyBuffers()),
      signal: new AbortController().signal,
      persistIntent: async () => undefined,
      transport,
      persistTerminal: async (value) => { terminals.push(value); },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: "ambiguous-stop-no-retry",
      attempts: 1,
      retryAllowed: false,
    });
    expect(JSON.stringify(terminals)).not.toContain("private-sb_secret_");
  });

  it("maps later abort of a published never-settling transport to one ambiguous attempt and handles late rejection", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const transportEntered = new Promise<void>((resolve) => { entered = resolve; });
    let rejectTransport!: (error: unknown) => void;
    const transportPromise = new Promise<never>((_resolve, reject) => {
      rejectTransport = reject;
    });
    let retained: readonly Buffer[] = [];
    const transport = vi.fn((request: { variables: Record<string, Buffer> }) => {
      retained = [
        request.variables.SUPABASE_ANON_KEY!,
        request.variables.SUPABASE_SERVICE_ROLE_KEY!,
      ];
      entered();
      return transportPromise;
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const pending = runPermanentStagingSupabaseKeyReplacementFixtureAttempt({
        fixtureOnly: true,
        preflightSource: observation(),
        custody: createPermanentStagingSupabaseKeyCustody(keyBuffers()),
        signal: controller.signal,
        persistIntent: async () => undefined,
        transport,
        persistTerminal: async () => undefined,
      });
      await transportEntered;
      controller.abort();
      await expect(pending).resolves.toMatchObject({
        outcome: "ambiguous-stop-no-retry",
        attempts: 1,
        retryAllowed: false,
        checks: { singleMergeAttempted: true },
      });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(retained.every((value) => value.equals(Buffer.alloc(value.length))))
        .toBe(true);
      rejectTransport(new Error("late transport rejection"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      process.removeListener("unhandledRejection", unhandled);
    }
  });

  it("cannot revive an invalid four-row preflight through poisoned Array.prototype.every", async () => {
    const invalidPreflight = observation((value) => {
      value.variables[0]!.isSealed = true;
    });
    const custody = createPermanentStagingSupabaseKeyCustody(keyBuffers());
    const transport = vi.fn();
    const originalEvery = Array.prototype.every;
    const poisonEvery = vi.fn(() => true);
    let result: Awaited<ReturnType<
      typeof runPermanentStagingSupabaseKeyReplacementFixtureAttempt
    >> | undefined;
    try {
      Array.prototype.every = poisonEvery as typeof Array.prototype.every;
      result = await runPermanentStagingSupabaseKeyReplacementFixtureAttempt({
        fixtureOnly: true,
        preflightSource: invalidPreflight,
        custody,
        signal: new AbortController().signal,
        persistIntent: async () => undefined,
        transport,
        persistTerminal: async () => undefined,
      });
    } finally {
      Array.prototype.every = originalEvery;
    }
    expect(poisonEvery).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "failed-before-attempt",
      attempts: 0,
      retryAllowed: false,
    });
  });

  it("cannot substitute a valid inventory through constructor Symbol.species proxies", async () => {
    const invalidPreflight = observation((value) => {
      value.variables[0]!.isSealed = true;
    });
    const validAnonApplicationRow = observationObject().variables[0]!;
    const custody = createPermanentStagingSupabaseKeyCustody(keyBuffers());
    const transport = vi.fn();
    const constructorDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "constructor",
    )!;
    const definePropertyExact = Object.defineProperty;
    const reflectDefinePropertyExact = Reflect.defineProperty;
    const reflectGetExact = Reflect.get;
    const substitutionDefine = vi.fn((
      arrayTarget: unknown[],
      property: string | symbol,
      descriptor: PropertyDescriptor,
    ) => {
      const candidate = descriptor.value as {
        name?: unknown;
        serviceId?: unknown;
        isSealed?: unknown;
      } | undefined;
      const replacement = candidate?.name === "SUPABASE_ANON_KEY"
          && candidate.serviceId === target.applicationServiceId
          && candidate.isSealed === true
        ? validAnonApplicationRow
        : descriptor.value;
      return reflectDefinePropertyExact(arrayTarget, property, {
        ...descriptor,
        value: replacement,
      });
    });
    const speciesConstruct = vi.fn(() => new Proxy([], {
      defineProperty: substitutionDefine,
    }));
    const speciesConstructor = new Proxy(function SpeciesTarget() {}, {
      construct: speciesConstruct,
    });
    const constructorSpeciesGet = vi.fn((
      constructorTarget: object,
      property: string | symbol,
      receiver: unknown,
    ) => property === Symbol.species
      ? speciesConstructor
      : reflectGetExact(constructorTarget, property, receiver));
    const constructorPoison = new Proxy({}, { get: constructorSpeciesGet });
    let result: Awaited<ReturnType<
      typeof runPermanentStagingSupabaseKeyReplacementFixtureAttempt
    >> | undefined;
    try {
      definePropertyExact(Array.prototype, "constructor", {
        ...constructorDescriptor,
        value: constructorPoison,
      });
      result = await runPermanentStagingSupabaseKeyReplacementFixtureAttempt({
        fixtureOnly: true,
        preflightSource: invalidPreflight,
        custody,
        signal: new AbortController().signal,
        persistIntent: async () => undefined,
        transport,
        persistTerminal: async () => undefined,
      });
    } finally {
      definePropertyExact(
        Array.prototype,
        "constructor",
        constructorDescriptor,
      );
    }
    expect(constructorSpeciesGet).not.toHaveBeenCalled();
    expect(speciesConstruct).not.toHaveBeenCalled();
    expect(substitutionDefine).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "failed-before-attempt",
      attempts: 0,
      retryAllowed: false,
    });
  });

  it("keeps every containment runtime free of ArraySpeciesCreate operations", () => {
    const runtimePaths = [
      "scripts/execute-permanent-staging-supabase-key-replacement.ts",
      "scripts/lib/permanent-staging-supabase-containment-primitives.ts",
      "scripts/lib/permanent-staging-supabase-key-canary-b.ts",
      "scripts/lib/permanent-staging-supabase-key-input.ts",
      "scripts/lib/permanent-staging-supabase-key-replacement.ts",
      "scripts/lib/permanent-staging-supabase-legacy-key-disable.ts",
      "scripts/lib/permanent-staging-supabase-old-key-denial.ts",
    ];
    const speciesCreatingOperation =
      /Array\.prototype\.(?:concat|filter|flat|flatMap|map|slice|splice)\b|\.(?:concat|filter|flat|flatMap|map|slice|splice)\s*\(|Array\.(?:from|of)\s*\(/;
    for (const runtimePath of runtimePaths) {
      expect(fs.readFileSync(path.resolve(runtimePath), "utf8"))
        .not.toMatch(speciesCreatingOperation);
    }
  });

  it("parses and evaluates through captured Array/Object/RegExp/Set/Buffer/JSON/Reflect intrinsics", () => {
    const beforeSource = observation();
    const afterSource = observation();
    const acknowledgementSource = acknowledgement();
    const originals = {
      arrayIsArray: Array.isArray,
      arrayEvery: Array.prototype.every,
      arrayFilter: Array.prototype.filter,
      arrayFind: Array.prototype.find,
      arrayIncludes: Array.prototype.includes,
      arrayMap: Array.prototype.map,
      arraySome: Array.prototype.some,
      objectDefineProperty: Object.defineProperty,
      objectFreeze: Object.freeze,
      objectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
      objectGetOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
      objectGetPrototypeOf: Object.getPrototypeOf,
      objectHasOwn: Object.hasOwn,
      objectIsFrozen: Object.isFrozen,
      objectValues: Object.values,
      regexpExec: RegExp.prototype.exec,
      regexpTest: RegExp.prototype.test,
      setAdd: Set.prototype.add,
      bufferByteLength: Buffer.byteLength,
      jsonParse: JSON.parse,
      jsonStringify: JSON.stringify,
      reflectApply: Reflect.apply,
      reflectOwnKeys: Reflect.ownKeys,
    };
    const poisons = Array.from({ length: Object.keys(originals).length }, () =>
      vi.fn(() => { throw new Error("poison intrinsic invoked"); }));
    const objectToJsonDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    const arrayToJsonDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "toJSON",
    );
    const definePropertyExact = Object.defineProperty;
    const objectToJsonPoison = vi.fn(() => {
      throw new Error("poison Object.prototype.toJSON invoked");
    });
    const arrayToJsonPoison = vi.fn(() => {
      throw new Error("poison Array.prototype.toJSON invoked");
    });
    let parsedBefore: ReturnType<
      typeof parsePermanentStagingSupabaseKeyReplacementObservation
    >;
    let parsedAfter: ReturnType<
      typeof parsePermanentStagingSupabaseKeyReplacementObservation
    >;
    let parsedAck: ReturnType<
      typeof parsePermanentStagingSupabaseKeyReplacementAcknowledgement
    >;
    let evaluation: ReturnType<
      typeof evaluatePermanentStagingSupabaseKeyReplacementState
    > | undefined;
    try {
      Array.isArray = poisons[0] as typeof Array.isArray;
      Array.prototype.every = poisons[1] as typeof Array.prototype.every;
      Array.prototype.filter = poisons[2] as typeof Array.prototype.filter;
      Array.prototype.find = poisons[3] as typeof Array.prototype.find;
      Array.prototype.includes = poisons[4] as typeof Array.prototype.includes;
      Array.prototype.map = poisons[5] as typeof Array.prototype.map;
      Array.prototype.some = poisons[6] as typeof Array.prototype.some;
      Object.defineProperty = poisons[7] as typeof Object.defineProperty;
      Object.freeze = poisons[8] as typeof Object.freeze;
      Object.getOwnPropertyDescriptor =
        poisons[9] as typeof Object.getOwnPropertyDescriptor;
      Object.getOwnPropertyDescriptors =
        poisons[10] as typeof Object.getOwnPropertyDescriptors;
      Object.getPrototypeOf = poisons[11] as typeof Object.getPrototypeOf;
      Object.hasOwn = poisons[12] as typeof Object.hasOwn;
      Object.isFrozen = poisons[13] as typeof Object.isFrozen;
      Object.values = poisons[14] as typeof Object.values;
      RegExp.prototype.exec = poisons[15] as typeof RegExp.prototype.exec;
      RegExp.prototype.test = poisons[16] as typeof RegExp.prototype.test;
      Set.prototype.add = poisons[17] as typeof Set.prototype.add;
      Buffer.byteLength = poisons[18] as typeof Buffer.byteLength;
      JSON.parse = poisons[19] as typeof JSON.parse;
      JSON.stringify = poisons[20] as typeof JSON.stringify;
      Reflect.apply = poisons[21] as typeof Reflect.apply;
      Reflect.ownKeys = poisons[22] as typeof Reflect.ownKeys;
      definePropertyExact(Object.prototype, "toJSON", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: objectToJsonPoison,
      });
      definePropertyExact(Array.prototype, "toJSON", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: arrayToJsonPoison,
      });

      parsedBefore = parsePermanentStagingSupabaseKeyReplacementObservation(
        beforeSource,
      );
      parsedAfter = parsePermanentStagingSupabaseKeyReplacementObservation(
        afterSource,
      );
      parsedAck = parsePermanentStagingSupabaseKeyReplacementAcknowledgement(
        acknowledgementSource,
      );
      if (parsedBefore && parsedAfter && parsedAck) {
        evaluation = evaluatePermanentStagingSupabaseKeyReplacementState(
          parsedBefore,
          parsedAck,
          parsedAfter,
        );
      }
    } finally {
      Array.isArray = originals.arrayIsArray;
      Array.prototype.every = originals.arrayEvery;
      Array.prototype.filter = originals.arrayFilter;
      Array.prototype.find = originals.arrayFind;
      Array.prototype.includes = originals.arrayIncludes;
      Array.prototype.map = originals.arrayMap;
      Array.prototype.some = originals.arraySome;
      Object.defineProperty = originals.objectDefineProperty;
      Object.freeze = originals.objectFreeze;
      Object.getOwnPropertyDescriptor = originals.objectGetOwnPropertyDescriptor;
      Object.getOwnPropertyDescriptors = originals.objectGetOwnPropertyDescriptors;
      Object.getPrototypeOf = originals.objectGetPrototypeOf;
      Object.hasOwn = originals.objectHasOwn;
      Object.isFrozen = originals.objectIsFrozen;
      Object.values = originals.objectValues;
      RegExp.prototype.exec = originals.regexpExec;
      RegExp.prototype.test = originals.regexpTest;
      Set.prototype.add = originals.setAdd;
      Buffer.byteLength = originals.bufferByteLength;
      JSON.parse = originals.jsonParse;
      JSON.stringify = originals.jsonStringify;
      Reflect.apply = originals.reflectApply;
      Reflect.ownKeys = originals.reflectOwnKeys;
      if (objectToJsonDescriptor) {
        definePropertyExact(Object.prototype, "toJSON", objectToJsonDescriptor);
      } else {
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      }
      if (arrayToJsonDescriptor) {
        definePropertyExact(Array.prototype, "toJSON", arrayToJsonDescriptor);
      } else {
        delete (Array.prototype as { toJSON?: unknown }).toJSON;
      }
    }
    expect(parsedBefore).not.toBeNull();
    expect(parsedAfter).not.toBeNull();
    expect(parsedAck).not.toBeNull();
    expect(evaluation?.passed).toBe(true);
    for (const poison of poisons) expect(poison).not.toHaveBeenCalled();
    expect(objectToJsonPoison).not.toHaveBeenCalled();
    expect(arrayToJsonPoison).not.toHaveBeenCalled();
  });

  it("never attempts transport when preflight or durable intent fails", async () => {
    const transport = vi.fn();
    const terminal = vi.fn(async () => undefined);
    const invalidPreflight = await runPermanentStagingSupabaseKeyReplacementFixtureAttempt({
      fixtureOnly: true,
      preflightSource: observation((value) => { value.variables.pop(); }),
      custody: createPermanentStagingSupabaseKeyCustody(keyBuffers()),
      signal: new AbortController().signal,
      persistIntent: vi.fn(),
      transport,
      persistTerminal: terminal,
    });
    expect(invalidPreflight.attempts).toBe(0);
    expect(transport).not.toHaveBeenCalled();

    await expect(runPermanentStagingSupabaseKeyReplacementFixtureAttempt({
      fixtureOnly: true,
      preflightSource: observation(),
      custody: createPermanentStagingSupabaseKeyCustody(keyBuffers()),
      signal: new AbortController().signal,
      persistIntent: async () => { throw new Error("disk diagnostic"); },
      transport,
      persistTerminal: terminal,
    })).rejects.toThrow("intent_persistence_failed");
    expect(transport).not.toHaveBeenCalled();
  });

  it("ships only a hard-disabled CLI with no provider-capable imports", () => {
    const cliPath = path.resolve(
      "scripts/execute-permanent-staging-supabase-key-replacement.ts",
    );
    const source = fs.readFileSync(cliPath, "utf8");
    for (const forbidden of [
      "node:child_process",
      "node:fs",
      "fetch(",
      "spawn(",
      "execFile(",
      "process.stdin",
      "process.env",
      "RAILWAY_TOKEN",
      "SUPABASE_ACCESS_TOKEN",
    ]) expect(source).not.toContain(forbidden);

    const result = spawnSync(process.execPath, ["--import=tsx", cliPath], {
      cwd: process.cwd(),
      env: {},
      encoding: "utf8",
      input: `sb_secret_${"x".repeat(32)}`,
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `${JSON.stringify(PERMANENT_STAGING_SUPABASE_KEY_REPLACEMENT_CLI_BLOCKED_RECEIPT)}\n`,
    );
    expect(result.stdout).not.toContain("sb_secret_");
  });
});
