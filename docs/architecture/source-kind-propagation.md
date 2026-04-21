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

All 6 inspected persistence stores now support `source_kind` as of 2026-04-21:

- `candidate_memory:candidate_memories`
- `promoted_memory:memories`
- `wiki:wiki_pages`
- `fact_claim:fact_claims`
- `graph:relations`
- `archive:raw_archives`

## Testing

End-to-end coverage lives in [src/tests/source-kind-propagation.test.ts](/Users/johnmacmini/workspace/vega-memory/src/tests/source-kind-propagation.test.ts:1). The test suite covers raw inbox persistence, 6/6 store support across candidate/promoted/wiki/fact-claim/graph/archive, legacy-row backfill, a pure `>= 4` threshold regression helper, host-memory retrieval bundle propagation, usage-ack acceptance plus source-kind echo, and the full ingest -> retrieve -> ack chain.
