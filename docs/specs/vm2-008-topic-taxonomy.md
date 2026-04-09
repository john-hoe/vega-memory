# VM2-008 Topic Taxonomy

Status: proposed design spec  
Scope: lightweight topic and room taxonomy, inference policy, explicit override rules, recall fallback  
Non-goals: implement MemPalace wing/hall/tunnel navigation, rework `memories` as a taxonomy store, or require topic assignment for successful store/recall

## 1. Goal

VM2-008 defines a lightweight semantic classification layer on top of the existing VM2-002 sidecar tables:

1. infer a coarse `topic` and optional finer `room` when a new memory is stored
2. let users override the assignment without rewriting the original memory row
3. preserve hot-memory availability when inference fails
4. let `recall` optionally narrow by topic, but transparently fall back to tags and FTS when topic filtering yields nothing

This task intentionally keeps the taxonomy small. It uses only `topic` and `room` plus versioned sidecar rows in `topics` and `memory_topics`.

## 2. Confirmed Baseline

The current implementation already fixes these boundaries:

- `topics` and `memory_topics` exist in `src/db/schema.ts` and are version-aware sidecar tables.
- `Topic` and `MemoryTopic` already exist in `src/core/types.ts`.
- `MemoryService.store()` in `src/core/memory.ts` stores the hot memory row, derives lexical `tags`, generates embeddings and summaries, and does not currently write topic sidecars.
- `RecallService.recall()` in `src/core/recall.ts` delegates to `SearchEngine` with `SearchOptions` that currently only know `project`, `type`, `tenant_id`, `limit`, and `minSimilarity`.
- `SearchEngine` and repository search helpers in `src/search/engine.ts` and `src/db/repository.ts` currently search active memories through vector similarity and SQLite FTS only.
- VM2-002 defines topics as a sidecar semantic layer and explicitly keeps `memories` as the hot-path source of truth.

Implication: VM2-008 must keep topic handling additive. A missing topic must never block memory creation or hot recall.

## 3. Taxonomy Model

### 3.1 Kinds

`topics.kind` keeps two values only:

- `topic`: coarse project theme such as `database`, `auth`, `deployment`
- `room`: finer subdivision under a topic such as `database.migration`, `database.indexing`

### 3.2 Key shape

`topic_key` is the canonical machine key.

Rules:

- keys are lowercase and dot-delimited
- a top-level topic has no dot, for example `database`
- a room uses the parent topic as prefix, for example `database.migration`
- only one parent depth is required in VM2-008; deeper trees are out of scope

Derived rules:

- `kind = topic` when `topic_key` has no dot
- `kind = room` when `topic_key` contains one dot and the prefix is a valid topic key
- a room implicitly belongs to its prefix topic; no separate parent column is added in this task

### 3.3 Labels

`label` is a human display name derived from the key or provided explicitly.

Examples:

- `database` -> `Database`
- `database.migration` -> `Database / Migration`

VM2-008 does not require a separate localization system.

## 4. Automatic Topic Generation

### 4.1 Trigger point

When `MemoryService.store()` successfully creates or updates a memory, the topic pipeline runs after the hot memory row is durable.

Reasoning:

- hot memory stays the primary write path
- topic inference is a best-effort sidecar step
- failures do not roll back the memory write

### 4.2 Primary path: Ollama inference

The primary inference path uses Ollama with these inputs:

- `content`
- lexical `tags`
- `project`

Expected output:

- one coarse `topic_key`
- optionally one finer `room` key under that topic
- optional classifier confidence in `0..1`

Normalization rules:

- normalize whitespace and punctuation
- convert keys to lowercase dot notation
- reject keys that do not conform to the allowed shape
- if Ollama emits only a room, derive and persist its prefix topic as well

Stored metadata:

- generated topic rows use `source = auto`
- generated memory-topic assignments use `source = auto`
- assignment confidence may be stored in `memory_topics.confidence`

### 4.3 Secondary path: tag rule fallback

If Ollama is unavailable or returns unusable output, inference falls back to deterministic tag rules.

Rule shape:

- exact tag match to known topic keys, for example `database` -> `database`
- synonym table, for example `db` -> `database`, `login` -> `auth`
- prefix mapping for room keys when tags are specific enough, for example `migration` + `database` -> `database.migration`

Properties:

- rules are project-local in effect, even if implemented through shared code
- rule output still uses `source = auto`
- rule output may omit confidence or assign a conservative value such as `0.4`

### 4.4 Failure behavior

If both inference paths fail:

- the memory is still stored normally
- no `memory_topics` row is written
- no topic row is created as a placeholder

This is required behavior, not a degraded error case.

## 5. Topic Versioning and Uniqueness

Within a single project, `topic_key` is the logical identity and `version` tracks semantic change.

Rules:

- the active meaning of a key is the row with the highest active `version`
- `(tenant_id, project, topic_key, version)` remains unique as already enforced in `schema.ts`
- a semantic edit creates a new row with `version + 1`
- the older row moves to `state = superseded`
- `supersedes_topic_id` points to the row being replaced

Examples:

- renaming display text `Database` -> `Data Storage` for the same key requires a new version if the meaning changes materially
- cosmetic fixes with no semantic change may update metadata in place only before external assignment use; once assignments exist, prefer versioning over silent mutation

## 6. Explicit Override Rules

Users may explicitly assign or replace a memory's topic via CLI or MCP tools.

### 6.1 Priority

Explicit assignment always outranks automatic assignment.

Rules:

- explicit rows use `source = explicit`
- existing active auto assignments for that memory move to `status = superseded`
- the new explicit assignment becomes the only active assignment for the memory unless a future multi-topic mode is deliberately added

### 6.2 Topic row behavior

If the target `topic_key` already exists as an active topic in the project:

- reuse the active topic row when the user is only reclassifying a memory

If the user is redefining the meaning or label of the target topic:

- create a new topic version
- mark the old version `superseded`

### 6.3 Assignment version behavior

`memory_topics` is append-only in identity but stateful in lifecycle.

Rules:

- old active assignments for the memory move to `status = superseded`
- the new assignment row is inserted as `status = active`
- confidence is optional for explicit assignments and may remain `null`

## 7. Recall Integration

### 7.1 Request shape

`recall` accepts an optional topic filter.

Defaults:

- string shorthand such as `"topic": "database"` means `include_rooms = true` for top-level keys and `fallback_to_tags = true`
- object form may disable either behavior explicitly
- topic resolution is project-scoped; if `project` is omitted, topic narrowing cannot be resolved and recall should transparently fall back to the normal path when fallback is enabled

Canonical request examples:

```json
{
  "query": "migration rollback steps",
  "project": "vega-memory",
  "topic": "database"
}
```

```json
{
  "query": "index rebuild",
  "project": "vega-memory",
  "topic": {
    "topic_key": "database.indexing",
    "include_rooms": false,
    "fallback_to_tags": true
  }
}
```

### 7.2 Search order

When `topic` is present:

1. resolve the requested topic key in the current project
2. build a candidate memory set from active `memory_topics`
3. run the existing hybrid vector + FTS search only inside that candidate set

When `include_rooms = true` and the requested key is a top-level topic:

- include memories assigned to the topic itself
- include memories assigned to room keys with that topic prefix

When `topic` is absent:

- current recall behavior remains unchanged

### 7.3 Transparent fallback

If topic resolution or topic-scoped search yields no results:

1. retry the existing recall path without topic narrowing
2. allow lexical tags and FTS to recover relevant results
3. mark returned results with `fallback = true`

Fallback triggers:

- requested topic key does not exist
- topic exists but has no active assignments
- topic-scoped hybrid search returns zero results

Non-trigger:

- topic-scoped search returns at least one result; do not mix fallback and scoped results in the same response

## 8. Store-Path Integration

`memory_store` remains successful even when topic work fails.

Recommended sequence:

1. store hot memory row
2. derive lexical tags as today
3. attempt topic inference
4. if inference succeeds, upsert topic rows and create memory-topic assignment
5. if inference fails, return the normal store result with no topic assignment

This keeps VM2-002's hot-path boundary intact.

## 9. MCP and API Surface

### 9.1 `memory_store`

Add optional `topic` to allow explicit classification at write time.

Canonical extension:

```json
{
  "content": "Use WAL checkpoint before backup.",
  "type": "pitfall",
  "project": "vega-memory",
  "tags": ["sqlite", "backup"],
  "topic": "database.backup"
}
```

Behavior:

- if `topic` is provided, treat it as an explicit assignment
- if `topic` is omitted, run normal auto inference after store
- if explicit topic assignment fails validation, fail only the topic assignment branch when possible; do not lose the stored memory unless the request explicitly demands strict topic enforcement

### 9.2 `memory_recall`

Add optional `topic` filter.

Canonical extension:

```json
{
  "query": "backup restore",
  "project": "vega-memory",
  "topic": "database"
}
```

Response addition:

- every returned item may include `fallback: true` when the system had to bypass topic narrowing

### 9.3 `topic_list`

Purpose: list active topic taxonomy rows for a project.

Transport:

- expose as both an MCP tool and a CLI command, for example `vega topic list --project <name>`

Canonical request:

```json
{
  "project": "vega-memory"
}
```

Canonical response item:

```json
{
  "topic_key": "database.migration",
  "label": "Database / Migration",
  "kind": "room",
  "version": 2,
  "source": "explicit",
  "state": "active"
}
```

### 9.4 `topic_override`

Purpose: replace a memory's active topic assignment with an explicit one.

Transport:

- expose as both an MCP tool and a CLI command, for example `vega topic override --memory-id <id> --topic <topic_key>`

Canonical request:

```json
{
  "memory_id": "memory-id",
  "project": "vega-memory",
  "topic": "database.indexing"
}
```

Canonical behavior:

- supersede active auto assignment rows for the memory
- reuse or create the target active topic version
- create a new explicit assignment row

## 10. Compatibility and Non-Goals

Compatibility rules:

- `memories.tags` remain lexical
- topics stay sidecars and never become required fields on `Memory`
- no migration is needed for `topics` and `memory_topics` in this task because the tables already exist
- no MemPalace wing/hall/tunnel hierarchy is introduced

Non-goals for VM2-008:

- multi-label topic assignment
- hierarchical navigation deeper than `topic.room`
- mandatory topic assignment on store
- replacing vector or FTS retrieval with taxonomy-only search

## 11. Implementation Notes for Follow-Up Work

Recommended follow-up slices:

1. repository helpers for active topic lookup and memory-topic assignment lifecycle
2. `TopicService` inference and override implementation
3. `MemoryService.store()` post-write integration
4. `RecallService` topic narrowing and fallback propagation
5. CLI and MCP transport updates

This staging keeps the hot-memory path safe while the taxonomy layer matures.
