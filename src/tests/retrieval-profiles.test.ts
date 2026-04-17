import assert from "node:assert/strict";
import test from "node:test";

import type { Intent } from "../core/contracts/enums.js";
import {
  BOOTSTRAP_PROFILE,
  EVIDENCE_PROFILE,
  FOLLOWUP_PROFILE,
  LOOKUP_PROFILE,
  getProfile
} from "../retrieval/profiles.js";

test("exports all four intent profiles with matching intents", () => {
  assert.equal(BOOTSTRAP_PROFILE.intent, "bootstrap");
  assert.equal(LOOKUP_PROFILE.intent, "lookup");
  assert.equal(FOLLOWUP_PROFILE.intent, "followup");
  assert.equal(EVIDENCE_PROFILE.intent, "evidence");
});

test("bootstrap profile excludes candidate source", () => {
  const profile = getProfile("bootstrap");

  assert.equal(profile.default_sources.includes("candidate"), false);
});

test("no profile advertises host_memory_file while the adapter remains a stub", () => {
  for (const profile of [BOOTSTRAP_PROFILE, LOOKUP_PROFILE, FOLLOWUP_PROFILE, EVIDENCE_PROFILE]) {
    assert.equal(profile.default_sources.includes("host_memory_file"), false);
  }
});

test("followup profile includes candidate source", () => {
  const profile = getProfile("followup");

  assert.equal(profile.default_sources.includes("candidate"), true);
});

test("getProfile throws on unknown intent", () => {
  assert.throws(() => getProfile("unknown" as Intent), /Unknown intent profile/u);
});
