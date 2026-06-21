import { RUNTIME_ASSET_IDS, type RuntimeAssetId, type RuntimeHost } from "./types";

const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isRuntimeAssetId(value: string): value is RuntimeAssetId {
  return (RUNTIME_ASSET_IDS as readonly string[]).includes(value);
}

export function assertRuntimeVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Runtime version must be an ISO date (YYYY-MM-DD), received "${version}".`);
  }
  const date = new Date(`${version}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== version) {
    throw new Error(`Runtime version is not a valid calendar date: "${version}".`);
  }
}

export function runtimeAssetFileName(asset: RuntimeAssetId): string {
  return `cowork-runtime-${asset}.zip`;
}

export function runtimeReleaseTag(version: string): string {
  assertRuntimeVersion(version);
  return `runtime-${version}`;
}

export function runtimeHostKey(host: RuntimeHost): string {
  return `${host.platform}-${host.arch}`;
}

export function compatibleHostsForAsset(asset: RuntimeAssetId): string[] {
  switch (asset) {
    case "win-x86":
      return ["win32-x64", "win32-arm64"];
    case "macos-x86":
      return ["darwin-x64"];
    case "macos-arm64":
      return ["darwin-arm64"];
    case "linux-x86":
      return ["linux-x64"];
    case "linux-arm64":
      return ["linux-arm64"];
  }
}

export function resolveRuntimeAssetForHost(host: RuntimeHost = process): RuntimeAssetId {
  const key = runtimeHostKey(host);
  for (const asset of RUNTIME_ASSET_IDS) {
    if (compatibleHostsForAsset(asset).includes(key)) return asset;
  }
  throw new Error(`Cowork runtime is not supported on ${key}.`);
}

export function expectedSourceTarget(asset: RuntimeAssetId): {
  targetPlatform: string;
  targetArch: string;
} {
  switch (asset) {
    case "win-x86":
      return { targetPlatform: "win32", targetArch: "x64" };
    case "macos-x86":
      return { targetPlatform: "darwin", targetArch: "x64" };
    case "macos-arm64":
      return { targetPlatform: "darwin", targetArch: "arm64" };
    case "linux-x86":
      return { targetPlatform: "linux", targetArch: "x64" };
    case "linux-arm64":
      return { targetPlatform: "linux", targetArch: "arm64" };
  }
}

export function assertHostCompatible(
  asset: RuntimeAssetId,
  host: RuntimeHost = process,
): void {
  const key = runtimeHostKey(host);
  if (!compatibleHostsForAsset(asset).includes(key)) {
    throw new Error(`Runtime asset ${asset} is not compatible with ${key}.`);
  }
}

