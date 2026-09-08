import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder, TextEncoder, types as utilTypes } from "node:util";

import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES,
  openPermanentStagingProviderVariableWriteEvidenceStore,
} from
  "../../scripts/lib/permanent-staging-provider-variable-write-evidence.js";

interface PoisonedProperty {
  readonly target: object;
  readonly key: PropertyKey;
  readonly label: string;
  readonly original: PropertyDescriptor | undefined;
  readonly calls: { count: number };
  readonly descriptor: PropertyDescriptor;
}

const definePropertyExact = Object.defineProperty;
const getOwnPropertyDescriptorExact = Object.getOwnPropertyDescriptor;
const deletePropertyExact = Reflect.deleteProperty;
const root = fs.realpathSync(fs.mkdtempSync(
  path.join(os.tmpdir(), "pintpath-provider-variable-intrinsics-test-"),
));
fs.chmodSync(root, 0o700);

const intentLeaf = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES
  .GOOGLE_MAPS_API_KEY.intent;
const intent = JSON.stringify({
  schemaVersion: "pintpath-permanent-staging-provider-variable-intent/v1",
  operation: "permanent-staging-provider-variable-single-write",
  sequentialNotAtomic: true,
});

try {
  const store = await openPermanentStagingProviderVariableWriteEvidenceStore(
    root,
  );
  const hashPrototype = Object.getPrototypeOf(crypto.createHash("sha256"));
  const fsPromises = fs.promises;
  const realpathExact = fs.realpath;
  const targets: Array<readonly [object, PropertyKey, string]> = [
    [Buffer, "alloc", "Buffer.alloc"],
    [Buffer, "from", "Buffer.from"],
    [Buffer, "byteLength", "Buffer.byteLength"],
    [Buffer, "isBuffer", "Buffer.isBuffer"],
    [Buffer.prototype, "equals", "Buffer.equals"],
    [Buffer.prototype, "toString", "Buffer.toString"],
    [Buffer.prototype, "hexSlice", "Buffer.hexSlice"],
    [Buffer.prototype, "utf8Write", "Buffer.utf8Write"],
    [Uint8Array.prototype, "fill", "Uint8Array.fill"],
    [Uint8Array.prototype, "set", "Uint8Array.set"],
    [JSON, "parse", "JSON.parse"],
    [JSON, "stringify", "JSON.stringify"],
    [Object.prototype, "toJSON", "Object.prototype.toJSON"],
    [crypto, "createHash", "crypto.createHash"],
    [crypto, "randomBytes", "crypto.randomBytes"],
    [hashPrototype, "update", "Hash.update"],
    [hashPrototype, "digest", "Hash.digest"],
    [Set.prototype, "has", "Set.has"],
    [RegExp.prototype, "test", "RegExp.test"],
    [RegExp.prototype, "exec", "RegExp.exec"],
    [String.prototype, "includes", "String.includes"],
    [String.prototype, "charAt", "String.charAt"],
    [String.prototype, "charCodeAt", "String.charCodeAt"],
    [TextDecoder.prototype, "decode", "TextDecoder.decode"],
    [TextEncoder.prototype, "encode", "TextEncoder.encode"],
    [Number, "isFinite", "Number.isFinite"],
    [Number, "isSafeInteger", "Number.isSafeInteger"],
    [Promise, "all", "Promise.all"],
    [Promise, "resolve", "Promise.resolve"],
    [Array.prototype, Symbol.iterator, "Array iterator"],
    [Array, "isArray", "Array.isArray"],
    [Object, "getPrototypeOf", "Object.getPrototypeOf"],
    [Object, "getOwnPropertyDescriptor", "Object.getOwnPropertyDescriptor"],
    [Object, "getOwnPropertyDescriptors", "Object.getOwnPropertyDescriptors"],
    [Object, "hasOwn", "Object.hasOwn"],
    [Object, "freeze", "Object.freeze"],
    [Reflect, "apply", "Reflect.apply"],
    [Reflect, "ownKeys", "Reflect.ownKeys"],
    [utilTypes, "isPromise", "util.types.isPromise"],
    [utilTypes, "isProxy", "util.types.isProxy"],
    [path, "join", "path.join"],
    [path, "dirname", "path.dirname"],
    [path, "basename", "path.basename"],
    [path, "resolve", "path.resolve"],
    [fsPromises, "open", "fs.open"],
    [fsPromises, "lstat", "fs.lstat"],
    [fsPromises, "realpath", "fs.realpath"],
    [fs, "realpath", "fs.realpath callback"],
    [realpathExact, "native", "fs.realpath.native"],
  ];
  const poisoned: PoisonedProperty[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const [target, key, label] = targets[index]!;
    const calls = { count: 0 };
    poisoned.push({
      target,
      key,
      label,
      original: getOwnPropertyDescriptorExact(target, key),
      calls,
      descriptor: {
        configurable: true,
        enumerable: false,
        writable: true,
        value() {
          calls.count += 1;
          throw new Error(`poison-called:${label}`);
        },
      },
    });
  }

  let applied = 0;
  let created: Awaited<ReturnType<typeof store.persist>> | undefined;
  try {
    for (let index = 0; index < poisoned.length; index += 1) {
      const poison = poisoned[index]!;
      definePropertyExact(poison.target, poison.key, poison.descriptor);
      applied = index + 1;
    }
    created = await store.persist(intentLeaf, intent, new AbortController().signal);
    await store.close();
  } finally {
    for (let index = applied - 1; index >= 0; index -= 1) {
      const poison = poisoned[index]!;
      if (poison.original === undefined) {
        deletePropertyExact(poison.target, poison.key);
      } else {
        definePropertyExact(poison.target, poison.key, poison.original);
      }
    }
  }

  assert.deepEqual({ ...created }, {
    publication: "created-durable",
    sha256: crypto.createHash("sha256").update(intent, "utf8").digest("hex"),
    canonicalPathExact: true,
    parentMode0700: true,
    fileMode0600: true,
    currentUid: true,
    regularFile: true,
    nonSymlink: true,
    nlinkOne: true,
    exclusiveCreate: true,
    identityHeld: true,
    fileFsync: true,
    parentFsync: true,
    readbackExact: true,
  });
  assert.equal(fs.readFileSync(path.join(root, intentLeaf), "utf8"), intent);
  for (const poison of poisoned) {
    assert.equal(poison.calls.count, 0, poison.label);
  }
  process.stdout.write("provider-variable-intrinsics-isolated-ok\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(`${root}-original`, { recursive: true, force: true });
}
