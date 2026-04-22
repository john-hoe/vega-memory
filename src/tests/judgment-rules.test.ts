import assert from "node:assert/strict";
import test from "node:test";

import {
  createJudgmentRules,
  mergeJudgmentRules,
  DEFAULT_JUDGMENT_RULES
} from "../promotion/judgment-rules.js";

test("default judgment rules have expected values", () => {
  assert.equal(DEFAULT_JUDGMENT_RULES.name, "default");
  assert.equal(DEFAULT_JUDGMENT_RULES.version, "v1");
  assert.equal(DEFAULT_JUDGMENT_RULES.rules.age_threshold_ms, 7 * 24 * 60 * 60 * 1_000);
  assert.equal(DEFAULT_JUDGMENT_RULES.rules.min_sufficient_acks, 3);
  assert.equal(DEFAULT_JUDGMENT_RULES.rules.min_distinct_sessions, 2);
});

test("createJudgmentRules returns defaults when no overrides provided", () => {
  const rules = createJudgmentRules();
  assert.equal(rules.rules.age_threshold_ms, DEFAULT_JUDGMENT_RULES.rules.age_threshold_ms);
  assert.equal(rules.rules.min_sufficient_acks, DEFAULT_JUDGMENT_RULES.rules.min_sufficient_acks);
  assert.equal(rules.rules.min_distinct_sessions, DEFAULT_JUDGMENT_RULES.rules.min_distinct_sessions);
});

test("createJudgmentRules allows overriding age_threshold_ms", () => {
  const rules = createJudgmentRules({ rules: { age_threshold_ms: 1_000 } });
  assert.equal(rules.rules.age_threshold_ms, 1_000);
  assert.equal(rules.rules.min_sufficient_acks, DEFAULT_JUDGMENT_RULES.rules.min_sufficient_acks);
  assert.equal(rules.rules.min_distinct_sessions, DEFAULT_JUDGMENT_RULES.rules.min_distinct_sessions);
});

test("createJudgmentRules allows overriding min_sufficient_acks", () => {
  const rules = createJudgmentRules({ rules: { min_sufficient_acks: 5 } });
  assert.equal(rules.rules.age_threshold_ms, DEFAULT_JUDGMENT_RULES.rules.age_threshold_ms);
  assert.equal(rules.rules.min_sufficient_acks, 5);
  assert.equal(rules.rules.min_distinct_sessions, DEFAULT_JUDGMENT_RULES.rules.min_distinct_sessions);
});

test("createJudgmentRules allows overriding min_distinct_sessions", () => {
  const rules = createJudgmentRules({ rules: { min_distinct_sessions: 1 } });
  assert.equal(rules.rules.age_threshold_ms, DEFAULT_JUDGMENT_RULES.rules.age_threshold_ms);
  assert.equal(rules.rules.min_sufficient_acks, DEFAULT_JUDGMENT_RULES.rules.min_sufficient_acks);
  assert.equal(rules.rules.min_distinct_sessions, 1);
});

test("createJudgmentRules allows overriding all values at once", () => {
  const rules = createJudgmentRules({
    rules: {
      age_threshold_ms: 42,
      min_sufficient_acks: 99,
      min_distinct_sessions: 77
    }
  });
  assert.equal(rules.rules.age_threshold_ms, 42);
  assert.equal(rules.rules.min_sufficient_acks, 99);
  assert.equal(rules.rules.min_distinct_sessions, 77);
});

test("createJudgmentRules allows overriding name and version", () => {
  const rules = createJudgmentRules({ name: "strict", version: "v2" });
  assert.equal(rules.name, "strict");
  assert.equal(rules.version, "v2");
  assert.equal(rules.rules.age_threshold_ms, DEFAULT_JUDGMENT_RULES.rules.age_threshold_ms);
});

test("mergeJudgmentRules applies overrides on top of a base rule set", () => {
  const base = createJudgmentRules({ name: "base", version: "v1", rules: { age_threshold_ms: 5_000 } });
  const merged = mergeJudgmentRules(base, { rules: { min_sufficient_acks: 10 } });
  assert.equal(merged.name, "base");
  assert.equal(merged.version, "v1");
  assert.equal(merged.rules.age_threshold_ms, 5_000);
  assert.equal(merged.rules.min_sufficient_acks, 10);
  assert.equal(merged.rules.min_distinct_sessions, DEFAULT_JUDGMENT_RULES.rules.min_distinct_sessions);
});

test("mergeJudgmentRules can override name and version too", () => {
  const base = createJudgmentRules({ name: "base", version: "v1" });
  const merged = mergeJudgmentRules(base, { name: "override", version: "v9" });
  assert.equal(merged.name, "override");
  assert.equal(merged.version, "v9");
});
