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

Store-level schema support is still absent in every currently-inspected persistence table. The test suite now locks that exact missing-store set so this gap cannot stay silently green:

- `candidate_memory:candidate_memories`
- `promoted_memory:memories`
- `wiki:wiki_pages`
- `fact_claim:fact_claims`
- `graph:relations`
- `archive:raw_archives`

## Testing

End-to-end coverage lives in [src/tests/source-kind-propagation.test.ts](/Users/johnmacmini/workspace/vega-memory/src/tests/source-kind-propagation.test.ts:1). The test suite covers raw inbox persistence, the exact current missing-store set across candidate/promoted/wiki/fact-claim/graph/archive, a pure `>= 4` threshold regression helper, host-memory retrieval bundle propagation, usage-ack acceptance, and the full ingest -> retrieve -> ack chain.
