# VM2-017 Code/Doc Graph Sidecar

Status: accepted implementation spec
Scope: code/doc graph sidecar ingestion, incremental refresh, feature-flag rollout, CLI exposure
Non-goals: replace hot memory, replace topic taxonomy, require graph parsing for every language, or make graph failures block indexing

## 1. Goal

VM2-017 adds a sidecar lane for repository structure.

The lane is additive:

- `code-index` and `doc-index` still write the same `project_context` memories
- structured graph data reuses the existing `entities` and `relations` tables
- graph refresh is incremental by per-file SHA-256 content hash
- graph parsing failures fail open and do not break indexing

The hot-memory path stays primary. The sidecar is extra structure, not a replacement.

## 2. Activation

### 2.1 Feature flag

`src/config.ts` exposes:

| Env var | Config field | Default | Meaning |
| --- | --- | --- | --- |
| `VEGA_FEATURE_CODE_GRAPH` | `features.codeGraph` | `false` | Enable structural graph writes during code/doc indexing |

Rules:

- flag off: `index` and `index-docs` keep legacy behavior
- flag on: code/doc indexing also refreshes sidecar graph state
- CLI `--graph` forces sidecar refresh for that invocation even if the env flag is off

### 2.2 Failure contract

- sidecar parsing is best-effort
- memory writes still succeed when graph extraction fails
- stale structural edges for the affected file are cleared only when a new sidecar sync succeeds or the file disappears from the indexed scope

## 3. Storage Model

### 3.1 Graph entities

The sidecar extends entity typing with:

- `module`
- `function`
- `class`
- `document`
- `heading`
- `term`

`entities.metadata` stores structured detail when available:

- modules: relative path
- functions: source signature + export status
- classes: class definition summary + export status
- documents/headings: source label, level, ordinal
- terms: normalized term text

### 3.2 Graph relations

The sidecar uses the structural relation family already kept separate from semantic memory links:

- `imports` for module-to-module imports/dependencies
- `declares` for module-to-function/class ownership
- `exports` for module-to-exported-symbol edges
- `contains` for document/heading hierarchy
- `references` for `[[link]]` cross references
- `defines` for term-definition edges

Semantic relations (`uses`, `depends_on`, `related_to`, `part_of`, `caused_by`) remain owned by the hot-memory KG linker.

### 3.3 Memory anchoring

The sidecar does not create extra memories.

It anchors structural relations to the existing index memories:

- code graph: `Code Index: <relative-path>`
- doc graph: `<relative-path>: <heading>`

That keeps `relations.memory_id` valid while preserving the main memory chain.

## 4. Incremental Cache

Per-file cache state is stored in `metadata`.

Key shape:

- `sidecar:code-graph:<sha256(scope-key)>:<relative-path>`
- `sidecar:doc-graph:<sha256(scope-key)>:<relative-path>`

`scope-key` is the indexed root directory for directory indexing, or the parent directory for single-file doc indexing. The hash avoids path-length and escaping issues.

Value shape:

```json
{
  "hash": "<sha256 content hash>",
  "memoryIds": ["memory-id-1", "memory-id-2"],
  "itemCount": 2
}
```

Rules:

- unchanged hash + live memory ids: skip graph rebuild
- changed file: rebuild only that file's structural graph
- deleted file: clear only that file's structural graph and remove its cache entry
- source memories are intentionally left in place on delete to preserve legacy indexing behavior

## 5. Code Graph

### 5.1 Extraction

Code graph extraction is AST-first for JavaScript/TypeScript-family files:

- lazy-load the TypeScript compiler API
- parse imports, exports, classes, functions, and exported function-valued variables

Unsupported languages keep normal symbol indexing and simply produce no structural sidecar graph.

### 5.2 Naming

- module: `module:<relative-path>`, for example `module:src/core/code-index.ts`
- function: `function:<signature> (<relative-path>)`
- class: `class:<ClassName> (<relative-path>)`

### 5.3 Relations

For each code file:

- module `imports` dependency module
- module `declares` function/class symbol
- module `exports` exported function/class symbol

## 6. Doc Graph

### 6.1 Extraction

Doc graph extraction runs against the same section memories created by `doc-index`:

- root sections come from existing `##` splitting or whole-file fallback
- nested headings are read from `###` through `######`
- wiki links come from `[[link]]`
- term definitions come from `Term: definition` / `**Term**: definition`

### 6.2 Naming

- document: `doc:<source-label>`
- root heading: `heading:<document>#<ordinal>:<Heading>`
- nested heading: `heading:<document>#<section>.<nested-ordinal>:<Heading>`
- term: `term:<normalized-visible-term>`

### 6.3 Relations

For each indexed document:

- document `contains` root section heading
- heading `contains` nested headings
- heading `references` other headings, terms, or unresolved document targets
- heading `defines` terms

## 7. CLI

The CLI surface is:

- `vega index <directory> --graph`
- `vega index-docs <path> --graph`
- `vega graph stats`

`vega graph stats` reports:

- total entities
- total relations
- counts by entity type
- counts by relation type
- tracked code files
- tracked doc files

## 8. Verification

Required verification for VM2-017:

- config tests cover `VEGA_FEATURE_CODE_GRAPH`
- code index tests cover default-off behavior, graph build, unchanged-file skip, and deleted-file cleanup
- doc index tests cover graph build, hierarchy, references, and term extraction
- CLI tests cover `index --graph` and `graph stats`
- `npm run build`
- `npm test`
