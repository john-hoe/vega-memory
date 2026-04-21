# Phase 8 Weekly Status Template

Use this template for the weekly Phase 8 rollup. Keep every placeholder explicit until the batch or stage closes, and map the final SEAL commit SHA back to the matching Notion `GitHub/Commit 链接` field.

## Shipped this week

- `{{batch_id}}` - `{{summary}}` - commit range `{{sha_start}}..{{sha_end}}`
- `{{batch_id}}` - `{{summary}}` - SEAL commit `{{seal_sha}}`
- Archived briefs: `{{docs/briefs/YYYY-MM-DD-batchXX-slug.md}}`

## In progress

- `{{batch_id}}` - owner `{{owner}}` - status `{{started|blocked|in_review}}`
- Blocking item: `{{byte-locked path or dependency}}`
- Phase 8 issue / PR / brief link: `{{github_or_brief_link}}`

## Upcoming

- `{{next_batch_or_stage}}` - target `{{P8 task ids}}`
- `{{next_batch_or_stage}}` - dependency `{{prerequisite}}`
- Requested decision: `{{user decision or sequencing choice}}`

## Metrics snapshot

- `vega_retrieval_nonempty_ratio`: `{{value}}`
- `vega_usage_ack_sufficiency_insufficient_ratio`: `{{value}}`
- `vega_usage_followup_loop_override_total`: `{{value}}`
- `vega_circuit_breaker_state`: `{{value_by_surface}}`
- `vega_raw_inbox_oldest_age_seconds`: `{{value_by_event_type}}`
- Test count: `{{pass_count}}` pass / `{{fail_count}}` fail
- Reconciliation findings delta: `{{delta_summary}}`

## Risks & asks

- Risk: `{{scope, regression, or rollout risk}}`
- Ask: `{{approval, sequencing, or unblock request}}`
- Byte-lock check status: `{{clean|violation_found|not_applicable}}`
