#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FORCED_FLAGS = [
  "--headless",
  "--invisible",
  "--nologo",
  "--nodefault",
  "--nofirststartwizard",
  "--nolockcheck",
  "--norestore",
];

const BLOCKED_OPTIONS = new Set([
  "-p",
  "--print",
  "--pt",
  "--print-to-file",
  "--printer-name",
  "--view",
  "--show",
  "--minimized",
  "--quickstart",
  "--writer",
  "--calc",
  "--draw",
  "--impress",
  "--base",
  "--math",
  "--web",
  "--global",
]);

const SAFE_OPERATIONS = new Set([
  "--convert-to",
  "--cat",
  "--version",
  "--help",
  "-h",
  "-?",
]);

const QUIET_PROFILE_REGISTRY = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <item oor:path="/org.openoffice.Office.Common/Save/Document">
    <prop oor:name="LoadPrinter" oor:op="fuse">
      <value>false</value>
    </prop>
  </item>
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="DisableMacrosExecution" oor:op="fuse">
      <value>true</value>
    </prop>
    <prop oor:name="MacroSecurityLevel" oor:op="fuse">
      <value>3</value>
    </prop>
  </item>
  <item oor:path="/org.openoffice.Office.Common/Misc">
    <prop oor:name="UseSystemFileDialog" oor:op="fuse">
      <value>false</value>
    </prop>
  </item>
</oor:items>
`;

function optionName(argument) {
  const index = argument.indexOf("=");
  return (index === -1 ? argument : argument.slice(0, index)).toLowerCase();
}

export function createHeadlessInvocation(arguments_, profileDir) {
  const callerArgs = arguments_.map(String);
  for (const argument of callerArgs) {
    const lower = argument.toLowerCase();
    if (BLOCKED_OPTIONS.has(optionName(argument))) {
      throw new Error(`Blocked interactive or printing option: ${argument}`);
    }
    if (
      lower.startsWith("macro:") ||
      lower.startsWith("vnd.sun.star.script:") ||
      lower.startsWith("service:") ||
      lower.startsWith("private:factory")
    ) {
      throw new Error(`Blocked executable or interactive document URL: ${argument}`);
    }
  }
  if (!callerArgs.some((argument) => SAFE_OPERATIONS.has(optionName(argument)))) {
    throw new Error(
      "Cowork's soffice launcher only permits conversion, text output, version, and help operations.",
    );
  }

  const retained = callerArgs.filter((argument) => {
    const normalized = optionName(argument);
    return !normalized.startsWith("-env:userinstallation") && !FORCED_FLAGS.includes(normalized);
  });
  return [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    ...FORCED_FLAGS,
    ...retained,
  ];
}

function runtimeRoot() {
  const configured = process.env.COWORK_RUNTIME_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function realSoffice(root) {
  const configured = process.env.COWORK_RUNTIME_LIBREOFFICE_BINARY?.trim();
  if (configured) return path.resolve(configured);
  if (process.platform === "win32") {
    return path.join(root, "dependencies", "libreoffice", "program", "soffice.com");
  }
  if (process.platform === "darwin") {
    return path.join(
      root,
      "dependencies",
      "libreoffice",
      "LibreOffice.app",
      "Contents",
      "MacOS",
      "soffice",
    );
  }
  return path.join(root, "dependencies", "libreoffice", "program", "soffice");
}

function seedProfile(profileDir) {
  const userDir = path.join(profileDir, "user");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "registrymodifications.xcu"), QUIET_PROFILE_REGISTRY, "utf8");
  for (const relative of ["home", "config", "cache", "appdata", "localappdata"]) {
    fs.mkdirSync(path.join(profileDir, relative), { recursive: true });
  }
}

function isolatedEnvironment(profileDir) {
  return {
    ...process.env,
    HOME: path.join(profileDir, "home"),
    XDG_CONFIG_HOME: path.join(profileDir, "config"),
    XDG_CACHE_HOME: path.join(profileDir, "cache"),
    APPDATA: path.join(profileDir, "appdata"),
    LOCALAPPDATA: path.join(profileDir, "localappdata"),
    SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION: "1",
  };
}

export function main(arguments_ = process.argv.slice(2)) {
  const root = runtimeRoot();
  const executable = realSoffice(root);
  if (!fs.existsSync(executable)) {
    throw new Error(`Managed LibreOffice executable is missing: ${executable}`);
  }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-soffice-profile-"));
  try {
    seedProfile(profileDir);
    const result = spawnSync(executable, createHeadlessInvocation(arguments_, profileDir), {
      stdio: "inherit",
      env: isolatedEnvironment(profileDir),
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return;
    }
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

function canonicalPath(candidate) {
  if (!candidate) return "";
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

const invokedPath = canonicalPath(process.argv[1]);
if (invokedPath === canonicalPath(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`[cowork-soffice] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 64;
  }
}
