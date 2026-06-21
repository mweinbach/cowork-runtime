import { describe, expect, test } from "bun:test";

import {
  assertRuntimeVersion,
  resolveRuntimeAssetForHost,
  runtimeAssetFileName,
  runtimeReleaseTag,
} from "../src/platform";

describe("runtime platform resolution", () => {
  test("uses the Windows x86-64 payload for x64 and ARM64 hosts", () => {
    expect(resolveRuntimeAssetForHost({ platform: "win32", arch: "x64" })).toBe("win-x86");
    expect(resolveRuntimeAssetForHost({ platform: "win32", arch: "arm64" })).toBe("win-x86");
  });

  test("keeps macOS and Linux architecture-specific", () => {
    expect(resolveRuntimeAssetForHost({ platform: "darwin", arch: "x64" })).toBe("macos-x86");
    expect(resolveRuntimeAssetForHost({ platform: "darwin", arch: "arm64" })).toBe("macos-arm64");
    expect(resolveRuntimeAssetForHost({ platform: "linux", arch: "x64" })).toBe("linux-x86");
    expect(resolveRuntimeAssetForHost({ platform: "linux", arch: "arm64" })).toBe("linux-arm64");
  });

  test("uses date tags and stable asset names", () => {
    expect(runtimeReleaseTag("2026-06-21")).toBe("runtime-2026-06-21");
    expect(runtimeAssetFileName("win-x86")).toBe("cowork-runtime-win-x86.zip");
    expect(() => assertRuntimeVersion("2026-02-30")).toThrow("valid calendar date");
  });
});

