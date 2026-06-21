import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { __libreOfficeInternal, readLibreOfficeSource } from "../src/libreoffice";

describe("managed headless LibreOffice", () => {
  test("pins a checksum-verified source for every runtime asset", async () => {
    for (const asset of [
      "win-x86",
      "macos-x86",
      "macos-arm64",
      "linux-x86",
      "linux-arm64",
    ] as const) {
      const source = await readLibreOfficeSource(asset);
      expect(source.version).toBe("26.2.3");
      expect(source.url).toStartWith("https://download.documentfoundation.org/");
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("prevents preparing a native payload on the wrong host", () => {
    expect(() => __libreOfficeInternal.assertBuildHost("win-x86", "linux")).toThrow(
      "must be prepared on win32",
    );
    expect(() => __libreOfficeInternal.assertBuildHost("linux-arm64", "linux")).not.toThrow();
  });

  test("forces an isolated headless invocation and blocks UI and printing", async () => {
    const launcherPath = path.resolve("runtime-support", "headless-soffice", "launcher.mjs");
    const launcherUrl = pathToFileURL(launcherPath).href;
    const launcher = (await import(launcherUrl)) as {
      createHeadlessInvocation(args: string[], profileDir: string): string[];
    };
    const args = launcher.createHeadlessInvocation(
      [
        "--headless",
        "-env:UserInstallation=file:///caller-profile",
        "--convert-to",
        "pdf",
        "input.docx",
      ],
      path.resolve("isolated-profile"),
    );
    expect(args).toContain("--headless");
    expect(args).toContain("--invisible");
    expect(args).toContain("--nodefault");
    expect(args.filter((arg) => arg.startsWith("-env:UserInstallation="))).toHaveLength(1);
    expect(args.join(" ")).not.toContain("caller-profile");

    expect(() => launcher.createHeadlessInvocation(["--print", "input.docx"], "profile")).toThrow(
      "Blocked interactive or printing option",
    );
    expect(() =>
      launcher.createHeadlessInvocation(["--convert-to", "pdf", "macro:///Main.Run"], "profile"),
    ).toThrow("Blocked executable or interactive document URL");
    expect(() => launcher.createHeadlessInvocation(["--accept=socket,host=localhost"], "profile"))
      .toThrow("only permits conversion");
    expect(() => launcher.createHeadlessInvocation(["input.docx"], "profile")).toThrow(
      "only permits conversion",
    );
    const launcherSource = await fs.readFile(launcherPath, "utf8");
    expect(launcherSource).toContain("DisableMacrosExecution");
    expect(launcherSource).toContain("SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION");
  });
});
