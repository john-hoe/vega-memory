# VM2-003 Fact Verification

Status: accepted design spec  
Scope: fact claim verification metadata, temporal precision policy, as-of semantics  
Non-goals: implement runtime verification workflows, change hot memory/session_start behavior, or rework knowledge-graph extraction

## 1. Goal

VM2-003 defines how `fact_claims` rows express trust, provenance, temporal scope, and lifecycle without pretending to know more than the evidence supports.

This spec exists to solve one concrete problem left open by VM2-002: `valid_from` and `valid_to` can look exact even when the source evidence is only approximate. VM2-003 adds explicit precision metadata and verification rules so fact claims remain queryable without creating false certainty.

## 2. Confirmed Baseline

The current system already fixes these boundaries:

- VM2-001 keeps `session_start` and `recall` on hot memory. `deep_recall` remains the future cold-evidence path.
- VM2-002 makes `fact_claims`, `raw_archives`, and `topics` sidecars. They do not replace `memories`.
- `SessionService.sessionStart()` currently reads `memories` plus wiki side data only.
- `KnowledgeGraphService` still extracts entities and relations directly from hot memory content. VM2-003 does not reroute KG extraction through `fact_claims`.
- `fact_claims` already exists in `schema.ts` with `valid_from`, `valid_to`, `confidence`, `source`, and `status`.

Implication: VM2-003 is a metadata and query-semantics spec. It does not change the hot path and does not add runtime extraction logic in this task.

## 3. Confidence Model

`confidence` expresses how strongly the system can stand behind the normalized claim row, not how important the claim is.

| Band | Meaning | Typical origin | Promotion rule |
| --- | --- | --- | --- |
| `1.0` | user verified | user created/confirmed the exact normalized fact | only explicit user action may set `1.0` |
| `0.7-0.9` | explicit store | claim derived from content the user intentionally stored | system may initialize here, but may not promote into or within this band after creation |
| `0.4-0.6` | auto extracted | LLM extracted claim from session summary or compressed memory | system default for extraction |
| `0.1-0.3` | inferred | claim inferred from related memories or weak correlation | system default for inference |

Rules:

- Automatic processes may assign an initial confidence band.
- Automatic processes may preserve or lower confidence.
- Automatic processes must never raise confidence.
- Any confidence increase requires explicit user action such as create, confirm, resolve conflict, or confirm still-valid.
- `source = mixed` does not itself justify a confidence increase. Richer provenance and higher certainty are separate concepts.

Recommended canonical values for initial writes:

- `1.0` for user-verified/manual confirmation
- `0.8` for explicit-store derivation
- `0.5` for auto extraction
- `0.2` for inference

## 4. Source and Traceability

`source` records the provenance lane for the current normalized claim row.

| `source` | Meaning | Required provenance |
| --- | --- | --- |
| `hot_memory` | derived from a memory row | `source_memory_id` must be set |
| `raw_archive` | derived from original archived evidence | `evidence_archive_id` must be set |
| `manual` | user-authored or user-normalized claim | at least one provenance pointer must still be set |
| `mixed` | cross-checked between hot memory and raw evidence | both `source_memory_id` and `evidence_archive_id` should be set |

Traceability rules:

- VM2-002's invariant stays in force: a claim row must retain at least one provenance pointer.
- `source_memory_id` is the hot-memory anchor for the claim.
- `evidence_archive_id` is the cold-evidence anchor for the claim.
- `mixed` is conservative in VM2-003: it means the row is anchored to both a hot-memory record and a raw-archive record. This task does not add multi-evidence side tables.
- `manual` does not mean "source-free". If a user creates a claim from a note, transcript, or explicit memory, the row still records the matching pointer.
- If future UX wants truly free-form manual claims, it must first create an explicit provenance row elsewhere. VM2-003 does not relax the schema invariant.

## 5. Status State Machine

`status` describes the current lifecycle state of the claim row. It is not a second confidence field.

States:

- `active`: best-known claim for the slot
- `suspected_expired`: likely stale, but not yet user-confirmed as ended
- `conflict`: contradicts another claim in the same logical slot
- `expired`: no longer in force

Legal transitions:

| From | To | Allowed actor | Trigger |
| --- | --- | --- | --- |
| `active` | `expired` | `system` or `user` | explicit end evidence, explicit replacement, or user retirement |
| `active` | `suspected_expired` | `system` or `user` | heuristic staleness or likely replacement without enough proof to close the interval |
| `active` | `conflict` | `system` or `user` | contradictory claim detected |
| `suspected_expired` | `active` | `user` | user confirms claim is still valid |
| `suspected_expired` | `expired` | `user` | user confirms claim has ended |
| `conflict` | `active` | `user` | user resolves conflict in favor of this claim |
| `conflict` | `expired` | `user` | user discards this claim |

State graph:

```text
active
  -> expired
  -> suspected_expired
  -> conflict

suspected_expired
  -> active
  -> expired

conflict
  -> active
  -> expired

expired
  -> terminal
```

Rules:

- `expired` is terminal in VM2-003.
- Automatic staleness must prefer `suspected_expired` over `expired` when there is no explicit end evidence.
- `conflict` is for contradiction, not uncertainty. Low-confidence but unchallenged claims stay `active`.
- A replacement claim should move the old claim directly to `expired` only when the replacement provides enough evidence to close the old interval. Otherwise the old claim becomes `suspected_expired`.

## 6. Anti-False-Precision Policy

### 6.1 `temporal_precision`

Add `temporal_precision` to every `fact_claims` row:

- `exact`
- `day`
- `week`
- `month`
- `quarter`
- `unknown`

`temporal_precision` stores the coarsest precision used to normalize any non-null temporal bound on the row. This is intentionally conservative because VM2-003 adds one field, not separate precision metadata per bound.

Examples:

| Evidence | Stored bound | `temporal_precision` |
| --- | --- | --- |
| `2026-04-09T15:32:10Z` | exact timestamp | `exact` |
| `2026-04-09` | `2026-04-09T00:00:00.000Z` | `day` |
| `week of 2026-04-06` | `2026-04-06T00:00:00.000Z` | `week` |
| `April 2026` | `2026-04-01T00:00:00.000Z` | `month` |
| `Q2 2026` | `2026-04-01T00:00:00.000Z` | `quarter` |

### 6.2 Bound normalization

Rules for `valid_from`:

- `valid_from` is the earliest supported lower bound, not a claim that the real-world fact began at that exact second.
- If evidence is only month-level, store the first instant of the month.
- If evidence is only quarter-level, store the first instant of the quarter.
- `valid_from` must not keep second-level precision unless the source evidence includes an exact timestamp.

Rules for `valid_to`:

- `valid_to` is exclusive.
- If the end is unknown, store `null`.
- Never invent a fake deadline just because the current extraction happened on a certain day.
- If an end is approximate, normalize to the next bucket boundary so the half-open interval remains correct.

Examples:

- "started in April 2026" -> `valid_from = 2026-04-01T00:00:00.000Z`, `valid_to = null`, `temporal_precision = month`
- "ended sometime in April 2026" -> `valid_to = 2026-05-01T00:00:00.000Z`, `temporal_precision = month`
- "still active as of the source" -> `valid_to = null`

Rules for `unknown`:

- Use `unknown` only when the row has a required lower bound from source capture time or row creation time, but the evidence does not justify any stronger bucket claim.
- Callers must treat `unknown` as a weak temporal bound and should avoid presenting it as a user-facing exact onset date.

## 7. `as_of` Query Semantics

Canonical default query:

```sql
status = 'active'
AND valid_from <= :as_of
AND (valid_to IS NULL OR :as_of < valid_to)
```

Semantics:

- `valid_from` is inclusive.
- `valid_to` is exclusive.
- `valid_to = null` means the claim is still open-ended.
- Default `as_of` returns only rows whose current `status` is `active`.

Type shape:

```ts
interface AsOfQueryOptions {
  as_of: string;
  project?: string;
  include_suspected_expired?: boolean;
  include_conflicts?: boolean;
}
```

Behavior for `suspected_expired`:

- Default `as_of` excludes `suspected_expired`.
- `include_suspected_expired = true` widens the status filter to include `suspected_expired` rows that still overlap the requested timestamp.
- Returned `suspected_expired` rows must be surfaced as uncertain, never as the default best-known truth.

Behavior for `conflict`:

- Default `as_of` excludes `conflict`.
- `include_conflicts = true` is for audit/debug tooling only.

Important limitation:

- VM2-003 is not bitemporal. `status` is the row's current lifecycle state.
- If a claim is marked `suspected_expired` today, default `as_of` no longer returns it even for an earlier timestamp.
- Historical "what did the system believe on date X?" requires future event-history support and is out of scope here.

## 8. Session Integration

VM2-003 does not change `SessionService.sessionStart()`.

Integration rules:

- `fact_claims` remain outside the default `session_start` bundle.
- `expired`, `suspected_expired`, and `conflict` claims must not enter session context by default.
- If a future preload or warning path summarizes fact claims, it must only consider `status = active` claims and must preserve their confidence/provenance metadata.
- `deep_recall` and future `as_of` helpers are the primary access paths for verified fact history.

## 9. Schema Delta

VM2-003 adds one column to `fact_claims`:

```sql
temporal_precision TEXT NOT NULL
  CHECK(temporal_precision IN ('exact', 'day', 'week', 'month', 'quarter', 'unknown'))
  DEFAULT 'unknown'
```

This is a sidecar metadata extension only. No hot-memory table changes are required.
