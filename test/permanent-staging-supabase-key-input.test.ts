import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  PERMANENT_STAGING_SUPABASE_KEY_INPUT_SCHEMA,
  PERMANENT_STAGING_SUPABASE_KEY_NAMES,
  createPermanentStagingSupabaseKeyCustody,
} from "../scripts/lib/permanent-staging-supabase-key-input.js";

function validBuffers(overrides: Partial<Record<
  typeof PERMANENT_STAGING_SUPABASE_KEY_NAMES[number],
  string
>> = {}) {
  return {
    SUPABASE_ANON_KEY: Buffer.from(
      overrides.SUPABASE_ANON_KEY ?? `sb_publishable_${"a".repeat(32)}`,
    ),
    SUPABASE_SERVICE_ROLE_KEY: Buffer.from(
      overrides.SUPABASE_SERVICE_ROLE_KEY ?? `sb_secret_${"b".repeat(32)}`,
    ),
    OFFSITE_BACKUP_SERVICE_ROLE_KEY: Buffer.from(
      overrides.OFFSITE_BACKUP_SERVICE_ROLE_KEY ?? `sb_secret_${"c".repeat(32)}`,
    ),
  };
}

function allZero(values: Record<string, Buffer>): boolean {
  return Object.values(values).every((value) =>
    value.equals(Buffer.alloc(value.length)));
}

describe("permanent-staging Supabase replacement-key input custody", () => {
  it("captures exactly three bounded new-format keys and publishes no secret-derived evidence", () => {
    const input = validBuffers();
    const custody = createPermanentStagingSupabaseKeyCustody(input);
    expect(allZero(input)).toBe(true);
    expect(custody.inspect()).toEqual({
      schemaVersion: PERMANENT_STAGING_SUPABASE_KEY_INPUT_SCHEMA,
      keyNames: PERMANENT_STAGING_SUPABASE_KEY_NAMES,
      formatsExact: true,
      keysDistinct: true,
      bounded: true,
      secretMaterialPublished: false,
      secretDerivedCommitmentsPublished: false,
    });
    expect(JSON.stringify(custody.inspect())).not.toMatch(
      /sha|length|sb_publishable|sb_secret/i,
    );
    expect(Object.isFrozen(custody)).toBe(true);
    expect(Object.isFrozen(custody.inspect())).toBe(true);
    custody.close();
  });

  it.each([
    ["partial input", () => {
      const input = validBuffers() as Record<string, Buffer>;
      delete input.OFFSITE_BACKUP_SERVICE_ROLE_KEY;
      return input;
    }],
    ["extra input", () => ({ ...validBuffers(), EXTRA_KEY: Buffer.from("extra") })],
    ["legacy anon", () => validBuffers({ SUPABASE_ANON_KEY: "legacy.jwt.anon" })],
    ["wrong publishable position", () => validBuffers({
      SUPABASE_ANON_KEY: `sb_secret_${"a".repeat(32)}`,
    })],
    ["wrong secret position", () => validBuffers({
      SUPABASE_SERVICE_ROLE_KEY: `sb_publishable_${"b".repeat(32)}`,
    })],
    ["whitespace", () => validBuffers({
      OFFSITE_BACKUP_SERVICE_ROLE_KEY: `sb_secret_${"c".repeat(31)} `,
    })],
    ["reused secret", () => validBuffers({
      OFFSITE_BACKUP_SERVICE_ROLE_KEY: `sb_secret_${"b".repeat(32)}`,
    })],
    ["oversized", () => validBuffers({
      SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${"b".repeat(247)}`,
    })],
  ])("rejects %s and wipes every supplied Buffer", (_label, create) => {
    const input = create();
    expect(() => createPermanentStagingSupabaseKeyCustody(input)).toThrow(
      expect.objectContaining({ code: "key_input_invalid" }),
    );
    expect(allZero(input)).toBe(true);
  });

  it("never invokes input accessors while rejecting them", () => {
    const getter = vi.fn(() => Buffer.from(`sb_publishable_${"a".repeat(32)}`));
    const input = validBuffers() as Record<string, Buffer>;
    Object.defineProperty(input, "SUPABASE_ANON_KEY", {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    expect(() => createPermanentStagingSupabaseKeyCustody(input)).toThrow(
      expect.objectContaining({ code: "key_input_invalid" }),
    );
    expect(getter).not.toHaveBeenCalled();
    expect(input.SUPABASE_SERVICE_ROLE_KEY.equals(
      Buffer.alloc(input.SUPABASE_SERVICE_ROLE_KEY.length),
    )).toBe(true);
  });

  it("publishes the three Buffers once, then zeroizes retained views", async () => {
    const custody = createPermanentStagingSupabaseKeyCustody(validBuffers());
    let retained: readonly Buffer[] = [];
    const writer = vi.fn(async (keys: Record<string, Buffer>) => {
      retained = Object.values(keys);
      expect(retained.every((value) => value.some((byte) => byte !== 0))).toBe(true);
      return "ack";
    });
    await expect(custody.useExactlyOnce(writer, new AbortController().signal))
      .resolves.toBe("ack");
    expect(writer).toHaveBeenCalledTimes(1);
    expect(retained.every((value) => value.equals(Buffer.alloc(value.length))))
      .toBe(true);
    expect(() => custody.inspect()).toThrow(
      expect.objectContaining({ code: "key_input_unavailable" }),
    );
    await expect(custody.useExactlyOnce(writer, new AbortController().signal))
      .rejects.toMatchObject({ code: "key_input_unavailable" });
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("zeroizes after writer rejection and never permits a retry", async () => {
    const custody = createPermanentStagingSupabaseKeyCustody(validBuffers());
    let retained: readonly Buffer[] = [];
    const writer = vi.fn(async (keys: Record<string, Buffer>) => {
      retained = Object.values(keys);
      throw new Error("provider diagnostic containing a key");
    });
    await expect(custody.useExactlyOnce(writer, new AbortController().signal))
      .rejects.toThrow("provider diagnostic containing a key");
    expect(writer).toHaveBeenCalledTimes(1);
    expect(retained.every((value) => value.equals(Buffer.alloc(value.length))))
      .toBe(true);
    await expect(custody.useExactlyOnce(writer, new AbortController().signal))
      .rejects.toMatchObject({ code: "key_input_unavailable" });
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("later abort promptly wipes a published never-settling writer and handles its later rejection", async () => {
    const controller = new AbortController();
    const custody = createPermanentStagingSupabaseKeyCustody(validBuffers());
    let retained: readonly Buffer[] = [];
    let rejectWriter!: (error: unknown) => void;
    const writerPromise = new Promise<string>((_resolve, reject) => {
      rejectWriter = reject;
    });
    const writer = vi.fn((keys: Record<string, Buffer>) => {
      retained = [
        keys.SUPABASE_ANON_KEY!,
        keys.SUPABASE_SERVICE_ROLE_KEY!,
        keys.OFFSITE_BACKUP_SERVICE_ROLE_KEY!,
      ];
      return writerPromise;
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const pending = custody.useExactlyOnce(writer, controller.signal);
      expect(writer).toHaveBeenCalledTimes(1);
      expect(retained.some((value) => value.some((byte) => byte !== 0))).toBe(true);
      const startedAt = Date.now();
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: "key_input_unavailable",
        message: "key_input_unavailable",
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(retained.every((value) => value.equals(Buffer.alloc(value.length))))
        .toBe(true);

      rejectWriter(new Error("late writer rejection containing private diagnostics"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      await expect(custody.useExactlyOnce(writer, controller.signal))
        .rejects.toMatchObject({ code: "key_input_unavailable" });
      expect(writer).toHaveBeenCalledTimes(1);
    } finally {
      process.removeListener("unhandledRejection", unhandled);
    }
  });

  it("uses captured cleanup, Promise, EventTarget, AbortSignal, Buffer, Array, Object, and Reflect intrinsics", async () => {
    const invalidInput = validBuffers({
      OFFSITE_BACKUP_SERVICE_ROLE_KEY: `sb_secret_${"b".repeat(32)}`,
    });
    const validInput = validBuffers();
    const controller = new AbortController();
    const resolvedWriter = Promise.resolve("ack");
    const originals = {
      arrayEvery: Array.prototype.every,
      arrayMap: Array.prototype.map,
      arraySome: Array.prototype.some,
      objectFreeze: Object.freeze,
      objectGetOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
      objectGetPrototypeOf: Object.getPrototypeOf,
      objectHasOwn: Object.hasOwn,
      objectValues: Object.values,
      bufferFill: Buffer.prototype.fill,
      bufferFrom: Buffer.from,
      bufferIsBuffer: Buffer.isBuffer,
      addEventListener: EventTarget.prototype.addEventListener,
      removeEventListener: EventTarget.prototype.removeEventListener,
      reflectApply: Reflect.apply,
      reflectOwnKeys: Reflect.ownKeys,
    };
    const abortDescriptor = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted",
    )!;
    const definePropertyExact = Object.defineProperty;
    const poisons = Array.from({ length: 15 }, () => vi.fn(() => {
      throw new Error("poison intrinsic invoked");
    }));
    const abortPoison = vi.fn(() => {
      throw new Error("poison AbortSignal.aborted invoked");
    });
    let invalidCaught: unknown;
    let retained: readonly Buffer[] = [];
    let result: string | undefined;
    try {
      Array.prototype.every = poisons[0] as typeof Array.prototype.every;
      Array.prototype.map = poisons[1] as typeof Array.prototype.map;
      Array.prototype.some = poisons[2] as typeof Array.prototype.some;
      Object.freeze = poisons[3] as typeof Object.freeze;
      Object.getOwnPropertyDescriptors = poisons[4] as typeof Object.getOwnPropertyDescriptors;
      Object.getPrototypeOf = poisons[5] as typeof Object.getPrototypeOf;
      Object.hasOwn = poisons[6] as typeof Object.hasOwn;
      Object.values = poisons[7] as typeof Object.values;
      Buffer.prototype.fill = poisons[8] as typeof Buffer.prototype.fill;
      Buffer.from = poisons[9] as typeof Buffer.from;
      Buffer.isBuffer = poisons[10] as typeof Buffer.isBuffer;
      EventTarget.prototype.addEventListener =
        poisons[11] as typeof EventTarget.prototype.addEventListener;
      EventTarget.prototype.removeEventListener =
        poisons[12] as typeof EventTarget.prototype.removeEventListener;
      Reflect.apply = poisons[13] as typeof Reflect.apply;
      Reflect.ownKeys = poisons[14] as typeof Reflect.ownKeys;
      definePropertyExact(AbortSignal.prototype, "aborted", {
        ...abortDescriptor,
        get: abortPoison,
      });

      try {
        createPermanentStagingSupabaseKeyCustody(invalidInput);
      } catch (error) {
        invalidCaught = error;
      }
      const custody = createPermanentStagingSupabaseKeyCustody(validInput);
      result = await custody.useExactlyOnce((keys) => {
        retained = [
          keys.SUPABASE_ANON_KEY,
          keys.SUPABASE_SERVICE_ROLE_KEY,
          keys.OFFSITE_BACKUP_SERVICE_ROLE_KEY,
        ];
        return resolvedWriter;
      }, controller.signal);
    } finally {
      Array.prototype.every = originals.arrayEvery;
      Array.prototype.map = originals.arrayMap;
      Array.prototype.some = originals.arraySome;
      Object.freeze = originals.objectFreeze;
      Object.getOwnPropertyDescriptors = originals.objectGetOwnPropertyDescriptors;
      Object.getPrototypeOf = originals.objectGetPrototypeOf;
      Object.hasOwn = originals.objectHasOwn;
      Object.values = originals.objectValues;
      Buffer.prototype.fill = originals.bufferFill;
      Buffer.from = originals.bufferFrom;
      Buffer.isBuffer = originals.bufferIsBuffer;
      EventTarget.prototype.addEventListener = originals.addEventListener;
      EventTarget.prototype.removeEventListener = originals.removeEventListener;
      Reflect.apply = originals.reflectApply;
      Reflect.ownKeys = originals.reflectOwnKeys;
      definePropertyExact(AbortSignal.prototype, "aborted", abortDescriptor);
    }
    expect(invalidCaught).toMatchObject({ code: "key_input_invalid" });
    expect(result).toBe("ack");
    expect(allZero(invalidInput)).toBe(true);
    expect(allZero(validInput)).toBe(true);
    expect(retained.every((value) => value.equals(Buffer.alloc(value.length))))
      .toBe(true);
    for (const poison of poisons) expect(poison).not.toHaveBeenCalled();
    expect(abortPoison).not.toHaveBeenCalled();
  });

  it("uses captured Promise.resolve/then after post-import poisoning in an isolated process", () => {
    const script = String.raw`
      import { createPermanentStagingSupabaseKeyCustody } from "./scripts/lib/permanent-staging-supabase-key-input.ts";
      const PromiseExact = Promise;
      const resolveExact = Promise.resolve;
      const thenExact = Promise.prototype.then;
      const input = {
        SUPABASE_ANON_KEY: Buffer.from("sb_publishable_${"a".repeat(32)}"),
        SUPABASE_SERVICE_ROLE_KEY: Buffer.from("sb_secret_${"b".repeat(32)}"),
        OFFSITE_BACKUP_SERVICE_ROLE_KEY: Buffer.from("sb_secret_${"c".repeat(32)}"),
      };
      const custody = createPermanentStagingSupabaseKeyCustody(input);
      const controller = new AbortController();
      let rejectWriter;
      const writerPromise = new PromiseExact((_resolve, reject) => { rejectWriter = reject; });
      let poisonCalls = 0;
      let writerCalls = 0;
      let retained;
      let code = "none";
      let unhandled = 0;
      process.on("unhandledRejection", () => { unhandled += 1; });
      try {
        Promise.resolve = () => { poisonCalls += 1; throw new Error("poison resolve"); };
        Promise.prototype.then = () => { poisonCalls += 1; throw new Error("poison then"); };
        const pending = custody.useExactlyOnce((keys) => {
          writerCalls += 1;
          retained = [keys.SUPABASE_ANON_KEY, keys.SUPABASE_SERVICE_ROLE_KEY, keys.OFFSITE_BACKUP_SERVICE_ROLE_KEY];
          return writerPromise;
        }, controller.signal);
        controller.abort();
        try { await pending; } catch (error) { code = error?.code ?? "wrong"; }
      } finally {
        Promise.resolve = resolveExact;
        Promise.prototype.then = thenExact;
      }
      rejectWriter(new Error("late rejection"));
      await new PromiseExact((resolve) => setImmediate(resolve));
      await new PromiseExact((resolve) => setImmediate(resolve));
      let zero = true;
      for (let index = 0; index < retained.length; index += 1) {
        for (let byte = 0; byte < retained[index].length; byte += 1) {
          if (retained[index][byte] !== 0) zero = false;
        }
      }
      process.stdout.write(JSON.stringify({ code, poisonCalls, writerCalls, zero, unhandled }));
    `;
    const result = spawnSync(process.execPath, [
      "--import=tsx",
      "--input-type=module",
      "--eval",
      script,
    ], {
      cwd: process.cwd(),
      env: {},
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      code: "key_input_unavailable",
      poisonCalls: 0,
      writerCalls: 1,
      zero: true,
      unhandled: 0,
    });
  });

  it("zeroizes without publication on close or a pre-aborted signal", async () => {
    const closed = createPermanentStagingSupabaseKeyCustody(validBuffers());
    const writer = vi.fn();
    closed.close();
    closed.close();
    await expect(closed.useExactlyOnce(writer, new AbortController().signal))
      .rejects.toMatchObject({ code: "key_input_unavailable" });

    const aborted = createPermanentStagingSupabaseKeyCustody(validBuffers());
    const controller = new AbortController();
    controller.abort();
    await expect(aborted.useExactlyOnce(writer, controller.signal))
      .rejects.toMatchObject({ code: "key_input_unavailable" });
    expect(writer).not.toHaveBeenCalled();
  });
});
