# Batch 18a — Host memory file schema compatibility framework (P8-031.1-.4 closure)

## Context

P8-031 (Wave 5) establishes forward + backward compatibility for host memory file format evolution. Today (post-12a/.1/12b) the parser handles markdown_frontmatter / plain_text / JSON as a single canonical format. Hosts (Cursor / Codex / Claude / OMC) can evolve these formats in future releases — Vega must not break when:

- **New reader reads old file** (forward compat): old frontmatter missing new optional fields → use defaults, do not fail.
- **Old reader meets new file** (backward compat): unknown new frontmatter fields → pass through to `raw_frontmatter`, don't drop; unknown body structure → fallback to plain_text.

Today we don't have a real schema evolution to handle. This batch ships the **framework** for evolution:
- `detected_format_version: "v1"` tag emitted by the parser.
- `src/retrieval/sources/host-memory-file-schema-router.ts` — new: surface + signature → parser variant selection.
- Default router maps every surface to a `v1` parser variant (the current 12a parser).
- Compat-matrix doc codifies "who adds a new version; how" plus the 2 compat guarantees.

## Scope

### 1. `src/retrieval/sources/host-memory-file-parser.ts` — emit version field

Add `detected_format_version: "v1"` to every parser function's return object. Do NOT change what fields are returned; ADD this field only.
- `parseMarkdownFrontmatter(content)` → returns `{..., detected_format_version: "v1"}`.
- `parsePlainText(content)` → same.
- `parseJson(content)` → same.
- Fallback / error path → `{..., detected_format_version: "unknown"}`.
- Type updates: export `DetectedFormatVersion = "v1" | "unknown"` (no new versions today — extended when host bumps format).

### 2. `src/retrieval/sources/host-memory-file-schema-router.ts` (new)

- Export `HostMemoryFileSchemaRouter` interface + `createDefaultSchemaRouter()` factory.
- API: `router.selectParser({ surface, contentSample }): (content: string) => ParserResult`.
  - `surface` ∈ {"cursor", "codex", "claude", "claude-projects", "omc"}.
  - `contentSample` is the first ~2KB of file content (for signature-based routing; today all route to v1).
- Default router logic:
  - For `surface === "claude-projects"`: heads matching `^---\n` → `parseMarkdownFrontmatter`; else `parsePlainText`.
  - For `cursor` / `claude` / `codex` / `omc`: same decision tree — frontmatter detection first, else fallback.
  - Future versions: add signature patterns + variant parsers to a registry map here.
- Factory is pure (no I/O, no DB).

### 3. `src/retrieval/sources/host-memory-file.ts` — use router

Wire the router into adapter flow:
- Adapter constructor accepts optional `schemaRouter?: HostMemoryFileSchemaRouter`, defaulting to `createDefaultSchemaRouter()`.
- During indexing, call `schemaRouter.selectParser(...)` instead of the hardcoded surface → parser switch.
- Emit `detected_format_version` on `SourceRecord.provenance`:
  ```ts
  provenance: {
    origin: absolutePath,
    retrieved_at: ISO,
    schema_version: parseResult.detected_format_version  // NEW
  }
  ```
- Record ID stays stable (unchanged from 12a).

### 4. `docs/adapters/host-memory-file-compat-matrix.md` (new)

Required section headings (grep-checkable):
1. `## Schema versions` — table of known versions (today: v1 only). Columns: version / introduced / surfaces / signature / parser.
2. `## Forward compatibility` — guarantee: new readers SHALL read old files. Rules: unknown fields in frontmatter pass through to `raw_frontmatter`; body treated as best-effort (plaintext fallback allowed).
3. `## Backward compatibility` — guarantee: old readers SHALL NOT crash on new files. Rules: parser returns `detected_format_version: "unknown"` + `parsePlainText` fallback on unrecognized formats.
4. `## Adding a new version` — 5-step runbook when Cursor/Claude/Codex/OMC bumps a format: (a) add signature to router, (b) add parser variant, (c) update compat matrix table, (d) add test fixture for old + new format, (e) announce via `host_memory_file.refresh` changelog.
5. `## Testing the matrix` — reference to `src/tests/host-memory-file-schema-compat.test.ts` that exercises today's matrix (v1 only) + scaffolding pattern for future versions.

### 5. `src/tests/host-memory-file-schema-compat.test.ts` (new) — ≥ 6 cases

- **Parser emits v1 tag** — `parseMarkdownFrontmatter("---\ntitle: X\n---\nbody")` returns `detected_format_version: "v1"`.
- **Plain text emits v1 tag** — same for `parsePlainText("just text")`.
- **JSON emits v1 tag** — same for `parseJson('{"title":"X"}')`.
- **Error path emits unknown tag** — malformed YAML frontmatter fallback returns `detected_format_version: "unknown"`.
- **Router selects v1 parser by surface** — all 5 surfaces → v1 parser (today). Each surface + simple content → parser result has `detected_format_version: "v1"`.
- **Adapter provenance carries schema_version** — end-to-end test: adapter indexes a file, search returns record whose `provenance.schema_version === "v1"`.

All hermetic: `mkdtempSync` tmp HOME + `:memory:` SQLite.

## Out of scope — do NOT touch

- `src/reconciliation/**`, `src/monitoring/vega-metrics.ts`, `metrics-fingerprint.ts`, `metrics.ts`, `dashboards/**`
- `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/alert/**`, `src/backup/**`, `src/timeout/**`, `src/checkpoint/**`
- `src/retrieval/sources/host-memory-file-paths.ts` / `host-memory-file-fts.ts` (no change needed)
- `src/retrieval/profiles.ts` / `ranker-score.ts` / `orchestrator.ts` / `registry.ts`
- `src/api/server.ts` / `src/mcp/server.ts` / `src/api/mcp.ts` / `src/index.ts`
- `src/db/migrations/**` / `src/core/contracts/**`
- All existing tests except adding the one new `host-memory-file-schema-compat.test.ts`
- `.eslintrc.cjs` (17a already added the override — don't touch)

## Forbidden patterns

- Production 不得嗅探测试环境
- 测试不得写真实 HOME
- 不 amend 448a288 / 30884bc; 新起 commit
- Router MUST be a pure function (no I/O); signatures evaluated from `contentSample`, not by reading files from disk
- `detected_format_version: "unknown"` MUST route to `parsePlainText` — never to a throwing path
- Record ID + source_kind unchanged (stable across version)

## Acceptance criteria

1. `rg -nE "detected_format_version" src/retrieval/sources/host-memory-file-parser.ts` ≥ 4 (one per parser + unknown path)
2. `src/retrieval/sources/host-memory-file-schema-router.ts` exists; `rg -nE "createDefaultSchemaRouter" src/retrieval/sources/host-memory-file-schema-router.ts` ≥ 1
3. `rg -nE "schemaRouter" src/retrieval/sources/host-memory-file.ts` ≥ 1 (adapter uses router)
4. `rg -nE "schema_version" src/retrieval/sources/host-memory-file.ts` ≥ 1 (provenance field)
5. `docs/adapters/host-memory-file-compat-matrix.md` exists with 5 section headings (each ≥ 1)
6. `src/tests/host-memory-file-schema-compat.test.ts` exists; `rg -c "^test\(" src/tests/host-memory-file-schema-compat.test.ts` ≥ 6
7. `git diff HEAD --name-only` limited to: parser + router (new) + adapter + compat-matrix doc + 1 new test file
8. `git diff HEAD -- src/reconciliation/ src/monitoring/vega-metrics.ts src/monitoring/metrics-fingerprint.ts src/monitoring/metrics.ts dashboards/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/backup/ src/timeout/ src/checkpoint/ src/retrieval/sources/host-memory-file-paths.ts src/retrieval/sources/host-memory-file-fts.ts src/retrieval/profiles.ts src/retrieval/ranker-score.ts src/retrieval/orchestrator.ts src/retrieval/sources/registry.ts src/api/ src/mcp/ src/index.ts src/db/migrations/ src/core/contracts/` outputs empty
9. `git diff HEAD -- src/tests/` shows only 1 new test file `host-memory-file-schema-compat.test.ts`
10. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1154 pass / 0 fail
11. Not-amend; new commit on HEAD
12. Commit title prefix `feat(retrieval):`
13. Commit body:
    ```
    Ships host memory file schema compatibility framework P8-031.1-.4:
    - host-memory-file-parser.ts emits detected_format_version: "v1" on
      every parser return + "unknown" on error path.
    - New host-memory-file-schema-router.ts: createDefaultSchemaRouter()
      selects per-surface parser variant by content signature. Today all
      5 surfaces route to the v1 parser; router is pure (no I/O).
    - Adapter wires router through constructor; SourceRecord.provenance
      now carries schema_version (v1 | unknown). Record id + source_kind
      unchanged.
    - docs/adapters/host-memory-file-compat-matrix.md: schema versions
      table / forward-compat / backward-compat / adding a new version
      (5-step runbook) / testing the matrix.
    - New host-memory-file-schema-compat.test.ts with ≥ 6 cases covering
      parser v1 emission, unknown fallback, router dispatch, and adapter
      provenance end-to-end.

    Scope: no touches to host-memory-file-paths / -fts; zero reconciliation
    / monitoring / scheduler / notify / sunset / alert / backup / timeout
    / checkpoint changes. 17a ESLint override remains unchanged.

    Scope-risk: minimal
    Reversibility: clean (single-field addition to provenance; router
    injection is opt-in via constructor default)
    ```

## Review checklist

- Is the router a pure function (no disk reads, no env lookups)?
- Do all 4 parser paths emit `detected_format_version`?
- Does the error path (malformed frontmatter) route to `parsePlainText` with `detected_format_version: "unknown"` (not throw)?
- Does the adapter's `schemaRouter` constructor arg have a sensible default (`createDefaultSchemaRouter()`)?
- Does `SourceRecord.provenance.schema_version` surface in the end-to-end adapter test?
- Zero changes to host-memory-file-paths / -fts / registry?
- New commit stacks on `30884bc` (not an amend)?

## Commit discipline

- Single atomic commit, new stack on HEAD
- Prefix `feat(retrieval):`
- Body per Acceptance #13
- No root-level markdown; only allowed new doc is `docs/adapters/host-memory-file-compat-matrix.md`
