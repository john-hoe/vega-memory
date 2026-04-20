# Batch 14a — Alert system framework (P8-035.1-.4 closure)

## Context

P8-035 (Wave 5) ships runtime alerting over Dashboard 核心 5 metrics (from 10a/10b). Design picks (Q1-Q4 approved):
- **Q1 — Rules**: 5 alert rules aligned with Dashboard core 5 (`vega_retrieval_*`, `vega_usage_ack_*`, `vega_circuit_breaker_state`, `vega_raw_inbox_rows`, `vega_raw_inbox_oldest_age_seconds`). Thresholds YAML-configurable + env override.
- **Q2(α) — Channels**: Generic webhook as MVP; Slack + Telegram are webhook profiles (payload shape wrappers, single HTTP POST transport).
- **Q3 — Dedupe**: SQLite `alert_history` table (inline DDL pattern like `reconciliation_findings` — no new migration file) + cooldown 30min default (`VEGA_ALERT_COOLDOWN_MS` env override).
- **Q4 — Lifecycle**: Self-managed `setInterval` scheduler (60s interval, `VEGA_ALERT_CHECK_INTERVAL_MS` env override with `parsed > 0` guard), `dispose()` API — mirrors 13a `SunsetScheduler` + 12b `HostMemoryFileAdapter`. **Does NOT touch `src/scheduler/**`**.

All 4 subs of P8-035 in this single batch: .1 rules / .2 channels / .3 dedupe+cooldown / .4 tests+playbook.

## Scope

### 1. `docs/alerts/alert-rules.yaml` (new) — 5 starter rules

```yaml
# Vega alert rules registry (P8-035). Aligned with Dashboard core 5 metrics.
# Each rule declares a threshold against a Prometheus-style metric; the evaluator
# calls injected metricsQuery(metric, windowMs) → number | null.
#
# Schema (zod-enforced in src/alert/rules.ts):
#   - id: kebab-case-string
#   - severity: "info" | "warn" | "critical"
#   - metric: string               # Prometheus metric name
#   - operator: ">" | ">=" | "<" | "<="
#   - threshold: number
#   - window_ms: integer > 0       # rolling window for metric evaluation
#   - min_duration_ms: integer >= 0 # threshold must hold for at least this long
#   - channels: [string, ...]      # channel ids to dispatch to
#
rules:
  - id: retrieval_coverage_low
    severity: warn
    metric: vega_retrieval_nonempty_ratio
    operator: "<"
    threshold: 0.5
    window_ms: 300000     # 5 min
    min_duration_ms: 900000   # 15 min sustained
    channels: [default_webhook]
  - id: usage_ack_sufficiency_low
    severity: warn
    metric: vega_usage_ack_sufficiency_insufficient_ratio
    operator: ">"
    threshold: 0.3
    window_ms: 600000     # 10 min
    min_duration_ms: 600000   # 10 min sustained
    channels: [default_webhook]
  - id: circuit_breaker_open
    severity: critical
    metric: vega_circuit_breaker_state
    operator: ">"
    threshold: 0          # 0=closed, 1=open, 2=cooldown
    window_ms: 120000     # 2 min
    min_duration_ms: 120000   # 2 min sustained
    channels: [default_webhook]
  - id: raw_inbox_backlog_high
    severity: warn
    metric: vega_raw_inbox_rows
    operator: ">"
    threshold: 10000
    window_ms: 300000     # 5 min
    min_duration_ms: 300000   # 5 min sustained
    channels: [default_webhook]
  - id: raw_inbox_oldest_age_high
    severity: critical
    metric: vega_raw_inbox_oldest_age_seconds
    operator: ">"
    threshold: 3600       # 1 hour
    window_ms: 300000
    min_duration_ms: 300000
    channels: [default_webhook]

# Channel instances (registered via `docs/alerts/channels.yaml` separately for
# deployment-specific secrets; this file is environment-agnostic).
```

### 2. `docs/alerts/channels.yaml` (new) — channel registry (empty starter)

```yaml
# Vega alert channel registry. Kept SEPARATE from alert-rules.yaml so secrets
# (webhook URLs, bot tokens) stay out of the rule definitions.
#
# Schema (zod-enforced in src/alert/channels/index.ts):
#   - id: kebab-case
#   - type: "webhook" | "slack" | "telegram"
#   - config:
#       webhook: { url: string, headers?: Record<string,string>, method?: "POST" }
#       slack:   { url: string }  # webhook URL; payload wrapped as Slack blocks
#       telegram: { bot_token: string, chat_id: string }  # wrapped as Telegram sendMessage
#   - enabled: boolean  # default true
#
# For production, consider reading secrets from process.env instead of inlining
# them here. Example env-ref syntax: url: "${VEGA_ALERT_WEBHOOK_URL}" (parser
# expands ${VAR} placeholders).
channels: []
```

### 3. `src/alert/rules.ts` (new)

- zod `AlertRuleSchema` matching the YAML above. `severity` enum, `operator` enum, `window_ms > 0`, `min_duration_ms >= 0`.
- `loadAlertRules(path: string): AlertRule[]` — file missing / parse error → `[]` + warn log (never throws). Match 13a pattern.
- Environment overrides: optional `thresholdOverrides` param to `loadAlertRules`, sourced from env vars like `VEGA_ALERT_RULE_<ID>_THRESHOLD`. Keep this a **pure optional hook** — if caller doesn't supply, env is not consulted. No global `process.env` read inside the loader for clean testability.

### 4. `src/alert/evaluator.ts` (new)

- `AlertState = "firing" | "pending" | "resolved" | "skipped"`
- `AlertEvaluation = { rule_id, state, value, reasons: string[], evaluated_at: ISO }`
- `evaluateAlertRules(rules, { metricsQuery, now }): AlertEvaluation[]`
  - For each rule: call `metricsQuery(metric, windowMs)` → number | null.
  - If null: state = `"skipped"` with reason `"metric_unavailable"`.
  - Else: apply operator + threshold → firing/pending (pending if inside `min_duration_ms` latency window; this is a simplification — real Prometheus alertmanager has richer state machine, but MVP keeps it simple: "fire if threshold crossed in current window; dedupe + cooldown handles re-firing").
- `metricsQuery: (metric: string, windowMs: number) => Promise<number | null>` — injected interface.

### 5. `src/alert/history.ts` (new) — SQLite dedupe + cooldown

- Schema (applied at scheduler startup, mirrored from `applyReconciliationFindingsMigration`):
  ```sql
  CREATE TABLE IF NOT EXISTS alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    value REAL NOT NULL,
    fired_at INTEGER NOT NULL,        -- epoch ms
    resolved_at INTEGER NULL,
    channels TEXT NOT NULL,           -- JSON array of channel_ids dispatched
    dispatch_status TEXT NOT NULL     -- JSON: {channel_id: "ok"|"error:<msg>"}
  );
  CREATE INDEX IF NOT EXISTS idx_alert_history_rule_fired
    ON alert_history(rule_id, fired_at);
  CREATE INDEX IF NOT EXISTS idx_alert_history_fired ON alert_history(fired_at);
  ```
- `applyAlertHistoryMigration(db: DatabaseAdapter): void` — SQLite-only; early-return on `db.isPostgres`.
- `isInCooldown(db, rule_id, now, cooldownMs): boolean` — query most-recent `fired_at` WHERE `rule_id = ?` AND `resolved_at IS NULL`; true if `now - fired_at < cooldownMs`.
- `recordAlertFired(db, { rule_id, severity, value, fired_at, channels, dispatch_status }): void`.
- `markAlertResolved(db, rule_id, resolved_at): void` — update the most-recent unresolved row for the rule_id.
- All functions: Postgres-safe via internal `if (db.isPostgres) return ...` (return false / null on read; no-op on write).

### 6. `src/alert/scheduler.ts` (new) — self-managed lifecycle

Class `AlertScheduler` — mirror `SunsetScheduler`:
- Constructor: `{ db, rules, channels, evaluator, cooldownMs, intervalMs, now }`
- `intervalMs` default: 60_000ms (60s). Env: `VEGA_ALERT_CHECK_INTERVAL_MS` with `parsed > 0` guard.
- `cooldownMs` default: 1_800_000ms (30min). Env: `VEGA_ALERT_COOLDOWN_MS` with `parsed > 0` guard.
- `start()` — ensure migration applied; kick off `setInterval(...)`. Timer `unref()`-ed.
- `stop()` — idempotent `clearInterval`.
- `tick()`:
  1. Evaluate all rules → `AlertEvaluation[]`.
  2. For each `state === "firing"`: skip if `isInCooldown(...)`; else dispatch to declared channels; record `recordAlertFired(...)`.
  3. For each `state === "resolved"` or metric dropped back below threshold: `markAlertResolved(...)`.
- `notifier` override: optional `dispatch` fn injected so tests don't hit network.

### 7. `src/alert/channels/webhook.ts` (new)

- `createWebhookChannel({ id, url, headers?, method = "POST" }): AlertChannel` — returns `{ id, send(payload: AlertPayload): Promise<{status: "ok"} | {status: "error", message: string}> }`.
- `send()`:
  - Build HTTP request (default `Content-Type: application/json`, merge `headers`).
  - Body: `JSON.stringify({ alert_id, severity, value, threshold, fired_at, message })`.
  - Retry: up to 3 attempts with 1s / 3s / 10s delays on 5xx or network error.
  - Timeout: 5s per attempt.
  - ALL errors (network / 4xx / 5xx after retries) → return `{status: "error", message: <detail>}`. Never throws.
- Uses `globalThis.fetch` (Node 18+ built-in). No external deps.

### 8. `src/alert/channels/slack.ts` (new)

- `createSlackChannel({ id, url }): AlertChannel` — wraps webhook, overrides payload shape:
  ```
  { text: "<severity>: <alert_id>", blocks: [{ type: "section", text: { type: "mrkdwn", text: "..." }}] }
  ```
- Delegates HTTP via internal `createWebhookChannel`.

### 9. `src/alert/channels/telegram.ts` (new)

- `createTelegramChannel({ id, botToken, chatId }): AlertChannel` — wraps webhook to `https://api.telegram.org/bot<token>/sendMessage`:
  ```
  { chat_id: chatId, text: "<severity>: <alert_id>\n<details>", parse_mode: "Markdown" }
  ```

### 10. `src/alert/channels/index.ts` + `src/alert/index.ts` (new, barrels)

Re-export all channels + types. `loadAlertChannels(path, env?)` loads `docs/alerts/channels.yaml` and instantiates via zod-validated factories; missing file / parse error → `[]` + warn. Supports `${VAR}` placeholder expansion for secret injection.

### 11. `src/mcp/server.ts` — new MCP tools (register 2, scope tight)

- **`alert.check`**: zod input `{ rules_path?: string, channels_path?: string }`. Handler: load rules + channels → evaluate → return `{ schema_version: "1.0", evaluated_at, evaluations: AlertEvaluation[], degraded?: "rules_missing" | "channels_missing" | "parse_error" }`. Never throws.
- **`alert.fire`**: zod input `{ rule_id: string, reason?: string }`. Handler: manual fire — looks up rule, dispatches to declared channels, records history. Returns `{ schema_version: "1.0", fired_at, dispatch_status }`. Never throws. Useful for testing alert pipelines without threshold crossing.

Only **2 tool registrations** added. Do NOT touch other tool wiring.

### 12. Lifecycle wiring — `src/api/server.ts` + `src/mcp/server.ts`

Instantiate `AlertScheduler` alongside existing adapters. Env gate: `VEGA_ALERT_SCHEDULER_ENABLED !== "false"` (default enabled). Call `stop()` on shutdown. Match 12b / 13a pattern.

### 13. `docs/runbooks/alert-playbook.md` (new) — on-call response

Required sections (grep-checkable headings):
1. `## Alert triage` — high-level decision tree (severity → action).
2. `## Per-rule playbooks` — one subsection per 5 alert rules with diagnosis + remediation.
3. `## Cooldown and dedupe` — how `alert_history` prevents noise; when to manually resolve.
4. `## Channel debugging` — how to test webhook / Slack / Telegram delivery via `alert.fire` MCP tool.

### 14. Tests (5 new files; no existing test touched)

- **`src/tests/alert-rules.test.ts`** — ≥ 4 cases: valid schema / operator enum / severity enum / missing-file fallback.
- **`src/tests/alert-evaluator.test.ts`** — ≥ 5 cases: firing / pending / resolved / metric null (skipped) / operator branches (>, <, >=, <=).
- **`src/tests/alert-history.test.ts`** — ≥ 4 cases: insert record / cooldown block / cooldown expire / Postgres-stub no-op.
- **`src/tests/alert-scheduler.test.ts`** — ≥ 3 cases: `start()` fires → `tick()` calls evaluator + dispatcher; cooldown de-dupes consecutive ticks; `stop()` idempotent.
- **`src/tests/alert-channels.test.ts`** — ≥ 5 cases: webhook happy path (stub `globalThis.fetch`) / webhook retry on 503 / webhook fail after 3 retries returns error / Slack payload shape / Telegram payload shape.

## Out of scope — do NOT touch

- `src/reconciliation/**` / `src/monitoring/vega-metrics.ts` / `metrics-fingerprint.ts` / `metrics.ts` / `dashboards/**`
- `src/scheduler/**` (entire directory; AlertScheduler is self-managed in `src/alert/scheduler.ts`)
- `src/notify/**` (NOT extended here; alert channels live in `src/alert/channels/`)
- `src/sunset/**` (13a sealed)
- `src/retrieval/**` (12a/12b sealed)
- `src/db/migrations/**` (inline DDL helper pattern in `src/alert/history.ts`, no new migration file)
- `src/core/contracts/**`
- All prior batch Out-of-scope files
- All existing `src/tests/*.test.ts` (only 5 new `alert-*.test.ts` files allowed)

## Forbidden files

- `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/retrieval/**`, `src/reconciliation/**`, `src/monitoring/vega-metrics.ts`, `src/monitoring/metrics-fingerprint.ts`, `src/monitoring/metrics.ts`, `dashboards/**`, `src/db/migrations/**`, `src/core/contracts/**`
- All pre-existing `src/tests/*.test.ts` files
- Root-level markdown files
- `docs/**` except this brief + the 3 new alert docs

## Forbidden patterns (Wave 5 全程继续)

- Production 代码不得嗅探测试环境
- 测试不得实际发 HTTP 请求（必须 stub `globalThis.fetch`；channels 测试通过 mock fetch 验证 request shape + URL + body）
- 测试不得触碰 macOS 真实钥匙串 / 真实 HOME / 真实 user config
- 不 amend `8d5294c` / `dc85821`；新起 commit
- Alert scheduler 用 `setInterval`（禁 fs.watch / chokidar / fsevents）
- Channel `send()` 永不抛；错误返 `{status: "error", message}`
- No auto-delete of rules / channels; scheduler only fires + records + dispatches

## Acceptance criteria

1. 2 新 docs/alerts 文件：`docs/alerts/alert-rules.yaml` (starter 含 5 rules) + `docs/alerts/channels.yaml` (空 starter)；`grep -c "^  - id:" docs/alerts/alert-rules.yaml` = 5
2. 8 新 src/alert 文件：`rules.ts` / `evaluator.ts` / `history.ts` / `scheduler.ts` / `index.ts` / `channels/{webhook,slack,telegram,index}.ts`
3. `grep -nE 'setInterval' src/alert/scheduler.ts` ≥ 1；`grep -nE 'fs\.watch|chokidar|fsevents' src/alert/` 零命中
4. `grep -nE 'parsed\s*>\s*0' src/alert/scheduler.ts` ≥ 2 (interval + cooldown env guards)
5. `grep -nE 'if\s*\(\s*db\.isPostgres\s*\)' src/alert/history.ts` ≥ 1 (internal Postgres guard, 12a.1 pattern)
6. `grep -nE 'alert\.(check|fire)' src/mcp/server.ts` ≥ 2
7. `docs/runbooks/alert-playbook.md` 存在，4 个 section heading 各 ≥ 1
8. 5 个新 alert-*.test.ts 文件各存在，test case 总 ≥ 21 (4+5+4+3+5)
9. `git diff HEAD --name-only -- src/` 仅涉及 `src/alert/**` + `src/mcp/server.ts` + 可选 `src/api/server.ts` + 5 个新 test 文件
10. `git diff HEAD -- src/scheduler/ src/notify/ src/sunset/ src/retrieval/ src/reconciliation/ src/monitoring/vega-metrics.ts src/monitoring/metrics-fingerprint.ts src/monitoring/metrics.ts dashboards/ src/db/migrations/ src/core/contracts/` 输出为空
11. `git diff HEAD -- src/tests/` 仅显示 5 个新 alert-*.test.ts；其他 test 文件零变动
12. `set -o pipefail; npm run build` 成功；`set -o pipefail; npm test` 全绿（预期 ≥ 1099 pass）
13. 严格**不 amend** `8d5294c` / `dc85821`；新起 commit
14. Commit title 前缀 `feat(alert):`
15. Commit body:
    ```
    Ships the alert system framework P8-035.1-.4:
    - docs/alerts/alert-rules.yaml (5 starter rules aligned with Dashboard core
      5: retrieval_coverage_low / usage_ack_sufficiency_low / circuit_breaker_open
      / raw_inbox_backlog_high / raw_inbox_oldest_age_high) + docs/alerts/
      channels.yaml (empty secret-free starter).
    - src/alert/{rules,evaluator,history,scheduler,index}.ts with zod-validated
      schemas, threshold evaluator, SQLite alert_history table (inline DDL like
      reconciliation_findings; Postgres-safe via internal isPostgres guard),
      self-managed setInterval scheduler (60s default, VEGA_ALERT_CHECK_INTERVAL_MS
      env with parsed > 0), dispose()-style stop(), 30min cooldown dedupe.
    - src/alert/channels/{webhook,slack,telegram,index}.ts: single HTTP transport
      (webhook), Slack + Telegram as payload wrappers. Retry 3 attempts (1/3/10s
      backoff) on 5xx/network. send() returns {status:"ok"} | {status:"error",
      message:"..."}, never throws.
    - Two new MCP tools: alert.check (evaluate rules → evaluations[]) and
      alert.fire (manual fire for testing delivery); both handle missing/
      parse_error paths as degraded.
    - Lifecycle wiring in src/api/server.ts + src/mcp/server.ts mirrors 12b/13a
      (VEGA_ALERT_SCHEDULER_ENABLED env gate, dispose-on-shutdown).
    - docs/runbooks/alert-playbook.md: triage / per-rule playbooks / cooldown /
      channel debugging via alert.fire.
    - 5 new alert-*.test.ts files with ≥ 21 cases. Tests stub globalThis.fetch
      for channel coverage — no real HTTP.

    Scope: scheduler self-managed in src/alert/, zero touches to src/scheduler/.
    Alert history uses inline DDL pattern — no new migration file. Secrets live
    in docs/alerts/channels.yaml with ${VAR} env-expansion support.

    Scope-risk: low
    Reversibility: clean (rules can be disabled via removal from YAML; scheduler
    honors VEGA_ALERT_SCHEDULER_ENABLED=false opt-out)
    ```

## Review checklist

- 5 alert rules 是否对齐 Dashboard 核心 5 指标？（rule ID 匹配到实际 vega_* metric）
- Channel `send()` 是否捕获所有异常返 `{status: "error"}` 不抛？
- Webhook retry 逻辑是否 only on 5xx / network，不 retry 4xx？
- Tests 是否全部 stub `globalThis.fetch`？（grep `globalThis.fetch` 或 `jest.spyOn`-style 取决实现）
- SQLite migration helper 是否 `if (db.isPostgres) return;` 作为第一条语句？
- Scheduler 是否 `src/alert/scheduler.ts` 而非 `src/scheduler/`？
- 新 MCP tool 只 2 个注册（`alert.check` + `alert.fire`）？
- 5 个新 test 文件是否全 hermetic（mkdtempSync tmp HOME + mock fetch + `:memory:` SQLite）？
- 新 commit 叠 `dc85821` 下方，不 amend？

## Commit discipline

- 单 atomic commit，新起
- 前缀 `feat(alert):`
- body 按 Acceptance #15
- 不创建 root-level markdown / 其他 docs 除 `docs/alerts/*.yaml` + `docs/runbooks/alert-playbook.md`
