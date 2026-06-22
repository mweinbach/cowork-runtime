import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

const workflowPath = path.resolve(
  import.meta.dirname,
  "..",
  ".github",
  "workflows",
  "release-macos-runtime.yml",
);

describe("macOS runtime release workflow", () => {
  test("keeps staging private and refuses to replace published bytes", async () => {
    const workflow = await fs.readFile(workflowPath, "utf8");
    expect(workflow).toContain("runs-on: macos-15");
    expect(workflow).toContain('test "$(uname -m)" = "arm64"');
    expect(workflow).toContain('test "$(jq -r .isDraft <<<"$staging_json")" = "true"');
    expect(workflow).toContain("Refusing to replace immutable published asset");
    expect(workflow).not.toContain("--clobber");
  });

  test("verifies staging, production, clean-install, and published trees", async () => {
    const workflow = await fs.readFile(workflowPath, "utf8");
    expect(workflow).toContain("COWORK_RUNTIME_SIGNING_PRIVATE_KEY");
    expect(workflow).toContain("GitHub release signing secret does not match the pinned public key");
    expect(workflow).toContain("bun src/cli.ts reseal");
    expect(workflow).toContain("--source-public-key staging/cowork-runtime-staging.pub.pem");
    expect(workflow.match(/bun src\/cli\.ts verify/g)).toHaveLength(3);
    expect(workflow.match(/--execute/g)).toHaveLength(3);
    expect(workflow).toContain("Verify the published download path");
    expect(workflow).toContain("gh release delete");
  });
});
