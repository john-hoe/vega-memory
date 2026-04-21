# Canary Rollout

Vega's feature-flag framework gates behavior on three dimensions — `surface` × `intent` × `traffic_percent` — using a YAML registry, deterministic bucketing, and in-memory metrics.

## Flag registry format

The registry lives at `docs/feature-flags/flags.yaml`. Each flag has:

```yaml
flags:
  - id: canary-api-ingest-v2
    description: Roll out the v2 ingest pipeline
    variants:
      on: true
      off: false
    default: "off"
    matchers:
      surfaces: "*"
      intents: ["ingest"]
      traffic_percent: 10
    bucketing:
      seed_field: session_id
```

A surface-scoped flag example:

```yaml
  - id: canary-codex-l3-rerank
    description: Enable L3 reranking for codex surface only
    variants:
      on: true
      off: false
    default: "off"
    matchers:
      surfaces: ["codex"]
      intents: "*"
      traffic_percent: 100
```

## Evaluation semantics

`evaluateFeatureFlag(flag, ctx)` runs six steps:

1. **Surface match** — `matchers.surfaces === "*"` or contains `ctx.surface`.
2. **Intent match** — `matchers.intents === "*"` or contains `ctx.intent`.
3. **Matcher miss** — if either fails, return `flag.default` with reason `"matcher_miss"`.
4. **Traffic 0** — if `traffic_percent === 0`, return `"off"` with reason `"traffic_0"`.
5. **Traffic 100** — if `traffic_percent === 100`, return `"on"` with reason `"traffic_100"`.
6. **Bucketed rollout** — compute `hashBucket(ctx[seed_field], flag.id)`. If `bucket < traffic_percent`, variant is `"on"`; otherwise `"off"`. Reason is `"bucket_${bucket}_${threshold}"`.

## Deterministic bucketing

`hashBucket(seed, flag_id)` uses sha256 over `"${seed}:${flag_id}"`, takes the first 4 bytes as an unsigned integer, and returns `value % 100` (range 0-99).

Using `session_id` as the seed field gives **stable per-user rollout**: the same user (session) always lands in the same bucket for the same flag, so their experience does not flip-flap as the traffic percentage is gradually increased.

## Adding a new flag

1. Add the flag definition to `docs/feature-flags/flags.yaml`.
2. Deploy the registry change (no code change needed for simple on/off gates).
3. Call `feature_flag.evaluate` with the flag ID and evaluation context to check the variant at runtime.
4. Observe hit counts and reasons via `feature_flag.metrics`.

## Sunset and retirement

To retire a flag:

1. Set `default: "on"` and `matchers.traffic_percent: 100` so all traffic gets the "on" variant.
2. Remove the flag from `docs/feature-flags/flags.yaml` once the code path no longer branches on the flag.

For broader retirement policy, see the [P8-033 sunset framework brief](../briefs/2026-04-20-batch13a-criteria-driven-sunset-framework.md).
