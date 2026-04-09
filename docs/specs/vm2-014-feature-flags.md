# VM2-014 Feature Flags And Phased Rollout

Status: accepted rollout spec  
Scope: VM2 sidecar gating, phased enablement, rollback triggers for raw archive, deep recall, topic recall, and future fact claims  
Non-goals: ship fact-claim runtime extraction, redefine regression thresholds, or make hot-memory/session_start depend on any VM2 sidecar

## 1. Goal

VM2-014 defines how VM2 sidecars are exposed behind configuration flags so the legacy hot-memory path can run independently and operators can quickly roll back when recall quality or token cost regresses.

The rollout model is:

- sidecar tables stay additive
- runtime behavior is gated by feature flags
- rollout happens phase by phase
- rollback is a flag flip, not a schema rollback

## 2. Feature Flags

`src/config.ts` exposes the canonical VM2 rollout flags, each overrideable through environment variables:

| Env var | Config field | Default | Purpose |
| --- | --- | --- | --- |
| `VEGA_FEATURE_FACT_CLAIMS` | `features.factClaims` | `false` | Reserve the fact-claims runtime lane until extraction/query logic is ready |
| `VEGA_FEATURE_RAW_ARCHIVE` | `features.rawArchive` | `true` | Control cold-archive sidecar writes from the hot-memory pipeline |
| `VEGA_FEATURE_TOPIC_RECALL` | `features.topicRecall` | `false` | Control topic-aware narrowing and fallback behavior in recall |
| `VEGA_FEATURE_DEEP_RECALL` | `features.deepRecall` | `true` | Control the public `deep_recall` API/MCP endpoint |

Rules:

- `deep_recall` is available only when both `rawArchive` and `deepRecall` are enabled.
- Disabling `rawArchive` stops new cold-archive writes immediately.
- Disabling `topicRecall` forces recall back to the pre-VM2 hybrid search path.
- Disabling `factClaims` must keep all runtime paths on hot memory until phase C logic exists.

## 3. Runtime Contract

### 3.1 Hot path independence

When all VM2 flags are off:

- `session_start` continues to read only hot-memory and wiki state
- `recall` ignores topic filters and does not touch `topics` or `memory_topics`
- memory store/update skips raw-archive capture
- `deep_recall` returns `501` over HTTP and an MCP tool error payload

This is the compatibility bar for “VM2 disabled”.

### 3.2 Flag-off behavior

Disabled features must short-circuit cleanly:

- no sidecar-table query on disabled paths
- no background sidecar write on disabled paths
- no best-effort fallback that still touches the disabled subsystem
- no startup/session error caused by missing or stale sidecar tables

## 4. Phased Rollout

### Phase A: `raw_archive` + `deep_recall`

Status:

- implemented
- enabled by default

Scope:

- cold raw archive capture
- `deep_recall` retrieval over HTTP and MCP

Enter criteria:

- `session_start_token_estimate.latest <= max_session_start_token`
- `recall_latency_ms.p95 <= max_recall_latency_ms`
- `recall_avg_similarity.average >= min_recall_avg_similarity`
- `top_k_inflation_ratio.average <= max_top_k_inflation_ratio`
- targeted raw archive + `deep_recall` regression tests pass

Exit / rollback criteria:

- `deep_recall` returns invalid evidence or wrong tenant/project scope
- recall/token regressions appear after enabling archive capture
- regression guard reports any sustained warning attributable to phase A

Rollback action:

- set `VEGA_FEATURE_DEEP_RECALL=false` to remove the public read path
- set `VEGA_FEATURE_RAW_ARCHIVE=false` to stop new cold-archive writes

### Phase B: `topic_recall`

Status:

- code implemented
- disabled by default pending more confidence

Scope:

- topic-aware candidate narrowing
- transparent fallback to baseline hybrid search

Enter criteria:

- no regression-guard violations in the latest rollout window
- topic recall regression tests pass with flag on and off
- fallback behavior is verified when topic sidecars are empty or unavailable

Exit / rollback criteria:

- recall latency exceeds `max_recall_latency_ms`
- average similarity drops below `min_recall_avg_similarity`
- top-k inflation exceeds `max_top_k_inflation_ratio`
- topic sidecars cause false negatives or empty-result regressions

Rollback action:

- set `VEGA_FEATURE_TOPIC_RECALL=false`
- recall immediately returns to pre-VM2 hybrid search semantics

### Phase C: `fact_claims`

Status:

- schema and types exist
- runtime logic not yet implemented
- disabled by default

Scope:

- future fact extraction, as-of query, and verification workflows

Enter criteria:

- dedicated runtime logic lands behind the flag
- claim extraction/query regressions are covered by tests
- session and recall stay independent of fact-claim tables unless explicitly enabled

Exit / rollback criteria:

- any hot-path dependency on `fact_claims`
- regression-guard or correctness failures in fact-backed queries

Rollback action:

- set `VEGA_FEATURE_FACT_CLAIMS=false`
- keep fact-claim tables as passive sidecars only

## 5. Operational Guidance

Recommended rollout order:

1. Leave phase A enabled in lower environments and verify `deep_recall` evidence quality.
2. Turn on `topicRecall` for targeted tenants/projects only after regression metrics stay clean.
3. Keep `factClaims` off until a separate runtime implementation task lands.

Recommended rollback order for recall regressions:

1. disable `topicRecall`
2. disable `deepRecall` if evidence pull quality is implicated
3. disable `rawArchive` if new cold writes are part of the regression

This order restores the old hot-memory mainline without requiring schema changes or data deletion.
