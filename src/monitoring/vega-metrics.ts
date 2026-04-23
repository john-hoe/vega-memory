import type { DatabaseAdapter, PreparedStatement } from "../db/adapter.js";
import {
  HOST_TIERS,
  RETRIEVAL_INTENTS,
  SUFFICIENCY,
  SURFACES,
  type HostTier,
  type RetrievalIntent,
  type Sufficiency,
  type Surface
} from "../core/contracts/enums.js";
import {
  CIRCUIT_BREAKER_STATES,
  CIRCUIT_BREAKER_TRIP_REASONS,
  type CircuitBreakerState,
  type CircuitBreakerTripReason
} from "../retrieval/circuit-breaker.js";

import type { CounterMetric, GaugeMetric, MetricsCollector } from "./metrics.js";

// Label dictionary:
// - surface values must reuse SURFACES from src/core/contracts/enums.ts
// - retrieval intent values stay aligned with src/retrieval/profiles.ts
// - sufficiency / host_tier values stay aligned with src/core/contracts/usage-ack.ts
//
// Known limitations — 必须原样写进代码注释 + commit message body
//
// 1. intent 不在 `usage_acks` 表：ack-handler 可从 `previousCheckpoint` 内存查找拿到 intent，但 checkpoint 过期 / lookup 失败时无法还原。本批次 `vega_usage_ack_*` 系列不带 intent label，避免部分 series 缺失造成 dashboard 误导。intent 下沉到 usage_acks 留给未来独立任务。
//
// 2. trace_id 不是端到端：orchestrator 内部 `createTraceId()` 只在 `context.resolve` 单次调用生命周期内存活，没有随 envelope 跨 ingest → ack 传播。本批次不把 trace_id 作为 metric label（高基数风险 + 无法跨请求关联）。后续独立任务处理。
//
// 3. `replay_lag` 留位不填：现阶段只发两个 scrape-time gauge（`vega_raw_inbox_rows` + `vega_raw_inbox_oldest_age_seconds`）作为"有没有积压"的粗信号。真正的 replay 延迟直方图依赖 P8-032 Reconciliation pipeline 建立；不要在本批次先发空 histogram（占位会误导）。
//
// 4. circuit breaker 状态非持久化：`CircuitBreaker` 是 in-memory per-instance；`vega_circuit_breaker_state` gauge 仅反映当前 process 视角，重启后从 closed 重启。本批次不改持久化；gauge HELP 文本必须明写 "per-process, resets on restart"。
//
// 5. retrieval intent vs action 严格分层：`intent` label 仅用于 retrieval 系列 metric，值域 `RETRIEVAL_INTENTS`（bootstrap/lookup/followup/evidence）。usage/ingest/circuit 系列 不得引入 intent label —— 它们是"ack 动作"或"状态变更"而非检索意图。跨类别 correlation 通过 checkpoint_id（非 metric label）实现。
//
// 6. sufficiency_fp_rate 仅为 proxy：dashboard 上展示的 "sufficiency_fp_rate (proxy)" 来自 `vega_usage_followup_loop_override_total` / `vega_usage_ack_total{sufficiency="needs_followup"}`。底层 metric 刻意不叫 fp_rate，避免与真 FP 指标混淆。HELP 文本明写 "proxy signal for sufficiency false-positive, derived from loop guard override"。
//
// 7. raw_inbox gauge 按 event_type 分组是为了 drill-down：总积压 / 最大年龄这两个 Wave 5 首发面板一律在 dashboard 侧用 sum() / max() 聚合，不在 metric 层再开一份无 label 版本。`raw_inbox_backlog_total` / `raw_inbox_oldest_age_max` 是 Batch 10b 的 Grafana 面板标题，不是 metric family 名字；本批次严禁以此命名注册任何新 counter / gauge。 如果未来发现 scrape-time 聚合成本过高才考虑预聚合，本批次不预先做。
export { HOST_TIERS, RETRIEVAL_INTENTS, SUFFICIENCY } from "../core/contracts/enums.js";

const UNKNOWN_LABEL = "unknown";

type SufficiencyLabel = Sufficiency;
type HostTierLabel = HostTier;
type UsageFallbackTargetLabel = "local_workspace" | "external" | "none";
type FeedbackUsageAckTypeLabel = "accepted" | "rejected" | "reranked";

export interface VegaMetricsRegistry {
  recordRetrievalCall(surface: Surface, intent: RetrievalIntent): void;
  recordRetrievalNonempty(surface: Surface, intent: RetrievalIntent): void;
  recordRetrievalObservability(
    surface: Surface,
    intent: RetrievalIntent,
    metrics: {
      token_efficiency: number;
      source_utilization: number;
      bundle_coverage: number;
    }
  ): void;
  recordUsageAck(surface: Surface, sufficiency: SufficiencyLabel, host_tier: HostTierLabel): void;
  recordUsageCheckpointSubmitted(decision_state: SufficiencyLabel): void;
  recordUsageCheckpointRejected(reason: string): void;
  recordUsageCheckpointLowConfidence(decision_state: SufficiencyLabel): void;
  recordUsageFallbackTarget(target: UsageFallbackTargetLabel): void;
  recordUsageFallbackViolation(reason: string): void;
  recordUsageFeedbackAck(ack_type: FeedbackUsageAckTypeLabel): void;
  recordUsageFeedbackAckRejected(reason: string): void;
  recordLoopOverride(surface: Surface): void;
  recordMissingTrigger(surface: Surface | "unknown"): void;
  recordSkippedBundle(surface: Surface | "unknown"): void;
  recordRepeatedFollowupInflation(surface: Surface): void;
  setCircuitState(surface: Surface, state: CircuitBreakerState): void;
  recordCircuitTrip(surface: Surface, reason: CircuitBreakerTripReason): void;
}

interface RawInboxCountRow {
  event_type: string;
  row_count: number;
}

interface RawInboxAgeRow {
  event_type: string;
  oldest_age_seconds: number;
}

const CIRCUIT_BREAKER_STATE_VALUES: Record<(typeof CIRCUIT_BREAKER_STATES)[number], number> = {
  closed: 0,
  open: 1,
  cooldown: 2
};
const USAGE_FALLBACK_TARGETS = ["local_workspace", "external", "none"] as const;
const FEEDBACK_USAGE_ACK_TYPES = ["accepted", "rejected", "reranked"] as const;

const isKnownValue = <T extends string>(value: string, allowed: readonly T[]): value is T =>
  allowed.includes(value as T);

const coerceKnownValue = <T extends string>(value: string, allowed: readonly T[]): T | "unknown" =>
  isKnownValue(value, allowed) ? value : UNKNOWN_LABEL;

const coerceSurface = (surface: string): Surface | "unknown" =>
  coerceKnownValue(surface, SURFACES);

const coerceIntent = (intent: string): RetrievalIntent | "unknown" =>
  coerceKnownValue(intent, RETRIEVAL_INTENTS);

const coerceSufficiency = (sufficiency: string): SufficiencyLabel | "unknown" =>
  coerceKnownValue(sufficiency, SUFFICIENCY);

const coerceHostTier = (host_tier: string): HostTierLabel | "unknown" =>
  coerceKnownValue(host_tier, HOST_TIERS);

const coerceFallbackTarget = (target: string): UsageFallbackTargetLabel | "unknown" =>
  coerceKnownValue(target, USAGE_FALLBACK_TARGETS);

const coerceFeedbackAckType = (ack_type: string): FeedbackUsageAckTypeLabel | "unknown" =>
  coerceKnownValue(ack_type, FEEDBACK_USAGE_ACK_TYPES);

const coerceTripReason = (reason: string): CircuitBreakerTripReason | "unknown" =>
  coerceKnownValue(reason, CIRCUIT_BREAKER_TRIP_REASONS);

const coerceCircuitStateValue = (state: string): number =>
  isKnownValue(state, CIRCUIT_BREAKER_STATES) ? CIRCUIT_BREAKER_STATE_VALUES[state] : 0;

const setGroupedGaugeValues = <T extends { event_type: string }>(
  gauge: GaugeMetric,
  rows: T[],
  resolveValue: (row: T) => number
): void => {
  gauge.reset();

  for (const row of rows) {
    gauge.set(resolveValue(row), {
      event_type: row.event_type
    });
  }
};

export function createVegaMetrics(
  collector: MetricsCollector,
  db: DatabaseAdapter
): VegaMetricsRegistry {
  const retrievalCalls = collector.counter(
    "retrieval_calls_total",
    "Triggered at retrieval orchestrator context.resolve entry; per-process counter incremented once per resolve attempt, including error paths.",
    ["surface", "intent"]
  );
  const retrievalNonempty = collector.counter(
    "retrieval_nonempty_total",
    "Counts context.resolve calls that returned a non-empty retrieval bundle (error bundles excluded). Per-process counter.",
    ["surface", "intent"]
  );
  const retrievalTokenEfficiency = collector.gauge(
    "retrieval_token_efficiency_ratio",
    "Latest per-surface, per-intent retrieval token efficiency proxy: bundle token estimate divided by raw retrieved token estimate.",
    ["surface", "intent"]
  );
  const retrievalSourceUtilization = collector.gauge(
    "retrieval_source_utilization_ratio",
    "Latest per-surface, per-intent source utilization ratio: used_sources divided by queried source count for the resolve attempt.",
    ["surface", "intent"]
  );
  const retrievalBundleCoverage = collector.gauge(
    "retrieval_bundle_coverage_ratio",
    "Latest per-surface, per-intent bundle coverage proxy: budgeted record count divided by expected top_k for the resolve attempt.",
    ["surface", "intent"]
  );
  const usageAck = collector.counter(
    "usage_ack_total",
    "Counts first-time usage ack inserts. Per-process counter; intent is not labeled because usage_acks cannot reliably recover it.",
    ["surface", "sufficiency", "host_tier"]
  );
  const usageCheckpointSubmitted = collector.counter(
    "usage_checkpoint_submitted_total",
    "Counts semantically valid Phase 7 bundle consumption checkpoints by decision state. Per-process counter.",
    ["decision_state"]
  );
  const usageCheckpointRejected = collector.counter(
    "usage_checkpoint_rejected_total",
    "Counts rejected Phase 7 bundle consumption checkpoints by bounded rejection reason. Per-process counter.",
    ["reason"]
  );
  const usageCheckpointLowConfidence = collector.counter(
    "usage_checkpoint_low_confidence_total",
    "Counts accepted Phase 7 bundle consumption checkpoints that require low-confidence handling. Per-process counter.",
    ["decision_state"]
  );
  const usageFallbackTarget = collector.counter(
    "usage_fallback_target_total",
    "Counts Phase 7 fallback ladder plans by selected target. Per-process counter.",
    ["target"]
  );
  const usageFallbackViolation = collector.counter(
    "usage_fallback_violation_total",
    "Counts Phase 7 fallback ladder guard violations and degraded outcomes by reason. Per-process counter.",
    ["reason"]
  );
  const usageFeedbackAck = collector.counter(
    "usage_feedback_ack_total",
    "Counts first-time Phase 7 memory feedback acknowledgements by feedback type. Per-process counter.",
    ["ack_type"]
  );
  const usageFeedbackAckRejected = collector.counter(
    "usage_feedback_ack_rejected_total",
    "Counts rejected or degraded Phase 7 memory feedback acknowledgements by reason. Per-process counter.",
    ["reason"]
  );
  const usageLoopOverride = collector.counter(
    "usage_followup_loop_override_total",
    "Triggered at usage-ack-handler when loop guard overrideSucceeded === true; per-process counter, proxy signal for sufficiency false-positive, derived from loop guard override.",
    ["surface"]
  );
  const missingTrigger = collector.counter(
    "retrieval_missing_trigger_total",
    "Counts usage acknowledgements that arrive without a known retrieval checkpoint context; proxy signal for host-side missing retrieval trigger or broken lineage.",
    ["surface"]
  );
  const skippedBundle = collector.counter(
    "retrieval_skipped_bundle_total",
    "Counts bundle-digest mismatches on usage acknowledgements; proxy signal that the host did not consume the expected retrieval bundle.",
    ["surface"]
  );
  const repeatedFollowupInflation = collector.counter(
    "retrieval_followup_inflation_total",
    "Counts repeated followup resolves on an existing retrieval lineage (depth >= 1); proxy signal for repeated followup inflation.",
    ["surface"]
  );
  const circuitState = collector.gauge(
    "circuit_breaker_state",
    "Reports current per-surface circuit breaker state. Gauge values are 0=closed, 1=open, 2=cooldown; per-process, resets on restart.",
    ["surface"]
  );
  const circuitTrips = collector.counter(
    "circuit_breaker_trips_total",
    "Counts circuit breaker trips (breaker opening events); one increment per trip reason. Per-process counter.",
    ["surface", "reason"]
  );
  const rawInboxRows = collector.gauge(
    "raw_inbox_rows",
    "Scrape-time gauge from SELECT event_type, COUNT(*) AS row_count FROM raw_inbox GROUP BY event_type; reflects grouped raw inbox backlog.",
    ["event_type"]
  );
  const rawInboxOldestAge = collector.gauge(
    "raw_inbox_oldest_age_seconds",
    "Scrape-time gauge from SELECT event_type, (julianday('now') - julianday(MIN(received_at))) * 86400.0 AS oldest_age_seconds FROM raw_inbox GROUP BY event_type; temporary backlog age signal while replay_lag remains out of scope.",
    ["event_type"]
  );

  let rawInboxRowsStatement: PreparedStatement<[], RawInboxCountRow> | undefined;
  let rawInboxAgeStatement: PreparedStatement<[], RawInboxAgeRow> | undefined;

  const loadRawInboxRows = (): RawInboxCountRow[] => {
    if (db.isPostgres) {
      return [];
    }

    try {
      rawInboxRowsStatement ??= db.prepare<[], RawInboxCountRow>(
        "SELECT event_type, COUNT(*) AS row_count FROM raw_inbox GROUP BY event_type HAVING COUNT(*) > 0"
      );
      return rawInboxRowsStatement.all();
    } catch {
      return [];
    }
  };

  const loadRawInboxAges = (): RawInboxAgeRow[] => {
    if (db.isPostgres) {
      return [];
    }

    try {
      rawInboxAgeStatement ??= db.prepare<[], RawInboxAgeRow>(
        "SELECT event_type, (julianday('now') - julianday(MIN(received_at))) * 86400.0 AS oldest_age_seconds FROM raw_inbox GROUP BY event_type -- received_at is NOT NULL per raw_inbox schema; HAVING COUNT(*) > 0 is sufficient\nHAVING COUNT(*) > 0"
      );
      return rawInboxAgeStatement.all();
    } catch {
      return [];
    }
  };

  collector.registerGaugeCollector("raw_inbox_rows", () => {
    setGroupedGaugeValues(rawInboxRows, loadRawInboxRows(), (row) => row.row_count);
  });
  collector.registerGaugeCollector("raw_inbox_oldest_age_seconds", () => {
    setGroupedGaugeValues(rawInboxOldestAge, loadRawInboxAges(), (row) => row.oldest_age_seconds);
  });

  const incrementRetrievalMetric = (
    metric: CounterMetric,
    surface: string,
    intent: string
  ): void => {
    metric.inc({
      surface: coerceSurface(surface),
      intent: coerceIntent(intent)
    });
  };

  return {
    recordRetrievalCall(surface, intent): void {
      incrementRetrievalMetric(retrievalCalls, surface, intent);
    },
    recordRetrievalNonempty(surface, intent): void {
      incrementRetrievalMetric(retrievalNonempty, surface, intent);
    },
    recordRetrievalObservability(surface, intent, metrics): void {
      const labels = {
        surface: coerceSurface(surface),
        intent: coerceIntent(intent)
      };
      retrievalTokenEfficiency.set(metrics.token_efficiency, labels);
      retrievalSourceUtilization.set(metrics.source_utilization, labels);
      retrievalBundleCoverage.set(metrics.bundle_coverage, labels);
    },
    recordUsageAck(surface, sufficiency, host_tier): void {
      usageAck.inc({
        surface: coerceSurface(surface),
        sufficiency: coerceSufficiency(sufficiency),
        host_tier: coerceHostTier(host_tier)
      });
    },
    recordUsageCheckpointSubmitted(decision_state): void {
      usageCheckpointSubmitted.inc({
        decision_state: coerceSufficiency(decision_state)
      });
    },
    recordUsageCheckpointRejected(reason): void {
      usageCheckpointRejected.inc({
        reason
      });
    },
    recordUsageCheckpointLowConfidence(decision_state): void {
      usageCheckpointLowConfidence.inc({
        decision_state: coerceSufficiency(decision_state)
      });
    },
    recordUsageFallbackTarget(target): void {
      usageFallbackTarget.inc({
        target: coerceFallbackTarget(target)
      });
    },
    recordUsageFallbackViolation(reason): void {
      usageFallbackViolation.inc({
        reason
      });
    },
    recordUsageFeedbackAck(ack_type): void {
      usageFeedbackAck.inc({
        ack_type: coerceFeedbackAckType(ack_type)
      });
    },
    recordUsageFeedbackAckRejected(reason): void {
      usageFeedbackAckRejected.inc({
        reason
      });
    },
    recordLoopOverride(surface): void {
      usageLoopOverride.inc({
        surface: coerceSurface(surface)
      });
    },
    recordMissingTrigger(surface): void {
      missingTrigger.inc({
        surface: coerceSurface(surface)
      });
    },
    recordSkippedBundle(surface): void {
      skippedBundle.inc({
        surface: coerceSurface(surface)
      });
    },
    recordRepeatedFollowupInflation(surface): void {
      repeatedFollowupInflation.inc({
        surface: coerceSurface(surface)
      });
    },
    setCircuitState(surface, state): void {
      circuitState.set(coerceCircuitStateValue(state), {
        surface: coerceSurface(surface)
      });
    },
    recordCircuitTrip(surface, reason): void {
      circuitTrips.inc({
        surface: coerceSurface(surface),
        reason: coerceTripReason(reason)
      });
    }
  };
}
