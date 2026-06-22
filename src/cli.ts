#!/usr/bin/env bun

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildRuntimeArchive } from "./archive";
import type { TrustedRuntimeKeys } from "./integrity";
import { downloadAndInstallRuntime } from "./download";
import {
  activateInstalledRuntime,
  installRuntimeArchive,
  listInstalledRuntimes,
  resolveCurrentRuntime,
} from "./install";
import { prepareLibreOfficeInput } from "./libreoffice";
import { isRuntimeAssetId, resolveRuntimeAssetForHost, runtimeAssetFileName } from "./platform";
import { resealRuntime } from "./reseal";
import { buildRuntimeEnv, stageRuntime, verifyRuntime } from "./runtime";

const args = process.argv.slice(2);
const command = args.shift();
const DEFAULT_SIGNING_KEY_ID = "cowork-runtime-release-1";
const DEFAULT_PUBLIC_KEY_FILE = path.resolve(
  import.meta.dirname,
  "..",
  "keys",
  "cowork-runtime-release-1.pub.pem",
);

function usage(): string {
  return `Cowork runtime builder and installer

Commands:
  prepare-libreoffice  Download, verify, and normalize the private LibreOffice payload
  stage     Assemble a platform payload from a source runtime
  build     Build a ZIP and SHA-256 sidecar from a staged payload
  reseal    Verify a staged runtime, then replace its signing identity atomically
  verify    Verify a staged or installed runtime
  install   Install a local release ZIP into ~/.cowork/runtime/YYYY-MM-DD
  download  Download and install a GitHub release
  list      List installed runtimes
  activate  Switch current.json to an installed runtime
  env       Print the current runtime environment as JSON

Examples:
  bun src/cli.ts prepare-libreoffice --asset win-x86 --force
  bun run stage -- --source C:\\Users\\me\\.cache\\codex-runtimes\\codex-primary-runtime --asset win-x86 --version 2026-06-22 --force
  bun run stage -- --source /runtime --asset linux-x86 --version 2026-06-22 --component-plan recipes/linux-x86/runtime-components.json --force
  bun run build -- --runtime payloads/win-x86
  bun src/cli.ts reseal --runtime payloads/macos-arm64 --source-public-key staging.pub.pem --source-key-id staging --asset macos-arm64 --version 2026-06-22
  bun src/cli.ts install --archive dist/cowork-runtime-win-x86.zip --checksum dist/cowork-runtime-win-x86.zip.sha256
  bun src/cli.ts download --repo owner/cowork-runtime --version 2026-06-22
`;
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function flag(name: string): boolean {
  return args.includes(name);
}

function runtimeAsset() {
  return optionalRuntimeAsset() ?? resolveRuntimeAssetForHost();
}

function optionalRuntimeAsset() {
  const requested = option("--asset");
  if (!requested) return undefined;
  if (!isRuntimeAssetId(requested)) throw new Error(`Unknown runtime asset: ${requested}`);
  return requested;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function signingKey(): Promise<{ keyId: string; privateKey: Buffer }> {
  const keyId =
    option("--key-id") ?? process.env.COWORK_RUNTIME_SIGNING_KEY_ID ?? DEFAULT_SIGNING_KEY_ID;
  const keyFile = option("--signing-key") ?? process.env.COWORK_RUNTIME_SIGNING_KEY_FILE;
  if (!keyId || !keyFile) {
    throw new Error(
      "Signed schema-2 runtimes require --signing-key or COWORK_RUNTIME_SIGNING_KEY_FILE.",
    );
  }
  return { keyId, privateKey: await fs.readFile(path.resolve(keyFile)) };
}

async function trustedKeys(): Promise<TrustedRuntimeKeys> {
  const keyId =
    option("--key-id") ?? process.env.COWORK_RUNTIME_SIGNING_KEY_ID ?? DEFAULT_SIGNING_KEY_ID;
  const keyFile =
    option("--public-key") ??
    process.env.COWORK_RUNTIME_PUBLIC_KEY_FILE ??
    DEFAULT_PUBLIC_KEY_FILE;
  return { [keyId]: await fs.readFile(path.resolve(keyFile)) };
}

async function sourceTrustedKeys(): Promise<TrustedRuntimeKeys> {
  const keyId = option("--source-key-id");
  const keyFile = option("--source-public-key");
  if (!keyId || !keyFile) {
    throw new Error("reseal requires --source-key-id and --source-public-key.");
  }
  return { [keyId]: await fs.readFile(path.resolve(keyFile)) };
}

async function checksumFromFile(checksumPath: string, archivePath: string): Promise<string> {
  const raw = await fs.readFile(checksumPath, "utf8");
  const match = raw.trim().split(/\r?\n/)[0]?.match(/^([a-fA-F0-9]{64})(?:\s+\*?(.+))?$/);
  if (!match?.[1]) throw new Error(`Invalid checksum file: ${checksumPath}`);
  const namedFile = match[2]?.trim();
  if (namedFile && namedFile !== path.basename(archivePath)) {
    throw new Error(`Checksum names ${namedFile}, expected ${path.basename(archivePath)}.`);
  }
  return match[1].toLowerCase();
}

async function main(): Promise<void> {
  switch (command) {
    case "prepare-libreoffice": {
      const asset = runtimeAsset();
      const result = await prepareLibreOfficeInput({
        asset,
        ...(option("--output") ? { outputDir: path.resolve(option("--output") as string) } : {}),
        ...(option("--cache") ? { cacheDir: path.resolve(option("--cache") as string) } : {}),
        ...(option("--sources")
          ? { sourcesFile: path.resolve(option("--sources") as string) }
          : {}),
        force: flag("--force"),
        log: console.log,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "stage": {
      const asset = runtimeAsset();
      const sourceDir = path.resolve(
        option("--source") ??
          path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime"),
      );
      const destinationDir = path.resolve(option("--destination") ?? path.join("payloads", asset));
      const manifest = await stageRuntime({
        sourceDir,
        destinationDir,
        asset,
        version: option("--version") ?? today(),
        signingKey: await signingKey(),
        force: flag("--force"),
        ...(option("--component-plan")
          ? { componentPlanPath: path.resolve(option("--component-plan") as string) }
          : {}),
        ...(option("--support-dir")
          ? { supportDir: path.resolve(option("--support-dir") as string) }
          : {}),
        ...(option("--component-input")
          ? { componentInputDir: path.resolve(option("--component-input") as string) }
          : {}),
        ...(option("--rustc") ? { rustcPath: path.resolve(option("--rustc") as string) } : {}),
        ...(option("--soffice-shim")
          ? { windowsSofficeShimPath: path.resolve(option("--soffice-shim") as string) }
          : {}),
        log: console.log,
      });
      console.log(JSON.stringify({ destinationDir, manifest }, null, 2));
      return;
    }
    case "build": {
      const asset = runtimeAsset();
      const runtimeDir = path.resolve(option("--runtime") ?? path.join("payloads", asset));
      const outputFile = path.resolve(
        option("--output") ?? path.join("dist", runtimeAssetFileName(asset)),
      );
      const compression = option("--compression");
      const result = await buildRuntimeArchive({
        runtimeDir,
        outputFile,
        signingKey: await signingKey(),
        ...(compression ? { compressionLevel: Number(compression) } : {}),
        log: console.log,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "reseal": {
      const runtimeDir = option("--runtime");
      if (!runtimeDir) throw new Error("reseal requires --runtime.");
      const expectedAsset = optionalRuntimeAsset();
      const manifest = await resealRuntime({
        runtimeDir,
        sourceTrustedKeys: await sourceTrustedKeys(),
        signingKey: await signingKey(),
        ...(option("--version") ? { expectedVersion: option("--version") } : {}),
        ...(expectedAsset ? { expectedAsset } : {}),
        execute: !flag("--no-execute"),
      });
      console.log(JSON.stringify({ runtimeDir: path.resolve(runtimeDir), manifest }, null, 2));
      return;
    }
    case "verify": {
      const runtimeDir = option("--runtime") ?? (await resolveCurrentRuntime(option("--home")));
      if (!runtimeDir) throw new Error("No runtime path was provided and no current runtime is active.");
      const result = await verifyRuntime({
        runtimeDir,
        deep: flag("--deep"),
        execute: flag("--execute"),
        trustedKeys: await trustedKeys(),
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "install": {
      const archive = option("--archive");
      if (!archive) throw new Error("install requires --archive.");
      const archivePath = path.resolve(archive);
      const checksumPath = path.resolve(option("--checksum") ?? `${archivePath}.sha256`);
      const result = await installRuntimeArchive({
        archivePath,
        expectedSha256: await checksumFromFile(checksumPath, archivePath),
        ...(option("--home") ? { home: option("--home") } : {}),
        force: flag("--force"),
        activate: !flag("--no-activate"),
        log: console.log,
        trustedKeys: await trustedKeys(),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "download": {
      const repository = option("--repo");
      const version = option("--version");
      if (!repository || !version) throw new Error("download requires --repo and --version.");
      const result = await downloadAndInstallRuntime({
        repository,
        version,
        ...(option("--tag") ? { tag: option("--tag") } : {}),
        ...(option("--home") ? { home: option("--home") } : {}),
        force: flag("--force"),
        activate: !flag("--no-activate"),
        log: console.log,
        trustedKeys: await trustedKeys(),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "list": {
      console.log(JSON.stringify(await listInstalledRuntimes(option("--home")), null, 2));
      return;
    }
    case "activate": {
      const version = option("--version");
      if (!version) throw new Error("activate requires --version.");
      console.log(await activateInstalledRuntime(version, option("--home")));
      return;
    }
    case "env": {
      const runtimeDir = option("--runtime") ?? (await resolveCurrentRuntime(option("--home")));
      if (!runtimeDir) throw new Error("No current runtime is active.");
      const env = await buildRuntimeEnv(runtimeDir, {}, process.platform, await trustedKeys());
      console.log(JSON.stringify(env, null, 2));
      return;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(usage());
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
