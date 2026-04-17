import assert from "node:assert/strict";
import test from "node:test";

import { LOOKUP_PROFILE } from "../retrieval/profiles.js";
import {
  SUFFICIENCY_CLASSIFIER_VERSION,
  classifySufficiency
} from "../retrieval/sufficiency-classifier.js";

test("classifySufficiency marks empty bundles as may_need_followup", () => {
  const result = classifySufficiency({
    profile: LOOKUP_PROFILE,
    budgeted_count: 0,
    truncated_count: 0
  });

  assert.equal(result.hint, "may_need_followup");
  assert.deepEqual(result.rules_fired, ["empty"]);
});

test("classifySufficiency marks truncation even when top_k is satisfied", () => {
  const result = classifySufficiency({
    profile: LOOKUP_PROFILE,
    budgeted_count: LOOKUP_PROFILE.default_top_k,
    truncated_count: 2
  });

  assert.equal(result.hint, "may_need_followup");
  assert.deepEqual(result.rules_fired, ["truncated"]);
});

test("classifySufficiency marks bundles below top_k", () => {
  const result = classifySufficiency({
    profile: LOOKUP_PROFILE,
    budgeted_count: 1,
    truncated_count: 0
  });

  assert.equal(result.hint, "may_need_followup");
  assert.deepEqual(result.rules_fired, ["below_top_k"]);
});

test("classifySufficiency suppresses below_top_k when the bundle is empty", () => {
  const result = classifySufficiency({
    profile: LOOKUP_PROFILE,
    budgeted_count: 0,
    truncated_count: 5
  });

  assert.equal(result.hint, "may_need_followup");
  assert.deepEqual(result.rules_fired, ["empty", "truncated"]);
});

test("classifySufficiency marks fully satisfied bundles as likely_sufficient", () => {
  const result = classifySufficiency({
    profile: LOOKUP_PROFILE,
    budgeted_count: LOOKUP_PROFILE.default_top_k,
    truncated_count: 0
  });

  assert.equal(result.hint, "likely_sufficient");
  assert.deepEqual(result.rules_fired, []);
});

test("classifySufficiency reports classifier version v0", () => {
  const result = classifySufficiency({
    profile: LOOKUP_PROFILE,
    budgeted_count: LOOKUP_PROFILE.default_top_k,
    truncated_count: 0
  });

  assert.equal(result.classifier_version, SUFFICIENCY_CLASSIFIER_VERSION);
  assert.equal(result.classifier_version, "v0");
});
