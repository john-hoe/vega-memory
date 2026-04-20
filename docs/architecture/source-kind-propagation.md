# Source Kind Propagation

## Invariant

`source_kind` assigned at ingest is expected to stay observable without reinterpretation as records move through Vega surfaces. Today that invariant is directly enforced for `raw_inbox` and for retrieval bundle records that originate from the `host_memory_file` adapter.

## Propagation path

`ingest_event`
-> `raw_inbox.source_kind`
-> store-specific hydration or retrieval adapter materialization
-> `bundle.sections[*].records[*].source_kind`
-> `usage_ack` acceptance of the checkpoint produced from that bundle

## Canonical values

The canonical `source_kind` enum currently includes:

- `host_memory_file`
- `vega_memory`
- `candidate`
- `wiki`
- `fact_claim`
- `graph`
- `archive`

The authoritative enum lives in [src/core/contracts/enums.ts](/Users/johnmacmini/workspace/vega-memory/src/core/contracts/enums.ts:12).

## Known gaps

- `candidate_memories` does not expose a dedicated `source_kind` column yet.
- `memories` does not expose a dedicated `source_kind` column yet.
- `wiki_pages` does not expose a dedicated `source_kind` column yet.
- `fact_claims` does not expose a dedicated `source_kind` column yet.
- `relations` does not expose a dedicated `source_kind` column yet for graph-backed records.
- `raw_archives` does not expose a dedicated `source_kind` column yet.
- `usage_ack` currently accepts checkpoints derived from `source_kind`-bearing bundles, but it does not echo or persist `source_kind` as a first-class field.

TODO: add per-store schema support before tightening the store-level propagation assertion beyond `raw_inbox` and bundle materialization.

## Testing

End-to-end coverage lives in [src/tests/source-kind-propagation.test.ts](/Users/johnmacmini/workspace/vega-memory/src/tests/source-kind-propagation.test.ts:1). The test suite covers raw inbox persistence, per-store schema inspection across candidate/promoted/wiki/fact-claim/graph/archive, host-memory retrieval bundle propagation, usage-ack acceptance, and the full ingest -> retrieve -> ack chain.
