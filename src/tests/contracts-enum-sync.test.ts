import assert from "node:assert";
import test from "node:test";

import { HOST_TIERS, RETRIEVAL_INTENTS, SUFFICIENCY } from "../core/contracts/enums.js";

test("vega-metrics re-exports match canonical contract enums", async () => {
  const metricsModule = await import("../monitoring/vega-metrics.js");

  assert.deepEqual([...metricsModule.RETRIEVAL_INTENTS], [...RETRIEVAL_INTENTS]);
  assert.deepEqual([...metricsModule.SUFFICIENCY], [...SUFFICIENCY]);
  assert.deepEqual([...metricsModule.HOST_TIERS], [...HOST_TIERS]);
});
