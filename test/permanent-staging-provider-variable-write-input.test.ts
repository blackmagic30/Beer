import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_COMMITMENT_DOMAIN,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_SCHEMA,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_MAXIMUM_VALUE_BYTES,
  PermanentStagingProviderVariableWriteInputError,
  isPermanentStagingProviderVariableWriteInputHandleAuthority,
  readPermanentStagingProviderVariableWriteInput,
  type PermanentStagingProviderVariableWriteInputSource,
} from "../scripts/lib/permanent-staging-provider-variable-write-input.js";

const NEVER_ABORTED_SIGNAL = new AbortController().signal;

function inputSource(
  chunks: readonly Uint8Array[],
  options: { readonly isTTY?: boolean; readonly onReturn?: () => void } = {},
): PermanentStagingProviderVariableWriteInputSource {
  return {
    ...(options.isTTY === undefined ? {} : { isTTY: options.isTTY }),
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index >= chunks.length) {
            return { done: true, value: undefined } as const;
          }
          const value = chunks[index]!;
          index += 1;
          return { done: false, value } as const;
        },
        async return() {
          options.onReturn?.();
          return { done: true, value: undefined } as const;
        },
      };
    },
  };
}

function expectedCommitment(variableName: string, value: Buffer): string {
  const domain = Buffer.from(
    `${PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_COMMITMENT_DOMAIN}\0`,
    "utf8",
  );
  const name = Buffer.from(variableName, "utf8");
  const nameLength = Buffer.alloc(4);
  const valueLength = Buffer.alloc(4);
  nameLength.writeUInt32BE(name.length);
  valueLength.writeUInt32BE(value.length);
  return crypto.createHash("sha256")
    .update(domain)
    .update(nameLength)
    .update(name)
    .update(valueLength)
    .update(value)
    .digest("hex");
}

describe("permanent staging provider-variable held input", () => {
  it("brands only handles created by the bounded input reader", async () => {
    const handle = await readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([Buffer.from("fixture-provider-value")]),
      NEVER_ABORTED_SIGNAL,
    );
    expect(isPermanentStagingProviderVariableWriteInputHandleAuthority(handle))
      .toBe(true);
    expect(isPermanentStagingProviderVariableWriteInputHandleAuthority({
      inspect: handle.inspect,
      reassert: handle.reassert,
      writeExactlyOnce: handle.writeExactlyOnce,
      close: handle.close,
    })).toBe(false);
    handle.close();
  });

  it("does not trust a poisoned live WeakSet brand method", async () => {
    const handle = await readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([Buffer.from("fixture-provider-value")]),
      NEVER_ABORTED_SIGNAL,
    );
    const forged = Object.freeze({
      inspect: handle.inspect,
      reassert: handle.reassert,
      writeExactlyOnce: handle.writeExactlyOnce,
      close: handle.close,
    });
    const has = vi.spyOn(WeakSet.prototype, "has").mockReturnValue(true);
    try {
      expect(isPermanentStagingProviderVariableWriteInputHandleAuthority(forged))
        .toBe(false);
      expect(isPermanentStagingProviderVariableWriteInputHandleAuthority(handle))
        .toBe(true);
    } finally {
      has.mockRestore();
      handle.close();
    }
  });

  it("freezes the branded authority with a captured intrinsic after source poisoning", async () => {
    const originalFreeze = Object.freeze;
    let poisoned = false;
    const source = inputSource([Buffer.from("fixture-provider-value")]);
    const originalIterator = source[Symbol.asyncIterator].bind(source);
    const hostileSource: PermanentStagingProviderVariableWriteInputSource = {
      [Symbol.asyncIterator]() {
        const iterator = originalIterator();
        return {
          async next() {
            if (!poisoned) {
              poisoned = true;
              Object.freeze = ((value: object) => value) as typeof Object.freeze;
            }
            return await iterator.next();
          },
          async return() {
            return iterator.return === undefined
              ? { done: true, value: undefined }
              : await iterator.return();
          },
        };
      },
    };
    let handle!: Awaited<ReturnType<
      typeof readPermanentStagingProviderVariableWriteInput
    >>;
    try {
      handle = await readPermanentStagingProviderVariableWriteInput(
        "OPENAI_API_KEY",
        hostileSource,
        NEVER_ABORTED_SIGNAL,
      );
    } finally {
      Object.freeze = originalFreeze;
    }
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.isFrozen(handle.inspect())).toBe(true);
    handle.close();
  });

  it("does not trust a poisoned live Set allowlist method", async () => {
    const sourceBytes = Buffer.from("unapproved-variable-secret");
    const has = vi.spyOn(Set.prototype, "has").mockReturnValue(true);
    let caught: unknown;
    try {
      await readPermanentStagingProviderVariableWriteInput(
        "DATABASE_URL",
        inputSource([sourceBytes]),
        NEVER_ABORTED_SIGNAL,
      );
    } catch (error) {
      caught = error;
    } finally {
      has.mockRestore();
    }
    expect(caught).toMatchObject({
      code: "input_invalid",
      message: "input_invalid",
    });
    expect(sourceBytes.toString("utf8")).toBe("unapproved-variable-secret");
    sourceBytes.fill(0);
  });

  it("defines fixed errors without invoking Error prototype setters", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Error.prototype, "name")!;
    Object.defineProperty(Error.prototype, "name", {
      configurable: true,
      set() {
        throw new Error("raw-secret-from-name-setter");
      },
    });
    let caught: unknown;
    try {
      await readPermanentStagingProviderVariableWriteInput(
        "DATABASE_URL",
        inputSource([Buffer.from("unread")]),
        NEVER_ABORTED_SIGNAL,
      );
    } catch (error) {
      caught = error;
    } finally {
      Object.defineProperty(Error.prototype, "name", descriptor);
    }
    expect(caught).toMatchObject({
      name: "PermanentStagingProviderVariableWriteInputError",
      code: "input_invalid",
      message: "input_invalid",
    });
  });

  it("holds valid raw UTF-8 bytes and exposes only a variable-bound commitment", async () => {
    const sourceBytes = Buffer.from("sk-test-秘密-🍺", "utf8");
    const expectedBytes = Buffer.from(sourceBytes);
    const handle = await readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([sourceBytes.subarray(0, 5), sourceBytes.subarray(5)]),
      NEVER_ABORTED_SIGNAL,
    );

    expect(sourceBytes.equals(Buffer.alloc(sourceBytes.length))).toBe(true);
    const inspection = handle.inspect();
    expect(inspection).toEqual({
      schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_SCHEMA,
      variableName: "OPENAI_API_KEY",
      byteLength: expectedBytes.length,
      commitmentDomain:
        "pintpath/permanent-staging/provider-variable-write/input-commitment/v1",
      commitmentSha256: expectedCommitment("OPENAI_API_KEY", expectedBytes),
      stdinOnly: true,
      validUtf8: true,
      controlCharactersAbsent: true,
    });
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(handle.reassert()).toBe(inspection);
    handle.close();
    handle.close();
    expect(() => handle.inspect()).toThrow(expect.objectContaining({
      code: "input_unavailable",
    }));
    expectedBytes.fill(0);
  });

  it("accepts exactly 4096 bytes and rejects 4097 before retaining the excess", async () => {
    const maximum = Buffer.alloc(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_MAXIMUM_VALUE_BYTES,
      0x61,
    );
    const accepted = await readPermanentStagingProviderVariableWriteInput(
      "GOOGLE_MAPS_API_KEY",
      inputSource([maximum]),
      NEVER_ABORTED_SIGNAL,
    );
    expect(accepted.inspect().byteLength).toBe(4_096);
    accepted.close();

    const prefix = Buffer.alloc(4_096, 0x61);
    const excess = Buffer.from("b");
    const returned = vi.fn();
    await expect(readPermanentStagingProviderVariableWriteInput(
      "GOOGLE_MAPS_API_KEY",
      inputSource([prefix, excess], { onReturn: returned }),
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({ code: "input_invalid" });
    expect(prefix.equals(Buffer.alloc(prefix.length))).toBe(true);
    expect(excess.equals(Buffer.alloc(excess.length))).toBe(true);
    expect(returned).toHaveBeenCalledTimes(1);
  });

  it("rejects zero-length chunks so bounded input cannot retain bytes forever", async () => {
    const secret = Buffer.from("secret-before-empty-chunk");
    const empty = Buffer.alloc(0);
    const returned = vi.fn();
    await expect(readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([secret, empty], { onReturn: returned }),
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "input_invalid",
      message: "input_invalid",
    });
    expect(secret.equals(Buffer.alloc(secret.length))).toBe(true);
    expect(returned).toHaveBeenCalledTimes(1);
  });

  it("rechecks cancellation after a pending terminal iterator result", async () => {
    const controller = new AbortController();
    const secret = Buffer.from("abort-during-terminal-next-secret");
    const returned = vi.fn();
    let resolveTerminal!: (value: IteratorResult<Uint8Array>) => void;
    let secondNextEntered!: () => void;
    const terminal = new Promise<IteratorResult<Uint8Array>>((resolve) => {
      resolveTerminal = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      secondNextEntered = resolve;
    });
    let calls = 0;
    const source: PermanentStagingProviderVariableWriteInputSource = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            calls += 1;
            if (calls === 1) return { done: false, value: secret };
            secondNextEntered();
            return await terminal;
          },
          async return() {
            returned();
            return { done: true, value: undefined } as const;
          },
        };
      },
    };
    const pending = readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      source,
      controller.signal,
    );
    await entered;
    controller.abort();
    resolveTerminal({ done: true, value: undefined });
    await expect(pending).rejects.toMatchObject({
      code: "input_invalid",
      message: "input_invalid",
    });
    expect(secret.equals(Buffer.alloc(secret.length))).toBe(true);
    expect(returned).toHaveBeenCalledTimes(1);
  });

  it.each(["done", "value"] as const)(
    "rechecks cancellation after the iterator-result %s getter",
    async (getter) => {
      const controller = new AbortController();
      const secret = Buffer.from(`abort-from-${getter}-getter-secret`);
      const returned = vi.fn();
      let calls = 0;
      const source: PermanentStagingProviderVariableWriteInputSource = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<Uint8Array>> {
              calls += 1;
              if (calls === 1) return { done: false, value: secret };
              if (getter === "done") {
                return Object.defineProperty({}, "done", {
                  enumerable: true,
                  get() {
                    controller.abort();
                    return true;
                  },
                }) as IteratorResult<Uint8Array>;
              }
              return Object.defineProperties({}, {
                done: { enumerable: true, value: false },
                value: {
                  enumerable: true,
                  get() {
                    controller.abort();
                    return Buffer.from("must-not-be-copied");
                  },
                },
              }) as IteratorResult<Uint8Array>;
            },
            async return() {
              returned();
              return { done: true, value: undefined } as const;
            },
          };
        },
      };
      await expect(readPermanentStagingProviderVariableWriteInput(
        "OPENAI_API_KEY",
        source,
        controller.signal,
      )).rejects.toMatchObject({
        code: "input_invalid",
        message: "input_invalid",
      });
      expect(secret.equals(Buffer.alloc(secret.length))).toBe(true);
      expect(returned).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["done", "value"] as const)(
    "settles queued cancellation from a nonterminal %s getter before another read",
    async (getter) => {
      const controller = new AbortController();
      const secret = Buffer.from(`queued-abort-from-${getter}-secret`);
      let nextCalls = 0;
      let returnCalls = 0;
      const source: PermanentStagingProviderVariableWriteInputSource = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<Uint8Array>> {
              nextCalls += 1;
              if (nextCalls > 1) return await new Promise(() => undefined);
              if (getter === "done") {
                return Object.defineProperties({}, {
                  done: {
                    enumerable: true,
                    get() {
                      queueMicrotask(() => controller.abort());
                      return false;
                    },
                  },
                  value: { enumerable: true, value: secret },
                }) as IteratorResult<Uint8Array>;
              }
              return Object.defineProperties({}, {
                done: { enumerable: true, value: false },
                value: {
                  enumerable: true,
                  get() {
                    queueMicrotask(() => controller.abort());
                    return secret;
                  },
                },
              }) as IteratorResult<Uint8Array>;
            },
            async return() {
              returnCalls += 1;
              return { done: true, value: undefined } as const;
            },
          };
        },
      };
      await expect(readPermanentStagingProviderVariableWriteInput(
        "OPENAI_API_KEY",
        source,
        controller.signal,
      )).rejects.toMatchObject({
        code: "input_invalid",
        message: "input_invalid",
      });
      expect(nextCalls).toBe(1);
      expect(returnCalls).toBe(1);
      expect(secret.equals(Buffer.alloc(secret.length))).toBe(true);
    },
  );

  it("rechecks cancellation after the bounded read settles", async () => {
    const controller = new AbortController();
    const secret = Buffer.from("queued-abort-after-terminal-secret");
    const returned = vi.fn();
    let calls = 0;
    const source: PermanentStagingProviderVariableWriteInputSource = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            calls += 1;
            if (calls === 1) return { done: false, value: secret };
            return Object.defineProperty({}, "done", {
              enumerable: true,
              get() {
                queueMicrotask(() => controller.abort());
                return true;
              },
            }) as IteratorResult<Uint8Array>;
          },
          async return() {
            returned();
            return { done: true, value: undefined } as const;
          },
        };
      },
    };
    await expect(readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      source,
      controller.signal,
    )).rejects.toMatchObject({
      code: "input_invalid",
      message: "input_invalid",
    });
    expect(secret.equals(Buffer.alloc(secret.length))).toBe(true);
    expect(returned).not.toHaveBeenCalled();
  });

  it.each([
    ["empty input", () => []],
    ["NUL", () => [Buffer.from([0x61, 0x00, 0x62])]],
    ["LF", () => [Buffer.from("value\n")]],
    ["CR", () => [Buffer.from("value\r")]],
    ["tab", () => [Buffer.from("value\t")]],
    ["escape", () => [Buffer.from([0x61, 0x1b, 0x62])]],
    ["DEL", () => [Buffer.from([0x61, 0x7f, 0x62])]],
    ["UTF-8 C1 control", () => [Buffer.from([0x61, 0xc2, 0x80])]],
    ["isolated continuation", () => [Buffer.from([0x80])]],
    ["overlong UTF-8", () => [Buffer.from([0xc0, 0xaf])]],
    ["truncated UTF-8", () => [Buffer.from([0xf0, 0x9f, 0x8d])]],
    ["UTF-8 surrogate", () => [Buffer.from([0xed, 0xa0, 0x80])]],
    ["out-of-range UTF-8", () => [Buffer.from([0xf4, 0x90, 0x80, 0x80])]],
  ])("rejects %s without returning secret material", async (_label, makeChunks) => {
    const chunks = makeChunks();
    await expect(readPermanentStagingProviderVariableWriteInput(
      "GOOGLE_MAPS_MAP_ID",
      inputSource(chunks),
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "input_invalid",
      message: "input_invalid",
    });
    for (const chunk of chunks) {
      expect(chunk.equals(Buffer.alloc(chunk.length))).toBe(true);
    }
  });

  it("rejects TTY input before iterating and rejects unknown variable names", async () => {
    const iterator = vi.fn();
    const tty = {
      isTTY: true,
      [Symbol.asyncIterator]: iterator,
    } as unknown as PermanentStagingProviderVariableWriteInputSource;
    await expect(readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      tty,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({ code: "input_invalid" });
    expect(iterator).not.toHaveBeenCalled();

    await expect(readPermanentStagingProviderVariableWriteInput(
      "DATABASE_URL",
      inputSource([Buffer.from("secret")]),
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({ code: "input_invalid" });
  });

  it("rejects non-byte chunks instead of coercing them", async () => {
    const toString = vi.fn(() => "secret");
    await expect(readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([toString as unknown as Uint8Array]),
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({ code: "input_invalid" });
    expect(toString).not.toHaveBeenCalled();
  });

  it("uses the captured dedicated allocator and still zeroizes the caller chunk", async () => {
    const chunk = Buffer.from("copy-failure-secret");
    const allocation = vi.spyOn(Buffer, "alloc").mockImplementationOnce(() => {
      throw new Error("raw copy failure with copy-failure-secret");
    });
    let handle!: Awaited<ReturnType<
      typeof readPermanentStagingProviderVariableWriteInput
    >>;
    try {
      handle = await readPermanentStagingProviderVariableWriteInput(
        "OPENAI_API_KEY",
        inputSource([chunk]),
        NEVER_ABORTED_SIGNAL,
      );
    } finally {
      allocation.mockRestore();
    }
    expect(chunk.equals(Buffer.alloc(chunk.length))).toBe(true);
    expect(handle.inspect().byteLength).toBe("copy-failure-secret".length);
    handle.close();
  });

  it("bypasses a hostile Uint8Array byteLength getter and wipes the chunk", async () => {
    class HostileChunk extends Uint8Array {
      get byteLength(): number {
        throw new Error("raw hostile byteLength getter");
      }
    }
    const chunk = new HostileChunk(Buffer.from("hostile-source-secret"));
    await expect(readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([chunk]),
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "input_invalid",
      message: "input_invalid",
    });
    expect([...chunk]).toEqual(new Array(chunk.length).fill(0));
  });

  it("does not let a source-poisoned typed-array length hide controls", async () => {
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const originalLength = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "length",
    )!;
    const sourceBytes = Buffer.from("abcd\nx");
    const source: PermanentStagingProviderVariableWriteInputSource = {
      async *[Symbol.asyncIterator]() {
        yield sourceBytes;
        Object.defineProperty(typedArrayPrototype, "length", {
          configurable: true,
          get: () => 4,
        });
      },
    };
    let caught: unknown;
    try {
      await readPermanentStagingProviderVariableWriteInput(
        "OPENAI_API_KEY",
        source,
        NEVER_ABORTED_SIGNAL,
      );
    } catch (error) {
      caught = error;
    } finally {
      Object.defineProperty(typedArrayPrototype, "length", originalLength);
    }
    expect(caught).toMatchObject({
      code: "input_invalid",
      message: "input_invalid",
    });
    expect(sourceBytes.equals(Buffer.alloc(sourceBytes.length))).toBe(true);
  });

  it("reconstructs fixed errors thrown by a hostile source", async () => {
    const forged = new PermanentStagingProviderVariableWriteInputError(
      "input_invalid",
    );
    forged.message = "raw-source-fixture-secret";
    const source: PermanentStagingProviderVariableWriteInputSource = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            throw forged;
          },
        };
      },
    };
    let caught: unknown;
    try {
      await readPermanentStagingProviderVariableWriteInput(
        "OPENAI_API_KEY",
        source,
        NEVER_ABORTED_SIGNAL,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBe(forged);
    expect(caught).toMatchObject({
      code: "input_invalid",
      message: "input_invalid",
    });
  });

  it("rejects a proxied typed array before accepting ownership", async () => {
    const target = Buffer.from("proxied-source-secret");
    const proxied = new Proxy(target, {});
    await expect(readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([proxied]),
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "input_invalid",
      message: "input_invalid",
    });
    expect(target.toString("utf8")).toBe("proxied-source-secret");
    target.fill(0);
  });

  it("uses a captured list-publication intrinsic despite source-side poisoning", async () => {
    const sourceBytes = Buffer.from("list-publication-secret");
    const defineProperty = vi.spyOn(Object, "defineProperty")
      .mockImplementationOnce((value) => value);
    let handle: Awaited<ReturnType<
      typeof readPermanentStagingProviderVariableWriteInput
    >> | undefined;
    try {
      handle = await readPermanentStagingProviderVariableWriteInput(
        "OPENAI_API_KEY",
        inputSource([sourceBytes]),
        NEVER_ABORTED_SIGNAL,
      );
    } finally {
      defineProperty.mockRestore();
    }
    expect(sourceBytes.equals(Buffer.alloc(sourceBytes.length))).toBe(true);
    expect(handle?.inspect().byteLength).toBe("list-publication-secret".length);
    handle?.close();
  });

  it("does not use a source-poisoned Array iterator for retained cleanup", async () => {
    const sourceBytes = Buffer.from("iterator-poison-secret");
    const originalIterator = Array.prototype[Symbol.iterator];
    const poisonedSource: PermanentStagingProviderVariableWriteInputSource = {
      async *[Symbol.asyncIterator]() {
        yield sourceBytes;
        Array.prototype[Symbol.iterator] = function* () {};
      },
    };
    let handle: Awaited<ReturnType<
      typeof readPermanentStagingProviderVariableWriteInput
    >> | undefined;
    try {
      handle = await readPermanentStagingProviderVariableWriteInput(
        "OPENAI_API_KEY",
        poisonedSource,
        NEVER_ABORTED_SIGNAL,
      );
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
    }
    expect(sourceBytes.equals(Buffer.alloc(sourceBytes.length))).toBe(true);
    expect(handle?.inspect().byteLength).toBe("iterator-poison-secret".length);
    handle?.close();
  });

  it("uses the captured dedicated final allocator despite a poisoned live allocator", async () => {
    const first = Buffer.from("first-secret-part");
    const second = Buffer.from("second-secret-part");
    const originalAlloc = Buffer.alloc.bind(Buffer);
    const allocation = vi.spyOn(Buffer, "alloc")
      .mockImplementation((size) => {
        return originalAlloc(size + 1);
      });
    let handle!: Awaited<ReturnType<
      typeof readPermanentStagingProviderVariableWriteInput
    >>;
    try {
      handle = await readPermanentStagingProviderVariableWriteInput(
        "OPENAI_API_KEY",
        inputSource([first, second]),
        NEVER_ABORTED_SIGNAL,
      );
    } finally {
      allocation.mockRestore();
    }
    expect(first.equals(Buffer.alloc(first.length))).toBe(true);
    expect(second.equals(Buffer.alloc(second.length))).toBe(true);
    expect(handle.inspect().byteLength).toBe(
      "first-secret-partsecond-secret-part".length,
    );
    handle.close();
  });

  it("uses captured hash authority after a hostile source poisons crypto.createHash", async () => {
    const sourceBytes = Buffer.from("commitment-construction-secret");
    const expected = expectedCommitment("OPENAI_API_KEY", Buffer.from(sourceBytes));
    const originalCreateHash = crypto.createHash;
    const hostileSource: PermanentStagingProviderVariableWriteInputSource = {
      async *[Symbol.asyncIterator]() {
        crypto.createHash = (() => ({
          update() {
            return this;
          },
          digest() {
            return Buffer.alloc(32, 0xaa);
          },
        })) as typeof crypto.createHash;
        yield sourceBytes;
      },
    };
    let handle!: Awaited<ReturnType<
      typeof readPermanentStagingProviderVariableWriteInput
    >>;
    try {
      handle = await readPermanentStagingProviderVariableWriteInput(
        "OPENAI_API_KEY",
        hostileSource,
        NEVER_ABORTED_SIGNAL,
      );
    } finally {
      crypto.createHash = originalCreateHash;
    }
    expect(sourceBytes.equals(Buffer.alloc(sourceBytes.length))).toBe(true);
    expect(handle.inspect().commitmentSha256).toBe(expected);
    expect(handle.reassert().commitmentSha256).toBe(expected);
    handle.close();
  });

  it("uses captured hex rendering after live Buffer formatting is poisoned", async () => {
    const value = Buffer.from("commitment-hex-secret");
    const expected = expectedCommitment("OPENAI_API_KEY", Buffer.from(value));
    const originalToString = Buffer.prototype.toString;
    const toString = vi.spyOn(Buffer.prototype, "toString")
      .mockImplementation(function (...args) {
        if (this.length === 32 && args[0] === "hex") {
          throw new Error("raw commitment hex failure");
        }
        return Reflect.apply(originalToString, this, args as []);
      });
    let handle!: Awaited<ReturnType<
      typeof readPermanentStagingProviderVariableWriteInput
    >>;
    try {
      handle = await readPermanentStagingProviderVariableWriteInput(
        "OPENAI_API_KEY",
        inputSource([value]),
        NEVER_ABORTED_SIGNAL,
      );
    } finally {
      toString.mockRestore();
    }
    expect(handle.inspect().commitmentSha256).toBe(expected);
    handle.close();
  });

  it("writes the committed bytes despite a poisoned live Buffer.from", async () => {
    const handle = await readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([Buffer.from("outbound-allocation-secret")]),
      NEVER_ABORTED_SIGNAL,
    );
    let written = "";
    const writer = vi.fn(async (outbound: Buffer) => {
      written = outbound.toString("utf8");
    });
    const from = vi.spyOn(Buffer, "from").mockImplementation(() =>
      Buffer.alloc(21, 0x78));
    try {
      await handle.writeExactlyOnce(writer, NEVER_ABORTED_SIGNAL);
    } finally {
      from.mockRestore();
    }
    expect(writer).toHaveBeenCalledTimes(1);
    expect(written).toBe("outbound-allocation-secret");
    expect(() => handle.inspect()).toThrow(expect.objectContaining({
      code: "input_unavailable",
    }));
  });

  it("maps a hostile iterator return getter to a fixed cleanup failure and wipes retained chunks", async () => {
    const first = Buffer.alloc(4_096, 0x61);
    const excess = Buffer.from("b");
    const hostile = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            const values = [first, excess];
            const value = values[index];
            index += 1;
            return value === undefined
              ? { done: true, value: undefined } as const
              : { done: false, value } as const;
          },
          get return() {
            throw new Error("raw iterator cleanup failure");
          },
        };
      },
    } satisfies PermanentStagingProviderVariableWriteInputSource;
    await expect(readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      hostile,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "cleanup_failed",
      message: "cleanup_failed",
    });
    expect(first.equals(Buffer.alloc(first.length))).toBe(true);
    expect(excess.equals(Buffer.alloc(excess.length))).toBe(true);
  });

  it("uses captured invocation for iterator cleanup instead of a forged call", async () => {
    const first = Buffer.alloc(4_096, 0x61);
    const excess = Buffer.from("b");
    let returned = 0;
    const cleanup = async () => {
      returned += 1;
      return { done: true, value: undefined } as const;
    };
    Object.defineProperty(cleanup, "call", {
      configurable: true,
      value: () => ({ done: true, value: undefined }),
    });
    const source: PermanentStagingProviderVariableWriteInputSource = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            const values = [first, excess];
            const value = values[index];
            index += 1;
            return value === undefined
              ? { done: true, value: undefined } as const
              : { done: false, value } as const;
          },
          return: cleanup,
        };
      },
    };
    await expect(readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      source,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "input_invalid",
      message: "input_invalid",
    });
    expect(returned).toBe(1);
    expect(first.equals(Buffer.alloc(first.length))).toBe(true);
    expect(excess.equals(Buffer.alloc(excess.length))).toBe(true);
  });

  it("permits one write attempt, then zeroizes both held and outbound buffers", async () => {
    const value = Buffer.from("one-use-secret");
    const expected = Buffer.from(value);
    const handle = await readPermanentStagingProviderVariableWriteInput(
      "GOOGLE_PLACES_API_KEY",
      inputSource([value]),
      NEVER_ABORTED_SIGNAL,
    );
    let retained: Buffer | undefined;
    const writer = vi.fn(async (outbound: Buffer) => {
      retained = outbound;
      expect(outbound).not.toBe(value);
      expect(outbound.equals(expected)).toBe(true);
      expect(outbound.byteOffset).toBe(0);
      expect(outbound.buffer.byteLength).toBe(outbound.byteLength);
    });

    await handle.writeExactlyOnce(writer, NEVER_ABORTED_SIGNAL);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(retained).toBeDefined();
    expect(retained!.equals(Buffer.alloc(retained!.length))).toBe(true);
    expect(() => handle.reassert()).toThrow(expect.objectContaining({
      code: "input_unavailable",
    }));
    await expect(handle.writeExactlyOnce(writer, NEVER_ABORTED_SIGNAL))
      .rejects.toMatchObject({ code: "input_unavailable" });
    expect(writer).toHaveBeenCalledTimes(1);
    expected.fill(0);
  });

  it("zeroizes and permanently consumes input when the sole writer fails", async () => {
    const handle = await readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([Buffer.from("must-not-retry")]),
      NEVER_ABORTED_SIGNAL,
    );
    let retained: Buffer | undefined;
    const writer = vi.fn(async (outbound: Buffer) => {
      retained = outbound;
      throw new Error("provider output containing must-not-retry");
    });
    await expect(handle.writeExactlyOnce(writer, NEVER_ABORTED_SIGNAL))
      .rejects.toMatchObject({
        code: "input_invalid",
        message: "input_invalid",
      });
    expect(writer).toHaveBeenCalledTimes(1);
    expect(retained!.equals(Buffer.alloc(retained!.length))).toBe(true);
    await expect(handle.writeExactlyOnce(writer, NEVER_ABORTED_SIGNAL))
      .rejects.toMatchObject({ code: "input_unavailable" });
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("reconstructs fixed errors thrown by the sole writer", async () => {
    const handle = await readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([Buffer.from("writer-error-secret")]),
      NEVER_ABORTED_SIGNAL,
    );
    const forged = new PermanentStagingProviderVariableWriteInputError(
      "input_invalid",
    );
    forged.message = "raw-writer-fixture-secret";
    let caught: unknown;
    try {
      await handle.writeExactlyOnce(async () => {
        throw forged;
      }, NEVER_ABORTED_SIGNAL);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBe(forged);
    expect(caught).toMatchObject({
      code: "input_invalid",
      message: "input_invalid",
    });
  });

  it("still destroys held authority when a writer detaches the outbound buffer", async () => {
    const handle = await readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([Buffer.alloc(4_096, 0x61)]),
      NEVER_ABORTED_SIGNAL,
    );
    await expect(handle.writeExactlyOnce(async (outbound) => {
      structuredClone(outbound.buffer, { transfer: [outbound.buffer] });
    }, NEVER_ABORTED_SIGNAL)).rejects.toMatchObject({
      code: "cleanup_failed",
      message: "cleanup_failed",
    });
    expect(() => handle.inspect()).toThrow(expect.objectContaining({
      code: "input_unavailable",
    }));
    expect(() => handle.close()).not.toThrow();
  });

  it("uses captured zeroization intrinsics when a writer poisons live globals", async () => {
    const handle = await readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([Buffer.from("writer-poison-secret")]),
      NEVER_ABORTED_SIGNAL,
    );
    const fill = vi.spyOn(Uint8Array.prototype, "fill")
      .mockImplementation(() => {
        throw new Error("poisoned live fill");
      });
    try {
      await handle.writeExactlyOnce(async () => undefined, NEVER_ABORTED_SIGNAL);
    } finally {
      fill.mockRestore();
    }
    expect(() => handle.inspect()).toThrow(expect.objectContaining({
      code: "input_unavailable",
    }));
  });

  it("reasserts with captured hash authority after live crypto poisoning", async () => {
    const handle = await readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([Buffer.from("reassertion-secret")]),
      NEVER_ABORTED_SIGNAL,
    );
    const expected = handle.inspect().commitmentSha256;
    const createHash = vi.spyOn(crypto, "createHash").mockImplementation(() => {
      throw new Error("raw reassertion digest failure");
    });
    try {
      expect(handle.reassert().commitmentSha256).toBe(expected);
    } finally {
      createHash.mockRestore();
    }
    expect(handle.inspect().commitmentSha256).toBe(expected);
    handle.close();
  });

  it("does not trust poisoned Buffer hexSlice or utf8Write dispatch", async () => {
    const sourceBytes = Buffer.from("buffer-dispatch-secret");
    const expected = expectedCommitment(
      "OPENAI_API_KEY",
      Buffer.from(sourceBytes),
    );
    const hexSlice = Object.getOwnPropertyDescriptor(
      Buffer.prototype,
      "hexSlice",
    )!;
    const utf8Write = Object.getOwnPropertyDescriptor(
      Buffer.prototype,
      "utf8Write",
    )!;
    const source: PermanentStagingProviderVariableWriteInputSource = {
      async *[Symbol.asyncIterator]() {
        yield sourceBytes;
        Object.defineProperty(Buffer.prototype, "hexSlice", {
          ...hexSlice,
          value: () => "f".repeat(64),
        });
        Object.defineProperty(Buffer.prototype, "utf8Write", {
          ...utf8Write,
          value(this: Buffer, _value: string, offset = 0, length = 0) {
            this.fill(0x58, offset, offset + length);
            return length;
          },
        });
      },
    };
    let handle: Awaited<ReturnType<
      typeof readPermanentStagingProviderVariableWriteInput
    >> | undefined;
    try {
      handle = await readPermanentStagingProviderVariableWriteInput(
        "OPENAI_API_KEY",
        source,
        NEVER_ABORTED_SIGNAL,
      );
      expect(handle.inspect().commitmentSha256).toBe(expected);
      expect(handle.reassert().commitmentSha256).toBe(expected);
    } finally {
      Object.defineProperty(Buffer.prototype, "utf8Write", utf8Write);
      Object.defineProperty(Buffer.prototype, "hexSlice", hexSlice);
    }
    handle?.close();
  });

  it("rejects aborted reads and writes before consuming a writer attempt", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const untouched = Buffer.from("untouched");
    await expect(readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([untouched]),
      aborted.signal,
    )).rejects.toMatchObject({ code: "input_invalid" });
    expect(untouched.toString("utf8")).toBe("untouched");

    const handle = await readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([Buffer.from("held")]),
      NEVER_ABORTED_SIGNAL,
    );
    const writer = vi.fn(async () => undefined);
    await expect(handle.writeExactlyOnce(writer, aborted.signal))
      .rejects.toMatchObject({ code: "input_invalid" });
    expect(writer).not.toHaveBeenCalled();
    expect(handle.inspect().byteLength).toBe(4);
    handle.close();
  });

  it("does not trust a poisoned live AbortSignal.aborted getter", async () => {
    const handle = await readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([Buffer.from("abort-poison-secret")]),
      NEVER_ABORTED_SIGNAL,
    );
    const controller = new AbortController();
    controller.abort();
    const descriptor = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted",
    )!;
    const writer = vi.fn(async () => undefined);
    Object.defineProperty(AbortSignal.prototype, "aborted", {
      configurable: true,
      get: () => false,
    });
    let caught: unknown;
    try {
      await handle.writeExactlyOnce(writer, controller.signal);
    } catch (error) {
      caught = error;
    } finally {
      Object.defineProperty(AbortSignal.prototype, "aborted", descriptor);
    }
    expect(caught).toMatchObject({
      code: "input_invalid",
      message: "input_invalid",
    });
    expect(writer).not.toHaveBeenCalled();
    handle.close();
  });

  it("fixed-maps a proxied write signal without consuming the attempt", async () => {
    const handle = await readPermanentStagingProviderVariableWriteInput(
      "OPENAI_API_KEY",
      inputSource([Buffer.from("proxy-signal-secret")]),
      NEVER_ABORTED_SIGNAL,
    );
    const trap = vi.fn(() => {
      throw new Error("raw-secret-from-signal-trap");
    });
    const signal = new Proxy(NEVER_ABORTED_SIGNAL, {
      getPrototypeOf: trap,
    });
    const writer = vi.fn(async () => undefined);
    let caught: unknown;
    try {
      await handle.writeExactlyOnce(writer, signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "input_invalid",
      message: "input_invalid",
    });
    expect(String(caught)).not.toContain("raw-secret-from-signal-trap");
    expect(trap).toHaveBeenCalledTimes(1);
    expect(writer).not.toHaveBeenCalled();
    expect(handle.inspect().byteLength).toBe("proxy-signal-secret".length);
    handle.close();
  });
});
