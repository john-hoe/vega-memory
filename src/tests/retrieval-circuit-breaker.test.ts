import assert from "node:assert/strict";
import test from "node:test";

import type { Surface, Sufficiency } from "../core/contracts/enums.js";
import {
  createCircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerTripReason
} from "../retrieval/circuit-breaker.js";

function createControlledBreaker(
  overrides: CircuitBreakerConfig = {}
): {
  breaker: ReturnType<typeof createCircuitBreaker>;
  advance(ms: number): void;
  set(now: number): void;
} {
  let now = 0;
  const breaker = createCircuitBreaker({
    now: () => now,
    ...overrides
  });

  return {
    breaker,
    advance(ms: number) {
      now += ms;
    },
    set(value: number) {
      now = value;
    }
  };
}

function recordCheckpoints(
  breaker: ReturnType<typeof createCircuitBreaker>,
  surface: Surface,
  count: number
): void {
  for (let index = 0; index < count; index += 1) {
    breaker.recordCheckpoint(surface);
  }
}

function recordAcks(
  breaker: ReturnType<typeof createCircuitBreaker>,
  surface: Surface,
  sufficiency: Sufficiency,
  count: number
): void {
  for (let index = 0; index < count; index += 1) {
    breaker.recordAck(surface, sufficiency);
  }
}

function assertReasons(
  actual: CircuitBreakerTripReason[],
  expected: CircuitBreakerTripReason[]
): void {
  assert.deepEqual(actual, expected);
}

test("default status is closed with zero counters", () => {
  const { breaker } = createControlledBreaker();

  assert.deepEqual(breaker.getStatus("codex"), {
    surface: "codex",
    state: "closed",
    tripped_at: null,
    reasons: [],
    consecutive_healthy_samples: 0,
    window_checkpoint_count: 0,
    window_ack_count: 0,
    window_sufficient_ack_count: 0,
    window_needs_followup_ack_count: 0
  });
});

test("checkpoint count below threshold does not trip low ack rate", () => {
  const { breaker } = createControlledBreaker();

  recordCheckpoints(breaker, "codex", 19);

  assert.equal(breaker.getStatus("codex").state, "closed");
});

test("low ack rate trips with a single low_ack_rate reason", () => {
  const { breaker } = createControlledBreaker();

  recordCheckpoints(breaker, "codex", 20);

  const status = breaker.getStatus("codex");
  assert.equal(status.state, "open");
  assertReasons(status.reasons, ["low_ack_rate"]);
  assert.equal(status.window_checkpoint_count, 20);
  assert.equal(status.window_ack_count, 0);
});

test("healthy ack rate keeps the breaker closed", () => {
  const { breaker } = createControlledBreaker();

  recordCheckpoints(breaker, "codex", 20);
  recordAcks(breaker, "codex", "sufficient", 15);

  const status = breaker.getStatus("codex");
  assert.equal(status.state, "closed");
  assert.equal(status.window_ack_count, 15);
  assert.equal(status.window_sufficient_ack_count, 15);
});

test("high followup rate trips with a single high_followup_rate reason", () => {
  const { breaker } = createControlledBreaker();

  recordCheckpoints(breaker, "codex", 20);
  recordAcks(breaker, "codex", "needs_followup", 10);
  recordAcks(breaker, "codex", "sufficient", 2);

  const status = breaker.getStatus("codex");
  assert.equal(status.state, "open");
  assertReasons(status.reasons, ["high_followup_rate"]);
});

test("dual threshold breach reports both reasons in stable order", () => {
  const { breaker } = createControlledBreaker();

  recordCheckpoints(breaker, "codex", 21);
  recordAcks(breaker, "codex", "needs_followup", 8);
  recordAcks(breaker, "codex", "sufficient", 1);
  recordAcks(breaker, "codex", "needs_external", 1);

  const status = breaker.getStatus("codex");
  assert.equal(status.state, "open");
  assertReasons(status.reasons, ["low_ack_rate", "high_followup_rate"]);
});

test("open breaker moves to cooldown after the cooldown interval", () => {
  const { breaker, advance } = createControlledBreaker();

  recordCheckpoints(breaker, "codex", 20);
  assert.equal(breaker.getStatus("codex").state, "open");
  advance(600_000);

  const status = breaker.getStatus("codex");
  assert.equal(status.state, "cooldown");
  assertReasons(status.reasons, ["low_ack_rate"]);
});

test("cooldown closes after consecutive healthy acknowledgements", () => {
  const { breaker, advance } = createControlledBreaker();

  recordCheckpoints(breaker, "codex", 20);
  assert.equal(breaker.getStatus("codex").state, "open");
  advance(600_000);
  assert.equal(breaker.getStatus("codex").state, "cooldown");
  recordAcks(breaker, "codex", "sufficient", 5);

  const status = breaker.getStatus("codex");
  assert.equal(status.state, "closed");
  assertReasons(status.reasons, []);
  assert.equal(status.tripped_at, null);
  assert.equal(status.consecutive_healthy_samples, 0);
});

test("cooldown healthy counter is consecutive and resets on needs_followup", () => {
  const { breaker, advance } = createControlledBreaker();

  recordCheckpoints(breaker, "codex", 20);
  assert.equal(breaker.getStatus("codex").state, "open");
  advance(600_000);
  assert.equal(breaker.getStatus("codex").state, "cooldown");
  recordAcks(breaker, "codex", "sufficient", 4);
  assert.equal(breaker.getStatus("codex").consecutive_healthy_samples, 4);
  breaker.recordAck("codex", "needs_followup");
  assert.equal(breaker.getStatus("codex").consecutive_healthy_samples, 0);
  recordAcks(breaker, "codex", "needs_external", 5);

  const status = breaker.getStatus("codex");
  assert.equal(status.state, "closed");
  assert.equal(status.consecutive_healthy_samples, 0);
});

test("cooldown keeps tracking partial healthy progress", () => {
  const { breaker, advance } = createControlledBreaker();

  recordCheckpoints(breaker, "codex", 20);
  assert.equal(breaker.getStatus("codex").state, "open");
  advance(600_000);
  assert.equal(breaker.getStatus("codex").state, "cooldown");
  recordAcks(breaker, "codex", "sufficient", 3);

  const status = breaker.getStatus("codex");
  assert.equal(status.state, "cooldown");
  assert.equal(status.consecutive_healthy_samples, 3);
});

test("window samples expire after the rolling window", () => {
  const { breaker, set } = createControlledBreaker({
    window_ms: 60_000
  });

  breaker.recordCheckpoint("codex");
  breaker.recordAck("codex", "sufficient");
  set(60_001);

  const status = breaker.getStatus("codex");
  assert.equal(status.window_checkpoint_count, 0);
  assert.equal(status.window_ack_count, 0);
});

test("window pruning drops expired samples while preserving retained counters", () => {
  const { breaker, set, advance } = createControlledBreaker({
    window_ms: 60_000
  });

  recordCheckpoints(breaker, "codex", 10_000);
  recordAcks(breaker, "codex", "needs_followup", 8);
  set(60_001);

  breaker.recordCheckpoint("codex");
  advance(1);
  breaker.recordCheckpoint("codex");
  advance(1);
  breaker.recordAck("codex", "sufficient");
  advance(1);
  breaker.recordAck("codex", "needs_external");
  advance(1);
  breaker.recordAck("codex", "needs_followup");

  const status = breaker.getStatus("codex");
  assert.equal(status.window_checkpoint_count, 2);
  assert.equal(status.window_ack_count, 3);
  assert.equal(status.window_sufficient_ack_count, 2);
  assert.equal(status.window_needs_followup_ack_count, 1);
});

test("reset clears state, reasons, and counters", () => {
  const { breaker } = createControlledBreaker();

  recordCheckpoints(breaker, "codex", 20);
  breaker.reset("codex");

  assert.deepEqual(breaker.getStatus("codex"), {
    surface: "codex",
    state: "closed",
    tripped_at: null,
    reasons: [],
    consecutive_healthy_samples: 0,
    window_checkpoint_count: 0,
    window_ack_count: 0,
    window_sufficient_ack_count: 0,
    window_needs_followup_ack_count: 0
  });
});

test("different surfaces are isolated", () => {
  const { breaker } = createControlledBreaker();

  recordCheckpoints(breaker, "claude", 20);

  assert.equal(breaker.getStatus("claude").state, "open");
  assert.equal(breaker.getStatus("codex").state, "closed");
});

test("listAllStatuses returns tracked surfaces", () => {
  const { breaker } = createControlledBreaker();

  recordCheckpoints(breaker, "claude", 1);
  recordCheckpoints(breaker, "codex", 1);

  assert.deepEqual(
    breaker.listAllStatuses().map((status) => status.surface),
    ["claude", "codex"]
  );
});

test("env configuration overrides default thresholds and timings", () => {
  const originalWindow = process.env.VEGA_CIRCUIT_BREAKER_WINDOW_MS;
  const originalCooldown = process.env.VEGA_CIRCUIT_BREAKER_COOLDOWN_MS;
  const originalMinAckRate = process.env.VEGA_CIRCUIT_BREAKER_MIN_ACK_RATE;
  const originalReduction = process.env.VEGA_CIRCUIT_BREAKER_BUDGET_REDUCTION;

  process.env.VEGA_CIRCUIT_BREAKER_WINDOW_MS = "60000";
  process.env.VEGA_CIRCUIT_BREAKER_COOLDOWN_MS = "120000";
  process.env.VEGA_CIRCUIT_BREAKER_MIN_ACK_RATE = "0.8";
  process.env.VEGA_CIRCUIT_BREAKER_BUDGET_REDUCTION = "0.25";

  try {
    const { breaker } = createControlledBreaker();
    recordCheckpoints(breaker, "codex", 20);
    recordAcks(breaker, "codex", "sufficient", 15);

    const status = breaker.getStatus("codex");
    assert.equal(status.state, "open");
    assertReasons(status.reasons, ["low_ack_rate"]);
    assert.equal(breaker.budget_reduction_factor, 0.25);
  } finally {
    restoreEnv("VEGA_CIRCUIT_BREAKER_WINDOW_MS", originalWindow);
    restoreEnv("VEGA_CIRCUIT_BREAKER_COOLDOWN_MS", originalCooldown);
    restoreEnv("VEGA_CIRCUIT_BREAKER_MIN_ACK_RATE", originalMinAckRate);
    restoreEnv("VEGA_CIRCUIT_BREAKER_BUDGET_REDUCTION", originalReduction);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
