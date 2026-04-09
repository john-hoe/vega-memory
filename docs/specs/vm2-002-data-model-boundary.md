# VM2-002 Data Model Boundary

Status: accepted design spec  
Scope: four-layer memory boundary, sidecar schema, migration contract  
Non-goals: rewrite the current hot memory read/write path, change the VM2-001 protocol, or backfill existing data in this task

## 1. Goal

VM2-002 defines a strict storage boundary between four layers:

1. hot memory for bounded working context
2. fact claims for time-bounded assertions
3. raw archive for original text and evidence
4. topics for lightweight semantic classification

The core rule is unchanged from the current codebase: `memories` remains the hot-path source for `session_start`, `recall`, `compact`, and the knowledge graph. New structures are sidecars. They must not turn `memories` into a multi-role table.

## 2. Confirmed Current Baseline

The existing implementation establishes these constraints:

- `MemoryService.store()` redacts content, generates summaries and embeddings, dedupes by similarity, and writes only `memories` rows on the hot path.
- `SessionService.sessionStart()` reads `memories` plus wiki side data. It does not read any other memory-adjacent table.
- `CompactService.compact()` merges and archives `memories` directly through repository updates.
- `KnowledgeGraphService` already proves the sidecar pattern: `entities` and `relations` derive from memories but do not redefine the `Memory` row shape.
- VM2-001 fixed the recall contract: `session_start` is preload, `recall` is hot retrieval, `deep_recall` is reserved for cold/original evidence, and `session_end` remains closeout.

Implication: VM2-002 must preserve the current `memories` table and the current `SessionStartResult` / hot recall semantics. Cold evidence and topic classification are additive.

## 3. Four-Layer Model

### Layer 1: Hot Memory

- Table: existing `memories`
- Purpose: compressed, structured working memory for routine coding turns
- Included types: `task_state`, `preference`, `project_context`, `decision`, `pitfall`, `insight`
- Default injection: yes, via `session_start`
- Source of truth: bounded and summarized working memory
- Mutation rule: may be merged, archived, summarized, re-embedded, and deduped by current services

### Layer 2: Fact Claims

- Table: new `fact_claims`
- Purpose: explicit time-bounded assertions extracted from hot memory or backed by raw evidence
- Default injection: no
- Primary access path: future `deep_recall`, future as-of query helpers, and audit/debug workflows
- Source of truth: a claim row plus its validity interval and status
- Mutation rule: claim expiry or conflict is represented by updating claim metadata, not by rewriting hot memory text

### Layer 3: Raw Archive

- Table: new `raw_archives`
- Purpose: cold storage for original transcripts, logs, debates, exports, and other long-form evidence
- Default injection: no
- Primary access path: future `deep_recall`
- Source of truth: immutable raw text identified by content hash
- Mutation rule: archive content is append-only / immutable after insert; later corrections create a new row

### Layer 4: Topics

- Tables: new `topics` and `memory_topics`
- Purpose: lightweight semantic grouping of memories into topic/room buckets
- Default injection: no
- Primary access path: recall shaping, later taxonomy views, and wiki synthesis alignment
- Source of truth: versioned topic records plus many-to-many assignments
- Mutation rule: semantic drift creates a new topic version; do not silently rename an existing meaning in place

## 4. Source-of-Truth Matrix

| Layer | Table(s) | Default `session_start` source | Default `recall` source | Future `deep_recall` source | Source of truth |
| --- | --- | --- | --- | --- | --- |
| Hot memory | `memories` | yes | yes | optional reference only | compressed working memory |
| Fact claims | `fact_claims` | no | no | yes | time-bounded assertions |
| Raw archive | `raw_archives` | no | no | yes | original text |
| Topics | `topics`, `memory_topics` | no | no | optional filter/expansion | semantic classification |

## 5. Table Design

### 5.1 `fact_claims`

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | primary key | UUID |
| `tenant_id` | `TEXT` | nullable | mirrors existing multi-tenant pattern |
| `project` | `TEXT` | not null | denormalized for project-scoped lookup |
| `source_memory_id` | `TEXT` | nullable FK -> `memories(id)` | the hot memory that produced or anchors the claim |
| `evidence_archive_id` | `TEXT` | nullable FK -> `raw_archives(id)` | optional cold evidence row |
| `canonical_key` | `TEXT` | not null | stable dedupe / conflict key, typically normalized `subject + predicate + value` |
| `subject` | `TEXT` | not null | left side of the assertion |
| `predicate` | `TEXT` | not null | relation or field name |
| `claim_value` | `TEXT` | not null | right side of the assertion |
| `claim_text` | `TEXT` | not null | readable original statement |
| `source` | `TEXT` | check in `('hot_memory','raw_archive','manual','mixed')` | provenance of the claim row |
| `status` | `TEXT` | check in `('active','expired','suspected_expired','conflict')` | claim lifecycle |
| `confidence` | `REAL` | `0 <= confidence <= 1` | extraction or review confidence |
| `valid_from` | `TEXT` | not null | inclusive ISO-8601 lower bound |
| `valid_to` | `TEXT` | nullable, `valid_to >= valid_from` | exclusive or open-ended upper bound |
| `invalidation_reason` | `TEXT` | nullable | why the claim stopped being reliable |
| `created_at` | `TEXT` | not null | row creation time |
| `updated_at` | `TEXT` | not null | last metadata/status update |

Required row rule:

- at least one provenance pointer must exist: `source_memory_id IS NOT NULL OR evidence_archive_id IS NOT NULL`

Status semantics:

- `active`: current best-known claim
- `expired`: explicitly ended and should not match default as-of lookups after `valid_to`
- `suspected_expired`: stale or likely outdated, but not yet proven false
- `conflict`: contradictory active claims share the same canonical subject/predicate slot

Default as-of filter:

```sql
status = 'active'
AND valid_from <= :as_of
AND (valid_to IS NULL OR valid_to > :as_of)
```

### 5.2 `raw_archives`

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | primary key | UUID |
| `tenant_id` | `TEXT` | nullable | tenant scoping |
| `project` | `TEXT` | not null | project lookup and deep recall narrowing |
| `source_memory_id` | `TEXT` | nullable FK -> `memories(id)` | optional link from hot memory back to raw origin |
| `archive_type` | `TEXT` | check in `('transcript','discussion','design_debate','chat_export','tool_log','document')` | bounded cold-source category |
| `title` | `TEXT` | not null | human-readable handle; synthesize if source lacks one |
| `source_uri` | `TEXT` | nullable | file path, export path, URL, conversation ID, or tool handle |
| `content` | `TEXT` | not null | original raw text |
| `content_hash` | `TEXT` | not null | normalized digest, expected to be SHA-256 hex |
| `metadata` | `TEXT` | not null default `'{}'` | JSON metadata blob for speaker map, tool name, import hints, etc. |
| `captured_at` | `TEXT` | nullable | when the underlying source text was produced/exported |
| `created_at` | `TEXT` | not null | archive row creation time |
| `updated_at` | `TEXT` | not null | metadata update time; should equal `created_at` when content is immutable |

Dedupe rule:

- dedupe on `(COALESCE(tenant_id, ''), content_hash)` so the same archive content is stored once per tenant/global scope

Compatibility note:

- `content_sources.raw_content` already exists as an ingestion-side raw blob store, but it is not the canonical memory cold archive for VM2-002. `raw_archives` is the memory-system sidecar that `deep_recall` will target.

### 5.3 `topics`

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| `id` | `TEXT` | primary key | UUID for a specific topic version |
| `tenant_id` | `TEXT` | nullable | tenant scoping |
| `project` | `TEXT` | not null | project-local taxonomy boundary |
| `topic_key` | `TEXT` | not null | stable logical key across versions |
| `version` | `INTEGER` | not null, `>= 1` | version number for the semantic meaning |
| `label` | `TEXT` | not null | display label |
| `kind` | `TEXT` | check in `('topic','room')` | lightweight taxonomy kind |
| `description` | `TEXT` | nullable | optional classifier guidance |
| `source` | `TEXT` | check in `('auto','explicit')` | auto-generated or human-defined |
| `state` | `TEXT` | check in `('active','superseded')` | lifecycle of the topic version |
| `supersedes_topic_id` | `TEXT` | nullable self-FK | previous version replaced by this row |
| `created_at` | `TEXT` | not null | row creation time |
| `updated_at` | `TEXT` | not null | metadata update time |

Version rule:

- semantic drift creates a new row with the same `topic_key` and `version + 1`
- old versions move to `state = 'superseded'`
- assignments keep pointing to the exact `topic_id` they were made against

### 5.4 `memory_topics`

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| `memory_id` | `TEXT` | PK part, FK -> `memories(id)` | hot memory being classified |
| `topic_id` | `TEXT` | PK part, FK -> `topics(id)` | pinned topic version |
| `source` | `TEXT` | check in `('auto','explicit')` | classifier output or human override |
| `confidence` | `REAL` | nullable, `0 <= confidence <= 1` | auto-classification confidence; manual assignments may leave null |
| `status` | `TEXT` | check in `('active','superseded')` | assignment lifecycle |
| `created_at` | `TEXT` | not null | assignment creation time |
| `updated_at` | `TEXT` | not null | last assignment metadata change |

Assignment rule:

- `memory_topics` is the only owner of memory-to-topic membership
- `memories.tags` remain lexical tags and are not promoted to semantic topics automatically without an explicit assignment step

## 6. Relationship and Reference Rules

1. `memories -> fact_claims` is one-to-many via `fact_claims.source_memory_id`.
2. `memories -> raw_archives` is optional via `raw_archives.source_memory_id`.
3. `memories -> topics` is many-to-many via `memory_topics`.
4. `fact_claims -> raw_archives` is optional via `fact_claims.evidence_archive_id`.
5. `raw_archives` may exist without a memory row when evidence is stored before or instead of hot-memory extraction.
6. `fact_claims` may point to archived memories. Compacting a memory does not expire the claim automatically.
7. `topics` do not own memories. They classify them. Reclassification changes `memory_topics`, not the memory row itself.

## 7. Complete DDL

```sql
CREATE TABLE IF NOT EXISTS raw_archives (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  project TEXT NOT NULL,
  source_memory_id TEXT,
  archive_type TEXT NOT NULL CHECK(archive_type IN (
    'transcript',
    'discussion',
    'design_debate',
    'chat_export',
    'tool_log',
    'document'
  )),
  title TEXT NOT NULL,
  source_uri TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_memory_id) REFERENCES memories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS fact_claims (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  project TEXT NOT NULL,
  source_memory_id TEXT,
  evidence_archive_id TEXT,
  canonical_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  claim_value TEXT NOT NULL,
  claim_text TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('hot_memory', 'raw_archive', 'manual', 'mixed')),
  status TEXT NOT NULL CHECK(status IN ('active', 'expired', 'suspected_expired', 'conflict')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  invalidation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_memory_id IS NOT NULL OR evidence_archive_id IS NOT NULL),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (source_memory_id) REFERENCES memories(id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_archive_id) REFERENCES raw_archives(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  project TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'topic' CHECK(kind IN ('topic', 'room')),
  description TEXT,
  source TEXT NOT NULL CHECK(source IN ('auto', 'explicit')),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'superseded')),
  supersedes_topic_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (supersedes_topic_id) REFERENCES topics(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS memory_topics (
  memory_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('auto', 'explicit')),
  confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, topic_id),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_archives_dedupe
  ON raw_archives(COALESCE(tenant_id, ''), content_hash);

CREATE INDEX IF NOT EXISTS idx_raw_archives_project_type
  ON raw_archives(project, archive_type);

CREATE INDEX IF NOT EXISTS idx_raw_archives_source_memory
  ON raw_archives(source_memory_id);

CREATE INDEX IF NOT EXISTS idx_fact_claims_subject_predicate
  ON fact_claims(project, subject, predicate, status);

CREATE INDEX IF NOT EXISTS idx_fact_claims_canonical_key
  ON fact_claims(project, canonical_key, status);

CREATE INDEX IF NOT EXISTS idx_fact_claims_as_of
  ON fact_claims(project, status, valid_from, valid_to);

CREATE INDEX IF NOT EXISTS idx_fact_claims_source_memory
  ON fact_claims(source_memory_id);

CREATE INDEX IF NOT EXISTS idx_fact_claims_evidence_archive
  ON fact_claims(evidence_archive_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_tenant_key_version
  ON topics(COALESCE(tenant_id, ''), project, topic_key, version);

CREATE INDEX IF NOT EXISTS idx_topics_project_state
  ON topics(project, state);

CREATE INDEX IF NOT EXISTS idx_memory_topics_topic
  ON memory_topics(topic_id);

CREATE INDEX IF NOT EXISTS idx_memory_topics_memory_status
  ON memory_topics(memory_id, status);
```

## 8. Migration Strategy

`initializeDatabase()` in `src/db/schema.ts` should evolve incrementally:

1. keep the existing `memories`, `memory_versions`, `sessions`, `entities`, `relations`, and wiki tables unchanged
2. append `CREATE TABLE IF NOT EXISTS` for `raw_archives`, `fact_claims`, `topics`, and `memory_topics`
3. append `CREATE INDEX IF NOT EXISTS` for the sidecar lookup paths
4. do not alter or backfill the `memories` row shape in this migration
5. do not join sidecar tables into `listMemories()`, FTS setup, `sessionStart()`, or current recall queries

Backfill is explicitly a follow-up concern, not part of the migration:

- optional future job: seed `raw_archives` from exported chat/log sources or selected existing `content_sources.raw_content`
- optional future job: extract `fact_claims` from active/archived memories into time-bounded assertions
- optional future job: seed `topics` from repeated tags or wiki synthesis candidates, then attach with `memory_topics`

Write-path warning:

- if raw archive means true pre-redaction source text, capture must happen before the current `MemoryService.store()` redaction/summarization pipeline. After that point only redacted content survives in memory storage.

## 9. Invariants and Forbidden Cross-Layer Operations

1. `memories` remains the only hot-path source for `session_start` and `recall`.
2. `fact_claims` must not be stored inside `memories.content`, `memories.summary`, or `memories.tags` as a surrogate schema.
3. `raw_archives.content` is immutable. Corrections create a new row; they do not overwrite the original text.
4. Expiring a fact claim updates `status`, `valid_to`, and optional reason fields. It does not edit the source memory text.
5. Archiving or compacting a memory must not silently expire or delete downstream fact claims.
6. Deleting a memory that is still the only provenance anchor for a fact claim is forbidden by design.
7. Reclassifying a topic means creating a new topic version and updating `memory_topics`; it does not repurpose an old `topics` row in place.
8. `memories.tags` and `topics` are separate systems: tags are lexical extraction aids, topics are semantic taxonomy.
9. `raw_archives` are not injected into session context by default. They are cold evidence only.

## 10. Follow-On Compatibility Notes

- VM2-001 remains valid: `deep_recall` is still the cold retrieval surface, but VM2-002 only defines the storage boundary it will later use.
- `SessionStartResult` stays unchanged in this task.
- `DeepRecallResult` can later be extended to return archive-backed evidence or claim-backed evidence without changing the hot memory contract.
