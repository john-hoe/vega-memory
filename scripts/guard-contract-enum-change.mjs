#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const ENUMS_PATH = "src/core/contracts/enums.ts";
const SOURCE_SCHEMA_VERSION_PATHS = new Set([
  "src/core/contracts/schema-version.ts",
  "src/core/contracts/envelope.ts",
  "src/core/contracts/bundle.ts",
  "src/core/contracts/usage-ack.ts",
  "src/core/contracts/usage-checkpoint.ts",
  "src/core/contracts/usage-fallback.ts",
  "src/core/contracts/intent.ts",
  "src/core/contracts/checkpoint-record.ts"
]);

function splitList(value) {
  return value
    .split(/[\n,]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function runGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function diffArgs() {
  const base = process.env.VEGA_CONTRACT_GUARD_BASE?.trim();
  const head = process.env.VEGA_CONTRACT_GUARD_HEAD?.trim() || "HEAD";

  if (base !== undefined && base.length > 0) {
    return [`${base}...${head}`];
  }

  return ["origin/main...HEAD"];
}

function changedFiles() {
  const override = process.env.VEGA_CONTRACT_GUARD_CHANGED_FILES;
  if (override !== undefined) {
    return splitList(override);
  }

  return splitList(runGit(["diff", "--name-only", ...diffArgs()]));
}

function unifiedDiff() {
  const override = process.env.VEGA_CONTRACT_GUARD_DIFF;
  if (override !== undefined) {
    return override;
  }

  return runGit(["diff", "--no-ext-diff", "--unified=0", ...diffArgs()]);
}

function hasSchemaVersionBump(diff) {
  let currentPath = "";

  for (const line of diff.split(/\r?\n/u)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/u.exec(line);
    if (header !== null) {
      currentPath = header[2] ?? "";
      continue;
    }

    if (!SOURCE_SCHEMA_VERSION_PATHS.has(currentPath) || !line.startsWith("+") || line.startsWith("+++")) {
      continue;
    }

    if (
      /\bschema_version\b.*["']\d+\.\d+(?:\.\d+)?["']/u.test(line) ||
      /\bversion\s*:\s*["']\d+\.\d+(?:\.\d+)?["']/u.test(line)
    ) {
      return true;
    }
  }

  return false;
}

function extractSection(body, labels) {
  for (const label of labels) {
    const expression = new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?${label}\\s*:?\\s*`, "iu");
    const match = expression.exec(body);
    if (match === null || match.index === undefined) {
      continue;
    }

    const start = match.index + match[0].length;
    const rest = body.slice(start);
    const nextHeading = rest.search(/\n\s*(?:#{1,6}\s+[\p{L}\p{N}][^\n]*|[A-Z][A-Za-z0-9 /_-]{2,80}:\s*)/u);
    return (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
  }

  return "";
}

function hasFilledSection(body, labels) {
  const content = extractSection(body, labels);
  if (content.length === 0) {
    return false;
  }

  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some(
      (line) =>
        line.length > 0 &&
        !line.includes("{{") &&
        !/^(?:-|)\s*(?:n\/a|none|todo|tbd|not applicable)$/iu.test(line) &&
        !/^- \[ \]/u.test(line)
    );
}

function fail(messages) {
  console.error("Contract enum guard failed:");
  for (const message of messages) {
    console.error(`- ${message}`);
  }
  process.exit(1);
}

const files = changedFiles();

if (!files.includes(ENUMS_PATH)) {
  console.log("Contract enum guard: no canonical enum changes detected.");
  process.exit(0);
}

const failures = [];
const eventName = process.env.VEGA_CONTRACT_GUARD_EVENT_NAME ?? process.env.GITHUB_EVENT_NAME ?? "";

if (eventName !== "pull_request" && process.env.VEGA_CONTRACT_GUARD_ALLOW_NON_PR !== "1") {
  failures.push(`${ENUMS_PATH} changed outside a pull_request event.`);
}

const diff = unifiedDiff();
if (!hasSchemaVersionBump(diff)) {
  failures.push("schema_version was not bumped in a source contract file.");
}

const body = process.env.VEGA_CONTRACT_GUARD_PR_BODY ?? "";
if (!hasFilledSection(body, ["Reviewer dialogue", "Reviewer dialog", "Reviewer 对话"])) {
  failures.push("PR body is missing a filled Reviewer dialogue section.");
}

if (
  !hasFilledSection(body, [
    "Downstream compatibility report",
    "Downstream compatibility",
    "下游兼容性汇报"
  ])
) {
  failures.push("PR body is missing a filled Downstream compatibility report section.");
}

if (failures.length > 0) {
  fail(failures);
}

console.log("Contract enum guard: canonical enum change has PR review evidence and schema_version bump.");
