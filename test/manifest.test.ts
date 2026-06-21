import { describe, expect, test } from "bun:test";

import { normalizeZipEntryName } from "../src/archive";
import { assertSafeRelativePath } from "../src/manifest";

describe("archive path containment", () => {
  test("accepts normalized relative paths", () => {
    expect(normalizeZipEntryName("dependencies/node/bin/node.exe")).toBe(
      "dependencies/node/bin/node.exe",
    );
    expect(() => assertSafeRelativePath("dependencies/node/node_modules")).not.toThrow();
  });

  test("rejects traversal, absolute, and Windows separator paths", () => {
    for (const candidate of ["../escape", "a/../../escape", "/absolute", "C:/escape", "a\\b"]) {
      expect(() => normalizeZipEntryName(candidate)).toThrow();
    }
    expect(() => assertSafeRelativePath("../escape")).toThrow();
  });
});
