import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { __libreOfficeInternal, readLibreOfficeSource } from "../src/libreoffice";

const execFileAsync = promisify(execFile);

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

  test("preserves the signed macOS app during preparation", () => {
    expect(__libreOfficeInternal.preparedOfficeEnvironment({ PYTHONDONTWRITEBYTECODE: "0" }))
      .toMatchObject({
        PYTHONDONTWRITEBYTECODE: "1",
        SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION: "1",
      });
    expect(__libreOfficeInternal.codeSignatureVerification("/runtime/libreoffice", "macos-arm64"))
      .toEqual({
        command: "codesign",
        args: [
          "--verify",
          "--deep",
          "--strict",
          path.join("/runtime/libreoffice", "LibreOffice.app"),
        ],
      });
    expect(__libreOfficeInternal.codeSignatureVerification("C:\\runtime", "win-x86")).toBeNull();
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

  test("runs when invoked through a symlinked runtime path", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-soffice-symlink-"));
    try {
      const realRoot = path.join(root, "real");
      const aliasRoot = path.join(root, "alias");
      const fakeSoffice = path.join(root, "fake-soffice");
      await fs.mkdir(realRoot, { recursive: true });
      await fs.symlink(path.resolve("runtime-support"), path.join(realRoot, "runtime-support"));
      await fs.symlink(realRoot, aliasRoot);
      await fs.writeFile(fakeSoffice, "#!/bin/sh\nprintf 'fake-soffice:%s\\n' \"$*\"\n", "utf8");
      await fs.chmod(fakeSoffice, 0o755);

      const launcher = path.join(
        aliasRoot,
        "runtime-support",
        "headless-soffice",
        "launcher.mjs",
      );
      const result = await execFileAsync(process.execPath, [launcher, "--version"], {
        env: {
          ...process.env,
          COWORK_RUNTIME_DIR: realRoot,
          COWORK_RUNTIME_LIBREOFFICE_BINARY: fakeSoffice,
        },
      });
      expect(result.stdout).toContain("fake-soffice:");
      expect(result.stdout).toContain("--version");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
