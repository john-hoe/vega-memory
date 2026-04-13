import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const readFile = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

const assertOrderedIncludes = (content: string, values: string[], label: string): void => {
  let cursor = -1;

  for (const value of values) {
    const nextIndex = content.indexOf(value, cursor + 1);
    assert.notEqual(nextIndex, -1, `${label} should include ${value}`);
    cursor = nextIndex;
  }
};

test("README keeps the canonical five-minute loop and setup helpers", () => {
  const readme = readFile("README.md");

  assert.match(readme, /Node 20 LTS/);
  assertOrderedIncludes(
    readme,
    [
      "vega health",
      "vega store",
      "vega recall",
      'vega session-start --dir "$(pwd)" --mode L1 --json'
    ],
    "README canonical loop"
  );
  assert.match(readme, /vega setup --codex/);
  assert.match(readme, /vega setup --claude/);
  assert.match(readme, /vega setup --show/);
});

test("getting-started mirrors the canonical loop and setup helper entrypoints", () => {
  const gettingStarted = readFile("docs/site/getting-started.html");

  assert.match(gettingStarted, /Node\.js 20 LTS/);
  assert.doesNotMatch(gettingStarted, /Node\.js 18\+/);
  assertOrderedIncludes(
    gettingStarted,
    [
      "vega health",
      "vega store",
      "vega recall",
      'vega session-start --dir "$(pwd)"'
    ],
    "Getting started canonical loop"
  );
  assert.match(gettingStarted, /vega setup --codex/);
  assert.match(gettingStarted, /vega setup --claude/);
  assert.match(gettingStarted, /vega setup --show/);
});

test("deployment guide documents the supported setup helpers", () => {
  const deploymentGuide = readFile("docs/deployment.md");

  assert.match(deploymentGuide, /vega setup --codex/);
  assert.match(deploymentGuide, /vega setup --claude/);
  assert.match(deploymentGuide, /vega setup --server 127\.0\.0\.1 --port 3271 --cursor/);
  assert.match(deploymentGuide, /vega setup --show/);
  assert.match(deploymentGuide, /Codex uses the same CLI-first memory workflow/);
});
