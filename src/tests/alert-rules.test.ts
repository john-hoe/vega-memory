import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadAlertRules } from "../alert/rules.js";

const createTempDir = (): string => mkdtempSync(join(tmpdir(), "vega-alert-rules-"));

test("loadAlertRules parses valid rules and inline channels", () => {
  const tempDir = createTempDir();
  const filePath = join(tempDir, "alert-rules.yaml");

  writeFileSync(
    filePath,
    `rules:
  - id: retrieval_coverage_low
    severity: warn
    metric: vega_retrieval_nonempty_ratio
    operator: "<"
    threshold: 0.5
    window_ms: 300000
    min_duration_ms: 900000
    channels: [default_webhook, secondary]
`,
    "utf8"
  );

  try {
    const rules = loadAlertRules(filePath);

    assert.equal(rules.length, 1);
    assert.deepEqual(rules[0], {
      id: "retrieval_coverage_low",
      severity: "warn",
      metric: "vega_retrieval_nonempty_ratio",
      operator: "<",
      threshold: 0.5,
      window_ms: 300000,
      min_duration_ms: 900000,
      channels: ["default_webhook", "secondary"]
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadAlertRules returns [] when the operator enum is invalid", () => {
  const tempDir = createTempDir();
  const filePath = join(tempDir, "alert-rules.yaml");

  writeFileSync(
    filePath,
    `rules:
  - id: invalid_operator
    severity: warn
    metric: vega_metric
    operator: "!="
    threshold: 2
    window_ms: 1000
    min_duration_ms: 0
    channels: [default_webhook]
`,
    "utf8"
  );

  try {
    assert.deepEqual(loadAlertRules(filePath), []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadAlertRules returns [] when the severity enum is invalid", () => {
  const tempDir = createTempDir();
  const filePath = join(tempDir, "alert-rules.yaml");

  writeFileSync(
    filePath,
    `rules:
  - id: invalid_severity
    severity: page
    metric: vega_metric
    operator: ">"
    threshold: 2
    window_ms: 1000
    min_duration_ms: 0
    channels: [default_webhook]
`,
    "utf8"
  );

  try {
    assert.deepEqual(loadAlertRules(filePath), []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadAlertRules returns [] when the file is missing", () => {
  const tempDir = createTempDir();

  try {
    assert.deepEqual(loadAlertRules(join(tempDir, "missing.yaml")), []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadAlertRules applies threshold overrides from the supplied map", () => {
  const tempDir = createTempDir();
  const filePath = join(tempDir, "alert-rules.yaml");

  writeFileSync(
    filePath,
    `rules:
  - id: raw_inbox_backlog_high
    severity: warn
    metric: vega_raw_inbox_rows
    operator: ">"
    threshold: 10000
    window_ms: 300000
    min_duration_ms: 300000
    channels: [default_webhook]
`,
    "utf8"
  );

  try {
    const rules = loadAlertRules(filePath, {
      VEGA_ALERT_RULE_RAW_INBOX_BACKLOG_HIGH_THRESHOLD: "250"
    });

    assert.equal(rules[0]?.threshold, 250);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
