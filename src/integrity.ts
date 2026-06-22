import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertSafeRelativePath } from "./manifest";
import type {
  CoworkRuntimeManifest,
  RuntimeIntegrityFile,
  RuntimeIntegrityManifest,
  TrustedCoworkRuntimeManifest,
} from "./types";

export const RUNTIME_INTEGRITY_MANIFEST_FILE = "runtime-integrity.json";
export const RUNTIME_INTEGRITY_SIGNATURE_FILE = "runtime-integrity.sig";

export type RuntimeKeyMaterial = string | Buffer;
export type TrustedRuntimeKeys = Record<string, RuntimeKeyMaterial>;

type SignatureEnvelope = {
  schemaVersion: 1;
  algorithm: "Ed25519";
  keyId: string;
  signature: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function describeEntry(root: string, relativePath: string): Promise<RuntimeIntegrityFile> {
  assertSafeRelativePath(relativePath, "integrity file path");
  const absolute = path.join(root, ...relativePath.split("/"));
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(absolute);
    const bytes = Buffer.from(target, "utf8");
    return {
      path: relativePath,
      kind: "symlink",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  if (!stat.isFile()) throw new Error(`Unsupported runtime entry: ${relativePath}`);
  if (stat.nlink !== 1) throw new Error(`Runtime hard links are forbidden: ${relativePath}`);
  return { path: relativePath, kind: "file", size: stat.size, sha256: await sha256File(absolute) };
}

async function collectRuntimeFiles(root: string): Promise<RuntimeIntegrityFile[]> {
  const relativePaths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (
        relative === RUNTIME_INTEGRITY_MANIFEST_FILE ||
        relative === RUNTIME_INTEGRITY_SIGNATURE_FILE
      ) {
        continue;
      }
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory()) await visit(absolute);
      else relativePaths.push(relative);
    }
  };
  await visit(root);
  relativePaths.sort();
  const files = new Array<RuntimeIntegrityFile>(relativePaths.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < relativePaths.length) {
      const index = nextIndex++;
      const relativePath = relativePaths[index];
      if (relativePath === undefined) return;
      files[index] = await describeEntry(root, relativePath);
    }
  };
  const concurrency = Math.max(2, Math.min(16, os.availableParallelism()));
  await Promise.all(
    Array.from({ length: Math.min(concurrency, relativePaths.length) }, () => worker()),
  );
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

function closureForPath(files: RuntimeIntegrityFile[], candidate: string): string[] {
  const prefix = `${candidate}/`;
  return files
    .filter((entry) => entry.path === candidate || entry.path.startsWith(prefix))
    .map((entry) => entry.path);
}

function parseIntegrityManifest(value: unknown): RuntimeIntegrityManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    value.algorithm !== "Ed25519" ||
    typeof value.keyId !== "string" ||
    typeof value.runtimeVersion !== "string" ||
    typeof value.asset !== "string" ||
    !Array.isArray(value.files) ||
    !isRecord(value.components) ||
    !isRecord(value.entrypoints)
  ) {
    throw new Error("Runtime integrity manifest is invalid.");
  }
  let previous = "";
  for (const rawEntry of value.files) {
    if (
      !isRecord(rawEntry) ||
      typeof rawEntry.path !== "string" ||
      (rawEntry.kind !== "file" && rawEntry.kind !== "symlink") ||
      !Number.isSafeInteger(rawEntry.size) ||
      (rawEntry.size as number) < 0 ||
      typeof rawEntry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(rawEntry.sha256)
    ) {
      throw new Error("Runtime integrity file entry is invalid.");
    }
    assertSafeRelativePath(rawEntry.path, "integrity file path");
    if (rawEntry.path <= previous) {
      throw new Error("Runtime integrity file entries must be unique and sorted.");
    }
    previous = rawEntry.path;
  }
  for (const [label, closure] of [
    ...Object.entries(value.components),
    ...Object.entries(value.entrypoints),
  ]) {
    if (!Array.isArray(closure) || !closure.every((item) => typeof item === "string")) {
      throw new Error(`Runtime integrity closure ${label} is invalid.`);
    }
  }
  return value as RuntimeIntegrityManifest;
}

function parseSignatureEnvelope(value: unknown): SignatureEnvelope {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.algorithm !== "Ed25519" ||
    typeof value.keyId !== "string" ||
    typeof value.signature !== "string"
  ) {
    throw new Error("Runtime integrity signature envelope is invalid.");
  }
  const bytes = Buffer.from(value.signature, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value.signature) {
    throw new Error("Runtime integrity signature encoding is invalid.");
  }
  return value as SignatureEnvelope;
}

export function assertTrustedRuntimeManifest(
  manifest: CoworkRuntimeManifest,
): asserts manifest is TrustedCoworkRuntimeManifest {
  if (manifest.schemaVersion !== 2 || !manifest.integrity) {
    throw new Error(
      `Cowork runtime schema ${manifest.schemaVersion} is diagnostics-only and cannot be executed; install a signed schema-2 runtime.`,
    );
  }
}

export async function writeRuntimeIntegrity(opts: {
  root: string;
  manifest: CoworkRuntimeManifest;
  privateKey: RuntimeKeyMaterial;
}): Promise<RuntimeIntegrityManifest> {
  const root = path.resolve(opts.root);
  assertTrustedRuntimeManifest(opts.manifest);
  await fs.rm(path.join(root, RUNTIME_INTEGRITY_MANIFEST_FILE), { force: true });
  await fs.rm(path.join(root, RUNTIME_INTEGRITY_SIGNATURE_FILE), { force: true });
  const files = await collectRuntimeFiles(root);
  const components = Object.fromEntries(
    opts.manifest.components.map((component) => [component.id, closureForPath(files, component.path)]),
  );
  const entrypoints = Object.fromEntries(
    Object.entries(opts.manifest.paths).map(([name, candidate]) => [
      name,
      closureForPath(files, candidate),
    ]),
  );
  const integrity: RuntimeIntegrityManifest = {
    schemaVersion: 2,
    algorithm: "Ed25519",
    keyId: opts.manifest.integrity.keyId,
    runtimeVersion: opts.manifest.version,
    asset: opts.manifest.asset,
    files,
    components,
    entrypoints,
  };
  const integrityBytes = canonicalJson(integrity);
  const signature = sign(null, integrityBytes, createPrivateKey(opts.privateKey));
  const envelope: SignatureEnvelope = {
    schemaVersion: 1,
    algorithm: "Ed25519",
    keyId: integrity.keyId,
    signature: signature.toString("base64"),
  };
  await fs.writeFile(path.join(root, RUNTIME_INTEGRITY_MANIFEST_FILE), integrityBytes, {
    flag: "wx",
  });
  await fs.writeFile(path.join(root, RUNTIME_INTEGRITY_SIGNATURE_FILE), canonicalJson(envelope), {
    flag: "wx",
  });
  return integrity;
}

export async function verifyRuntimeIntegrity(opts: {
  root: string;
  manifest: CoworkRuntimeManifest;
  trustedKeys: TrustedRuntimeKeys;
}): Promise<{ fileCount: number; bytes: number; keyId: string }> {
  const root = path.resolve(opts.root);
  assertTrustedRuntimeManifest(opts.manifest);
  const integrityPath = path.join(root, opts.manifest.integrity.manifest);
  const signaturePath = path.join(root, opts.manifest.integrity.signature);
  const integrityBytes = await fs.readFile(integrityPath);
  const envelope = parseSignatureEnvelope(JSON.parse(await fs.readFile(signaturePath, "utf8")));
  if (envelope.keyId !== opts.manifest.integrity.keyId) {
    throw new Error("Runtime integrity signature key ID does not match runtime.json.");
  }
  const publicKey = opts.trustedKeys[envelope.keyId];
  if (!publicKey) throw new Error(`Runtime integrity key is not trusted: ${envelope.keyId}.`);
  if (!verify(null, integrityBytes, createPublicKey(publicKey), Buffer.from(envelope.signature, "base64"))) {
    throw new Error("Runtime integrity signature is invalid.");
  }
  const integrity = parseIntegrityManifest(JSON.parse(integrityBytes.toString("utf8")));
  if (
    integrity.keyId !== envelope.keyId ||
    integrity.runtimeVersion !== opts.manifest.version ||
    integrity.asset !== opts.manifest.asset
  ) {
    throw new Error("Runtime integrity manifest does not match runtime.json.");
  }

  const actual = await collectRuntimeFiles(root);
  const expectedByPath = new Map(integrity.files.map((entry) => [entry.path, entry]));
  for (const entry of actual) {
    const expected = expectedByPath.get(entry.path);
    if (!expected) throw new Error(`Unexpected runtime file: ${entry.path}.`);
    if (entry.kind !== expected.kind) throw new Error(`Runtime file type mismatch: ${entry.path}.`);
    if (entry.size !== expected.size) throw new Error(`Runtime file size mismatch: ${entry.path}.`);
    if (entry.sha256 !== expected.sha256) throw new Error(`Runtime file SHA-256 mismatch: ${entry.path}.`);
    expectedByPath.delete(entry.path);
  }
  const missing = expectedByPath.keys().next().value as string | undefined;
  if (missing) throw new Error(`Missing runtime file: ${missing}.`);
  return {
    fileCount: actual.length,
    bytes: actual.reduce((total, entry) => total + entry.size, 0),
    keyId: envelope.keyId,
  };
}
