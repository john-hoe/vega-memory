import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SCRIPT_PATH = "scripts/guard-contract-enum-change.mjs";
const VALID_PR_BODY = `
## Reviewer dialogue

Reviewer confirmed the enum addition is intentional and compatible.

## Downstream compatibility report

SDK, API, MCP, and stored payload consumers were checked for compatibility.
`;
const VERSION_BUMP_DIFF = `
diff --git a/src/core/contracts/schema-version.ts b/src/core/contracts/schema-version.ts
index 1111111..2222222 100644
--- a/src/core/contracts/schema-version.ts
+++ b/src/core/contracts/schema-version.ts
@@ -66,0 +67,1 @@
+    version: "1.1",
`;

function runGuard(env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VEGA_CONTRACT_GUARD_BASE: "",
      VEGA_CONTRACT_GUARD_HEAD: "",
      VEGA_CONTRACT_GUARD_PR_BODY: "",
      VEGA_CONTRACT_GUARD_DIFF: "",
      ...env
    },
    encoding: "utf8"
  });
}

test("contract enum guard passes when canonical enums are untouched", () => {
  const result = runGuard({
    VEGA_CONTRACT_GUARD_CHANGED_FILES: "src/core/contracts/bundle.ts",
    VEGA_CONTRACT_GUARD_EVENT_NAME: "pull_request"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no canonical enum changes/u);
});

test("contract enum guard rejects enum changes outside pull requests", () => {
  const result = runGuard({
    VEGA_CONTRACT_GUARD_CHANGED_FILES: "src/core/contracts/enums.ts",
    VEGA_CONTRACT_GUARD_EVENT_NAME: "push",
    VEGA_CONTRACT_GUARD_DIFF: VERSION_BUMP_DIFF,
    VEGA_CONTRACT_GUARD_PR_BODY: VALID_PR_BODY
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside a pull_request event/u);
});

test("contract enum guard rejects enum changes without schema_version bump", () => {
  const result = runGuard({
    VEGA_CONTRACT_GUARD_CHANGED_FILES: "src/core/contracts/enums.ts",
    VEGA_CONTRACT_GUARD_EVENT_NAME: "pull_request",
    VEGA_CONTRACT_GUARD_DIFF: "",
    VEGA_CONTRACT_GUARD_PR_BODY: VALID_PR_BODY
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /schema_version was not bumped/u);
});

test("contract enum guard rejects enum changes without PR review evidence", () => {
  const result = runGuard({
    VEGA_CONTRACT_GUARD_CHANGED_FILES: "src/core/contracts/enums.ts",
    VEGA_CONTRACT_GUARD_EVENT_NAME: "pull_request",
    VEGA_CONTRACT_GUARD_DIFF: VERSION_BUMP_DIFF,
    VEGA_CONTRACT_GUARD_PR_BODY: "## Reviewer dialogue\n\nTODO\n"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reviewer dialogue/u);
  assert.match(result.stderr, /Downstream compatibility/u);
});

test("contract enum guard accepts enum changes with version bump and PR evidence", () => {
  const result = runGuard({
    VEGA_CONTRACT_GUARD_CHANGED_FILES: "src/core/contracts/enums.ts",
    VEGA_CONTRACT_GUARD_EVENT_NAME: "pull_request",
    VEGA_CONTRACT_GUARD_DIFF: VERSION_BUMP_DIFF,
    VEGA_CONTRACT_GUARD_PR_BODY: VALID_PR_BODY
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /schema_version bump/u);
});
