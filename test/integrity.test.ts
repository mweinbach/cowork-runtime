import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertTrustedRuntimeManifest,
  verifyRuntimeIntegrity,
  writeRuntimeIntegrity,
} from "../src/integrity";
import { parseRuntimeManifest } from "../src/manifest";
import type { CoworkRuntimeManifest } from "../src/types";

const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  manifest: CoworkRuntimeManifest;
  privateKey: string;
  publicKey: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-integrity-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "dependencies", "bin"), { recursive: true });
  await fs.writeFile(path.join(root, "dependencies", "bin", "node.exe"), "trusted-node");
  await fs.writeFile(path.join(root, "dependencies", "bin", "python.exe"), "trusted-python");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const manifest = {
    schemaVersion: 2,
    version: "2026-06-22",
    createdAt: "2026-06-22T00:00:00.000Z",
    asset: "win-x86",
    assetFileName: "cowork-runtime-win-x86.zip",
    compatibleHosts: ["win32-x64", "win32-arm64"],
    source: {
      kind: "codex-primary-runtime",
      bundleVersion: "fixture",
      targetPlatform: "win32",
      targetArch: "x64",
    },
    components: [
      { id: "node", strategy: "copied", path: "dependencies/bin/node.exe" },
      { id: "python", strategy: "copied", path: "dependencies/bin/python.exe" },
    ],
    versions: {},
    paths: {
      bin: "dependencies/bin",
      node: "dependencies/bin/node.exe",
      python: "dependencies/bin/python.exe",
      nodeModules: "dependencies/bin",
      nodeResolver: "dependencies/bin/node.exe",
      artifactToolPackage: "dependencies/bin",
    },
    payload: { fileCount: 2, unpackedBytes: 26 },
    integrity: {
      algorithm: "Ed25519",
      keyId: "test-release-key",
      manifest: "runtime-integrity.json",
      signature: "runtime-integrity.sig",
    },
  } satisfies CoworkRuntimeManifest;
  await fs.writeFile(path.join(root, "runtime.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifest, privateKey, publicKey };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("schema-2 runtime integrity", () => {
  test("signs and verifies the exact runtime file set and entrypoint closures", async () => {
    const { root, manifest, privateKey, publicKey } = await fixture();
    const integrity = await writeRuntimeIntegrity({ root, manifest, privateKey });

    expect(integrity.schemaVersion).toBe(2);
    expect(integrity.files.map((entry) => entry.path)).toEqual([
      "dependencies/bin/node.exe",
      "dependencies/bin/python.exe",
      "runtime.json",
    ]);
    expect(integrity.entrypoints.node).toEqual(["dependencies/bin/node.exe"]);
    await expect(
      verifyRuntimeIntegrity({
        root,
        manifest,
        trustedKeys: { "test-release-key": publicKey },
      }),
    ).resolves.toMatchObject({ fileCount: 3 });
  });

  test("rejects a replaced entrypoint, an unexpected file, and a changed signature", async () => {
    const { root, manifest, privateKey, publicKey } = await fixture();
    await writeRuntimeIntegrity({ root, manifest, privateKey });
    const trustedKeys = { "test-release-key": publicKey };

    await fs.writeFile(path.join(root, "dependencies", "bin", "node.exe"), "hacked--node");
    await expect(verifyRuntimeIntegrity({ root, manifest, trustedKeys })).rejects.toThrow(
      "SHA-256 mismatch",
    );

    await fs.writeFile(path.join(root, "dependencies", "bin", "node.exe"), "trusted-node");
    await fs.writeFile(path.join(root, "unexpected.dll"), "surprise");
    await expect(verifyRuntimeIntegrity({ root, manifest, trustedKeys })).rejects.toThrow(
      "Unexpected runtime file",
    );

    await fs.rm(path.join(root, "unexpected.dll"));
    const signaturePath = path.join(root, "runtime-integrity.sig");
    const signature = JSON.parse(await fs.readFile(signaturePath, "utf8"));
    signature.signature = Buffer.alloc(64).toString("base64");
    await fs.writeFile(signaturePath, `${JSON.stringify(signature, null, 2)}\n`);
    await expect(verifyRuntimeIntegrity({ root, manifest, trustedKeys })).rejects.toThrow(
      "signature is invalid",
    );
  });

  test("keeps schema 1 readable for diagnostics but refuses to trust it", () => {
    const legacy = parseRuntimeManifest({
      schemaVersion: 1,
      version: "2026-06-21",
      createdAt: "2026-06-21T00:00:00.000Z",
      asset: "win-x86",
      assetFileName: "cowork-runtime-win-x86.zip",
      compatibleHosts: ["win32-x64"],
      source: {
        kind: "codex-primary-runtime",
        bundleVersion: "legacy",
        targetPlatform: "win32",
        targetArch: "x64",
      },
      components: [],
      versions: {},
      paths: {
        bin: "dependencies/bin",
        node: "dependencies/node.exe",
        python: "dependencies/python.exe",
        nodeModules: "dependencies/node_modules",
        nodeResolver: "cowork/register.mjs",
        artifactToolPackage: "dependencies/node_modules/@oai/artifact-tool",
      },
      payload: { fileCount: 0, unpackedBytes: 0 },
    });

    expect(legacy.schemaVersion).toBe(1);
    expect(() => assertTrustedRuntimeManifest(legacy)).toThrow("schema 1");
  });
});
