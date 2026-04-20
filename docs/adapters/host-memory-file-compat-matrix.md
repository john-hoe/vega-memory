## Schema versions

| version | introduced | surfaces | signature | parser |
| --- | --- | --- | --- | --- |
| `v1` | Batch 12a baseline, compat framework in Batch 18a | `cursor`, `codex`, `claude`, `claude-projects`, `omc` | `^---\n` for markdown frontmatter, otherwise plaintext fallback | `parseMarkdownFrontmatter` or `parsePlainText` via `createDefaultSchemaRouter()` |

## Forward compatibility

New readers SHALL read old files without breaking indexing or search.

Unknown frontmatter fields pass through to `raw_frontmatter` consumers via the parsed `frontmatter` object and are not dropped during v1 parsing. When a body shape no longer matches a known structure, the reader is allowed to keep best-effort plaintext content instead of rejecting the file.

## Backward compatibility

Old readers SHALL NOT crash when they encounter a newer or malformed file shape.

When a frontmatter-like document cannot be parsed as a known schema, the parser falls back to `parsePlainText`, returns `detected_format_version: "unknown"`, and continues indexing/search without throwing. Unknown future signatures follow the same safety rule: prefer plaintext fallback over failure.

## Adding a new version

1. Add the new content signature to `src/retrieval/sources/host-memory-file-schema-router.ts`.
2. Add the new parser variant and keep the fallback path non-throwing.
3. Update the schema table in this compat matrix with the new version metadata.
4. Add fixture coverage for both the previous format and the new format in `src/tests/host-memory-file-schema-compat.test.ts`.
5. Announce the change through the `host_memory_file.refresh` changelog so host adapters know which signatures were added.

## Testing the matrix

`src/tests/host-memory-file-schema-compat.test.ts` is the hermetic matrix check for the current `v1` surface. It covers parser version emission, the malformed-frontmatter fallback to `unknown`, router dispatch for every supported surface, and adapter provenance propagation. Future versions should extend that file with one fixture pair per old/new schema transition.
