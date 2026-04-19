import type { Sufficiency, Surface } from "../core/contracts/enums.js";
import type { VegaMetricsRegistry } from "../monitoring/vega-metrics.js";

export type CircuitBreakerTripReason = "low_ack_rate" | "high_followup_rate";
export type CircuitBreakerState = "closed" | "open" | "cooldown";

export interface SurfaceBreakerStatus {
  surface: Surface;
  state: CircuitBreakerState;
  tripped_at: number | null;
  reasons: CircuitBreakerTripReason[];
  consecutive_healthy_samples: number;
  window_checkpoint_count: number;
  window_ack_count: number;
  window_sufficient_ack_count: number;
  window_needs_followup_ack_count: number;
}

export interface CircuitBreakerConfig {
  window_ms?: number;
  cooldown_ms?: number;
  min_ack_rate?: number;
  max_followup_rate?: number;
  min_checkpoint_count?: number;
  min_ack_count?: number;
  healthy_close_count?: number;
  now?: () => number;
  budget_reduction_factor?: number;
  metrics?: VegaMetricsRegistry;
}

export interface CircuitBreaker {
  recordCheckpoint(surface: Surface): void;
  recordAck(surface: Surface, sufficiency: Sufficiency): void;
  getStatus(surface: Surface): SurfaceBreakerStatus;
  listAllStatuses(): SurfaceBreakerStatus[];
  reset(surface: Surface): void;
  readonly budget_reduction_factor: number;
}

interface WindowSample {
  type: "checkpoint" | "ack";
  sufficiency?: Sufficiency;
  timestamp: number;
}

interface SurfaceState {
  state: CircuitBreakerState;
  tripped_at: number | null;
  reasons: CircuitBreakerTripReason[];
  consecutive_healthy_samples: number;
  samples: WindowSample[];
  head_index: number;
  window_checkpoint_count: number;
  window_ack_count: number;
  window_sufficient_ack_count: number;
  window_needs_followup_ack_count: number;
}

interface ResolvedCircuitBreakerConfig {
  window_ms: number;
  cooldown_ms: number;
  min_ack_rate: number;
  max_followup_rate: number;
  min_checkpoint_count: number;
  min_ack_count: number;
  healthy_close_count: number;
  budget_reduction_factor: number;
  now: () => number;
}

const DEFAULT_WINDOW_MS = 3_600_000;
const DEFAULT_COOLDOWN_MS = 600_000;
const DEFAULT_MIN_ACK_RATE = 0.5;
const DEFAULT_MAX_FOLLOWUP_RATE = 0.3;
const DEFAULT_MIN_CHECKPOINT_COUNT = 20;
const DEFAULT_MIN_ACK_COUNT = 10;
const DEFAULT_HEALTHY_CLOSE_COUNT = 5;
const DEFAULT_BUDGET_REDUCTION_FACTOR = 0.5;

const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;
const isRate = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

function resolveNumberFromEnv(
  envName: string,
  validator: (value: number) => boolean,
  fallback: number
): number {
  const parsed = Number.parseFloat(process.env[envName] ?? "");
  return validator(parsed) ? parsed : fallback;
}

function resolveInteger(
  explicit: number | undefined,
  envName: string,
  fallback: number
): number {
  if (explicit !== undefined && isPositiveInteger(explicit)) {
    return explicit;
  }

  return resolveNumberFromEnv(envName, isPositiveInteger, fallback);
}

function resolveRate(
  explicit: number | undefined,
  envName: string,
  fallback: number
): number {
  if (explicit !== undefined && isRate(explicit)) {
    return explicit;
  }

  return resolveNumberFromEnv(envName, isRate, fallback);
}

function resolveConfig(config: CircuitBreakerConfig = {}): ResolvedCircuitBreakerConfig {
  return {
    window_ms: resolveInteger(config.window_ms, "VEGA_CIRCUIT_BREAKER_WINDOW_MS", DEFAULT_WINDOW_MS),
    cooldown_ms: resolveInteger(config.cooldown_ms, "VEGA_CIRCUIT_BREAKER_COOLDOWN_MS", DEFAULT_COOLDOWN_MS),
    min_ack_rate: resolveRate(config.min_ack_rate, "VEGA_CIRCUIT_BREAKER_MIN_ACK_RATE", DEFAULT_MIN_ACK_RATE),
    max_followup_rate: resolveRate(
      config.max_followup_rate,
      "VEGA_CIRCUIT_BREAKER_MAX_FOLLOWUP_RATE",
      DEFAULT_MAX_FOLLOWUP_RATE
    ),
    min_checkpoint_count: resolveInteger(
      config.min_checkpoint_count,
      "VEGA_CIRCUIT_BREAKER_MIN_CHECKPOINTS",
      DEFAULT_MIN_CHECKPOINT_COUNT
    ),
    min_ack_count: resolveInteger(config.min_ack_count, "VEGA_CIRCUIT_BREAKER_MIN_ACKS", DEFAULT_MIN_ACK_COUNT),
    healthy_close_count: resolveInteger(
      config.healthy_close_count,
      "VEGA_CIRCUIT_BREAKER_HEALTHY_CLOSE",
      DEFAULT_HEALTHY_CLOSE_COUNT
    ),
    budget_reduction_factor: resolveRate(
      config.budget_reduction_factor,
      "VEGA_CIRCUIT_BREAKER_BUDGET_REDUCTION",
      DEFAULT_BUDGET_REDUCTION_FACTOR
    ),
    now: config.now ?? Date.now
  };
}

function createDefaultSurfaceState(): SurfaceState {
  return {
    state: "closed",
    tripped_at: null,
    reasons: [],
    consecutive_healthy_samples: 0,
    samples: [],
    head_index: 0,
    window_checkpoint_count: 0,
    window_ack_count: 0,
    window_sufficient_ack_count: 0,
    window_needs_followup_ack_count: 0
  };
}

function getCounters(
  entry: SurfaceState
): Omit<SurfaceBreakerStatus, "surface" | "state" | "tripped_at" | "reasons" | "consecutive_healthy_samples"> {
  return {
    window_checkpoint_count: entry.window_checkpoint_count,
    window_ack_count: entry.window_ack_count,
    window_sufficient_ack_count: entry.window_sufficient_ack_count,
    window_needs_followup_ack_count: entry.window_needs_followup_ack_count
  };
}

function addSample(entry: SurfaceState, sample: WindowSample): void {
  entry.samples.push(sample);

  if (sample.type === "checkpoint") {
    entry.window_checkpoint_count += 1;
    return;
  }

  entry.window_ack_count += 1;

  if (sample.sufficiency === "needs_followup") {
    entry.window_needs_followup_ack_count += 1;
    return;
  }

  entry.window_sufficient_ack_count += 1;
}

function maybeCompactSamples(entry: SurfaceState): void {
  if (entry.head_index === 0 || entry.head_index < entry.samples.length / 2) {
    return;
  }

  entry.samples = entry.samples.slice(entry.head_index);
  entry.head_index = 0;
}

function pruneWindow(entry: SurfaceState, minTimestamp: number): void {
  while (
    entry.head_index < entry.samples.length &&
    entry.samples[entry.head_index]!.timestamp < minTimestamp
  ) {
    const expired = entry.samples[entry.head_index]!;

    if (expired.type === "checkpoint") {
      entry.window_checkpoint_count -= 1;
    } else {
      entry.window_ack_count -= 1;

      if (expired.sufficiency === "needs_followup") {
        entry.window_needs_followup_ack_count -= 1;
      } else {
        entry.window_sufficient_ack_count -= 1;
      }
    }

    entry.head_index += 1;
  }

  maybeCompactSamples(entry);
}

function closeSurfaceState(entry: SurfaceState, clearSamples = false): boolean {
  const changed = entry.state !== "closed";
  entry.state = "closed";
  entry.tripped_at = null;
  entry.reasons = [];
  entry.consecutive_healthy_samples = 0;
  if (clearSamples) {
    entry.samples = [];
    entry.head_index = 0;
    entry.window_checkpoint_count = 0;
    entry.window_ack_count = 0;
    entry.window_sufficient_ack_count = 0;
    entry.window_needs_followup_ack_count = 0;
  }

  return changed;
}

function maybeAdvanceToCooldown(
  entry: SurfaceState,
  config: ResolvedCircuitBreakerConfig,
  now: number
): boolean {
  if (
    entry.state === "open" &&
    entry.tripped_at !== null &&
    now - entry.tripped_at >= config.cooldown_ms
  ) {
    entry.state = "cooldown";
    return true;
  }

  return false;
}

function maybeTripSurface(
  entry: SurfaceState,
  counters: ReturnType<typeof getCounters>,
  config: ResolvedCircuitBreakerConfig,
  now: number
): CircuitBreakerTripReason[] {
  if (entry.state !== "closed") {
    return [];
  }

  const reasons: CircuitBreakerTripReason[] = [];
  const ackRate =
    counters.window_checkpoint_count === 0
      ? 1
      : counters.window_ack_count / counters.window_checkpoint_count;
  const followupRate =
    counters.window_ack_count === 0
      ? 0
      : counters.window_needs_followup_ack_count / counters.window_ack_count;

  if (
    counters.window_checkpoint_count >= config.min_checkpoint_count &&
    ackRate < config.min_ack_rate
  ) {
    reasons.push("low_ack_rate");
  }

  if (
    counters.window_ack_count >= config.min_ack_count &&
    followupRate > config.max_followup_rate
  ) {
    reasons.push("high_followup_rate");
  }

  if (reasons.length === 0) {
    return reasons;
  }

  entry.state = "open";
  entry.tripped_at = now;
  entry.reasons = reasons;
  entry.consecutive_healthy_samples = 0;
  return reasons;
}

function maybeCloseFromCooldown(
  entry: SurfaceState,
  sufficiency: Sufficiency,
  config: ResolvedCircuitBreakerConfig
): boolean {
  if (entry.state !== "cooldown") {
    return false;
  }

  if (sufficiency === "needs_followup") {
    entry.consecutive_healthy_samples = 0;
    return false;
  }

  entry.consecutive_healthy_samples += 1;

  if (entry.consecutive_healthy_samples >= config.healthy_close_count) {
    return closeSurfaceState(entry, true);
  }

  return false;
}

export function createCircuitBreaker(config: CircuitBreakerConfig = {}): CircuitBreaker {
  const resolved = resolveConfig(config);
  const surfaces = new Map<Surface, SurfaceState>();
  const metrics = config.metrics;

  const getOrCreateEntry = (surface: Surface): SurfaceState => {
    const existing = surfaces.get(surface);
    if (existing !== undefined) {
      return existing;
    }

    const created = createDefaultSurfaceState();
    surfaces.set(surface, created);
    metrics?.setCircuitState(surface, created.state);
    return created;
  };

  const syncEntry = (surface: Surface, now = resolved.now()): SurfaceState => {
    const entry = getOrCreateEntry(surface);
    pruneWindow(entry, now - resolved.window_ms);
    if (maybeAdvanceToCooldown(entry, resolved, now)) {
      metrics?.setCircuitState(surface, entry.state);
    }
    return entry;
  };

  const toStatus = (surface: Surface, entry: SurfaceState): SurfaceBreakerStatus => {
    const counters = getCounters(entry);

    if (entry.state === "closed") {
      const reasons = maybeTripSurface(entry, counters, resolved, resolved.now());
      if (reasons.length > 0) {
        metrics?.setCircuitState(surface, entry.state);
        for (const reason of reasons) {
          metrics?.recordCircuitTrip(surface, reason);
        }
      }
    }

    return {
      surface,
      state: entry.state,
      tripped_at: entry.tripped_at,
      reasons: [...entry.reasons],
      consecutive_healthy_samples: entry.consecutive_healthy_samples,
      ...counters
    };
  };

  return {
    budget_reduction_factor: resolved.budget_reduction_factor,
    recordCheckpoint(surface: Surface): void {
      const now = resolved.now();
      const entry = syncEntry(surface, now);
      addSample(entry, {
        type: "checkpoint",
        timestamp: now
      });
    },
    recordAck(surface: Surface, sufficiency: Sufficiency): void {
      const now = resolved.now();
      const entry = syncEntry(surface, now);
      addSample(entry, {
        type: "ack",
        sufficiency,
        timestamp: now
      });
      if (maybeAdvanceToCooldown(entry, resolved, now)) {
        metrics?.setCircuitState(surface, entry.state);
      }
      if (maybeCloseFromCooldown(entry, sufficiency, resolved)) {
        metrics?.setCircuitState(surface, entry.state);
      }
    },
    getStatus(surface: Surface): SurfaceBreakerStatus {
      return toStatus(surface, syncEntry(surface));
    },
    listAllStatuses(): SurfaceBreakerStatus[] {
      const now = resolved.now();
      return [...surfaces.entries()].map(([surface]) => toStatus(surface, syncEntry(surface, now)));
    },
    reset(surface: Surface): void {
      const entry = getOrCreateEntry(surface);
      const changed = closeSurfaceState(entry, true);
      if (changed) {
        metrics?.setCircuitState(surface, entry.state);
      }
    }
  };
}
