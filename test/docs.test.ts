import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { RUNTIME_ASSET_IDS } from "../src/types";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function markdownFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if ([".git", "node_modules", "payloads", "dist"].includes(entry.name)) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".md")) result.push(absolute);
    }
  };
  await visit(root);
  return result.sort((left, right) => left.localeCompare(right));
}

describe("maintainer documentation", () => {
  test("all local Markdown links resolve", async () => {
    const missing: string[] = [];
    for (const markdownPath of await markdownFiles(repoRoot)) {
      const raw = await fs.readFile(markdownPath, "utf8");
      for (const match of raw.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const href = match[1]?.trim().replace(/^<|>$/g, "");
        if (!href || href.startsWith("#") || /^(https?:|mailto:)/.test(href)) continue;
        const withoutAnchor = href.split("#", 1)[0];
        if (!withoutAnchor) continue;
        const target = path.resolve(path.dirname(markdownPath), withoutAnchor);
        if (!(await fs.stat(target).catch(() => null))) {
          missing.push(`${path.relative(repoRoot, markdownPath)} -> ${href}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("the platform guide covers every declared asset", async () => {
    const guide = await fs.readFile(path.join(repoRoot, "docs", "adding-a-platform.md"), "utf8");
    for (const asset of RUNTIME_ASSET_IDS) expect(guide).toContain(`\`${asset}\``);
    expect(guide).toContain("--component-plan");
  });
});
