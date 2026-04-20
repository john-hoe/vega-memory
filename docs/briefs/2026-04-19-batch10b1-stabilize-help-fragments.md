# Batch 10b.1 — Stabilize metric HELP text + fingerprint fragments

## Problem
Round-1 review on commit `0f7f77b` (Batch 10b) returned **BLOCK** with 2 HIGH findings: `helpFragment` values in `src/monitoring/metrics-fingerprint.ts` coupled to code-level implementation details (`"records.length > 0"`, `"putResult.status === inserted"`) instead of stable semantic phrases. Audit extended the concern to 2 more MEDIUM-grade fragile entries (`"state transitions"` fragile to rewording, `"closed -> open transitions"` fragile to symbol change). Root cause is upstream: the HELP texts in `src/monitoring/vega-metrics.ts` themselves were written in developer-trace jargon (`bundle.sections.some(...)`, `putResult.status === inserted`, `closed -> open`), not in semantic "what the metric counts" language.

## Design principle (must be written as comment at top of metrics-fingerprint.ts)
```
// HELP fragments must describe WHAT the metric counts (semantic),
// not HOW the code detects it (implementation details / symbols).
//
// GOOD:   stable semantic phrases
// BAD:    code-level comparisons, method calls, or symbolic arrows
//
// Rule: a harmless HELP rephrase MUST NOT trip the drift test unless
// the metric's semantic contract changed.
```

## Scope

### 1. Rewrite 4 HELP texts in `src/monitoring/vega-metrics.ts`
Replace the HELP string (second arg) at exactly these 4 register sites. Metric name, type, and label array **must stay byte-identical**. Surrounding code (imports, struct, gauge callbacks, emit methods) **must not change**.

| Line (approx) | Metric | New HELP text |
|---|---|---|
| 118 | `retrieval_nonempty_total` | `"Counts context.resolve calls that returned a non-empty retrieval bundle (error bundles excluded). Per-process counter."` |
| 123 | `usage_ack_total` | `"Counts first-time usage ack inserts. Per-process counter; intent is not labeled because usage_acks cannot reliably recover it."` |
| 133 | `circuit_breaker_state` | `"Reports current per-surface circuit breaker state. Gauge values are 0=closed, 1=open, 2=cooldown; per-process, resets on restart."` |
| 138 | `circuit_breaker_trips_total` | `"Counts circuit breaker trips (breaker opening events); one increment per trip reason. Per-process counter."` |

The other 4 HELP texts (lines 113, 128, 143, 148) are **already semantic and must NOT change**.

### 2. Update 4 `helpFragment` values in `src/monitoring/metrics-fingerprint.ts`
Match the new HELP texts above. Other 4 fragments (lines 15, 33, 51, 57 in current fingerprint.ts) **must not change** — they are already stable.

| Entry | Old fragment | New fragment |
|---|---|---|
| `vega_retrieval_nonempty_total` (line 21) | `"records.length > 0"` | `"non-empty retrieval bundle"` |
| `vega_usage_ack_total` (line 27) | `"putResult.status === inserted"` | `"first-time usage ack"` |
| `vega_circuit_breaker_state` (line 39) | `"state transitions"` | `"current per-surface circuit breaker state"` |
| `vega_circuit_breaker_trips_total` (line 45) | `"closed -> open transitions"` | `"circuit breaker trips"` |

### 3. Add the design principle comment block (quoted above, verbatim) at the TOP of `src/monitoring/metrics-fingerprint.ts`
Place it immediately after any existing top-of-file comment/import block but before the `export type MetricType` line. Do NOT modify existing type definitions or exported const.

## Out of scope — do NOT touch
- Metric names, types, label keys (contract preserved byte-for-byte)
- Other 4 HELP texts (lines 113, 128, 143, 148 of vega-metrics.ts)
- Other 4 helpFragments (lines 15, 33, 51, 57 of current metrics-fingerprint.ts)
- `src/monitoring/metrics.ts` (collector core unchanged)
- `src/api/server.ts` / `src/retrieval/**` / `src/usage/**` / `src/scheduler/**`
- 10a.1 revert-locked files (config.ts / keychain.ts / integration-surface-status.ts / doctor.ts)
- `dashboards/vega-runtime-core.json` (no label/title changes from HELP rewrite)
- `src/tests/metrics-fingerprint.test.ts` (the test uses `fingerprint.helpFragment` as the needle, so updating fragment values is sufficient — do NOT edit test assertions)
- Other `src/tests/**` files
- `docs/**` except this brief; no new markdown
- Root-level markdown files

## Forbidden files
- All 10a + 10b Out of scope files (continue locked)
- `src/monitoring/metrics.ts`
- Specifically for this batch, only 2 files may change:
  - `src/monitoring/vega-metrics.ts` — only the 4 HELP string literals listed above
  - `src/monitoring/metrics-fingerprint.ts` — only the 4 helpFragment values + the new top-of-file comment block
- Any other edit = creep

## Forbidden patterns (Wave 5 全程继续)
- Production 代码不得嗅探测试环境
- 测试不得触碰真实 HOME / keychain / user config
- fingerprint.ts 不 import vega-metrics.ts，vega-metrics.ts 不 import metrics-fingerprint.ts（parallel spec 原则）
- HELP 文本不得包含代码符号、方法调用、运算表达式、比较符、箭头（`->`、`===`、`length >`、`.status` 等）。仅写**语义**短语

## Acceptance criteria
1. `grep -nE 'records\.length|putResult\.status|closed -> open' src/monitoring/` 返回空（所有 fragile 字符串被移除）
2. `grep -nE 'non-empty retrieval bundle' src/monitoring/vega-metrics.ts src/monitoring/metrics-fingerprint.ts` 均命中 1 处
3. `grep -nE 'first-time usage ack' src/monitoring/vega-metrics.ts src/monitoring/metrics-fingerprint.ts` 均命中 1 处
4. `grep -nE 'current per-surface circuit breaker state' src/monitoring/vega-metrics.ts src/monitoring/metrics-fingerprint.ts` 均命中 1 处
5. `grep -nE 'circuit breaker trips' src/monitoring/vega-metrics.ts src/monitoring/metrics-fingerprint.ts` 均命中（fingerprint.ts 应是新 fragment，vega-metrics.ts 应在 HELP 文本里）
6. `git diff HEAD -- src/monitoring/vega-metrics.ts` 的 +/- 行数应 ≤ 10（4 行 HELP 字符串替换 + 上下文格式）
7. `git diff HEAD -- src/monitoring/metrics-fingerprint.ts` 的 +/- 行数应 ≤ 20（4 个 fragment 值 + 新加的 principle 注释块）
8. `git diff HEAD` 只涉及上面 2 个文件，其他 0 变动
9. metric name / type / labelKeys 没变（Set equality of names + types from fingerprint before/after 应相同）
10. fingerprint.ts 的 principle 注释块**原样**包含 Design principle 段里的全部内容
11. `npm run build` 成功退出；`npm test` 全绿（保持 1001 pass，3 个 drift test 仍通过但现在断言的是新 fragment）
12. 严格**不 amend** commit `0f7f77b`，新起 commit 在其上
13. Commit title 前缀 `fix(monitoring):`
14. Commit body：
    ```
    Closes Round-1 review findings on 0f7f77b (Batch 10b). HELP texts for
    vega_retrieval_nonempty_total, vega_usage_ack_total,
    vega_circuit_breaker_state, and vega_circuit_breaker_trips_total were
    written in developer-trace jargon, making the fingerprint oracle
    coupled to implementation wording. A harmless HELP rephrase would
    have tripped the drift test.

    Rewrites the 4 HELP texts to semantic descriptions and updates the
    matching helpFragments. Metric name/type/labels remain unchanged —
    contract preserved byte-for-byte; only the human-readable HELP
    strings and their parallel fingerprint values are updated.

    Also adds a design-principle comment block at the top of
    metrics-fingerprint.ts to prevent future drift: HELP fragments must
    be semantic phrases, not code-level or symbolic details.

    Scope-risk: low
    Reversibility: clean
    ```

## Review checklist
- 4 个 HELP 字符串是否**完全原样**替换为 Scope #1 表格里的新文本？大小写、标点、空格一个字符都不能偏
- 4 个 helpFragment 值是否**完全原样**替换为 Scope #2 表格里的新文本？
- metric name / type / labels 数组有没有被误动（应该 0 变动）？
- fingerprint.ts 顶部有没有把 principle 注释块**完整**加进去？
- 其他 4 个 HELP 文本和其他 4 个 fragment 是否一字未动？
- 有没有顺手改 dashboard JSON / 测试 / 其他文件？应为 0
- 新 commit 是不是叠在 `0f7f77b` 下方（`git log --oneline -2`）而非 amend？

## Commit discipline
- 单 atomic commit，新起
- 前缀 `fix(monitoring):`
- body 按 Acceptance #14 模板
- 不创建 markdown / root-level 文档
