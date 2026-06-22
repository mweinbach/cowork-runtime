import { createPublicKey } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  RUNTIME_INTEGRITY_MANIFEST_FILE,
  RUNTIME_INTEGRITY_SIGNATURE_FILE,
  type RuntimeKeyMaterial,
  type TrustedRuntimeKeys,
  writeRuntimeIntegrity,
} from "./integrity";
import {
  RUNTIME_MANIFEST_FILE,
  readRuntimeManifest,
  writeRuntimeManifest,
} from "./manifest";
import { verifyRuntime } from "./runtime";
import type { CoworkRuntimeManifest, RuntimeAssetId, RuntimeHost } from "./types";

type RuntimeMetadataSnapshot = {
  manifest: Buffer;
  integrity: Buffer;
  signature: Buffer;
};

async function readMetadataSnapshot(runtimeDir: string): Promise<RuntimeMetadataSnapshot> {
  const read = (name: string) => fs.readFile(path.join(runtimeDir, name));
  const [manifest, integrity, signature] = await Promise.all([
    read(RUNTIME_MANIFEST_FILE),
    read(RUNTIME_INTEGRITY_MANIFEST_FILE),
    read(RUNTIME_INTEGRITY_SIGNATURE_FILE),
  ]);
  return { manifest, integrity, signature };
}

async function restoreMetadataSnapshot(
  runtimeDir: string,
  snapshot: RuntimeMetadataSnapshot,
): Promise<void> {
  await Promise.all([
    fs.writeFile(path.join(runtimeDir, RUNTIME_MANIFEST_FILE), snapshot.manifest),
    fs.writeFile(path.join(runtimeDir, RUNTIME_INTEGRITY_MANIFEST_FILE), snapshot.integrity),
    fs.writeFile(path.join(runtimeDir, RUNTIME_INTEGRITY_SIGNATURE_FILE), snapshot.signature),
  ]);
}

export async function resealRuntime(opts: {
  runtimeDir: string;
  sourceTrustedKeys: TrustedRuntimeKeys;
  signingKey: { keyId: string; privateKey: RuntimeKeyMaterial };
  expectedVersion?: string;
  expectedAsset?: RuntimeAssetId;
  execute?: boolean;
  host?: RuntimeHost;
}): Promise<CoworkRuntimeManifest> {
  const runtimeDir = path.resolve(opts.runtimeDir);
  const manifest = await readRuntimeManifest(runtimeDir);
  if (opts.expectedVersion && manifest.version !== opts.expectedVersion) {
    throw new Error(
      `Runtime version ${manifest.version} does not match expected ${opts.expectedVersion}.`,
    );
  }
  if (opts.expectedAsset && manifest.asset !== opts.expectedAsset) {
    throw new Error(`Runtime asset ${manifest.asset} does not match expected ${opts.expectedAsset}.`);
  }

  const sourceVerification = await verifyRuntime({
    runtimeDir,
    deep: true,
    execute: opts.execute !== false,
    host: opts.host,
    trustedKeys: opts.sourceTrustedKeys,
  });
  if (!sourceVerification.ok) {
    throw new Error(
      `Refusing to re-seal an unverified runtime:\n${sourceVerification.errors.join("\n")}`,
    );
  }

  const snapshot = await readMetadataSnapshot(runtimeDir);
  const resealed: CoworkRuntimeManifest = {
    ...manifest,
    schemaVersion: 2,
    integrity: {
      algorithm: "Ed25519",
      keyId: opts.signingKey.keyId,
      manifest: RUNTIME_INTEGRITY_MANIFEST_FILE,
      signature: RUNTIME_INTEGRITY_SIGNATURE_FILE,
    },
  };
  const targetPublicKey = createPublicKey(opts.signingKey.privateKey).export({
    format: "pem",
    type: "spki",
  });

  try {
    await writeRuntimeManifest(runtimeDir, resealed);
    await writeRuntimeIntegrity({
      root: runtimeDir,
      manifest: resealed,
      privateKey: opts.signingKey.privateKey,
    });
    const targetVerification = await verifyRuntime({
      runtimeDir,
      deep: true,
      execute: opts.execute !== false,
      host: opts.host,
      trustedKeys: { [opts.signingKey.keyId]: targetPublicKey },
    });
    if (!targetVerification.ok) {
      throw new Error(
        `Re-sealed runtime failed verification:\n${targetVerification.errors.join("\n")}`,
      );
    }
    return resealed;
  } catch (error) {
    await restoreMetadataSnapshot(runtimeDir, snapshot);
    throw error;
  }
}
