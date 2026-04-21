# Batch 33a — Soft signal hardening: Telegram/Slack Markdown escape + URL scheme validation + L3 session-start SQLite bug

## Context

Phase 8 audit flagged 4 soft signals that weren't hard enough for issue filing:

1. **Telegram `parse_mode: "Markdown"` payload escaping** — special chars `*_[]()~`\\` etc. in alert text can break Telegram rendering or raise `Bad Request: can't parse entities`. Both `src/notify/telegram.ts` and `src/alert/channels/telegram.ts` are suspected sites.
2. **Alert webhook / slack URL scheme validation** — `src/alert/channels/webhook.ts` + `slack.ts` accept any URL string with no scheme / target restriction. Security: hostile config could point at an internal admin URL. Also no rejection of `http://` vs `https://` on public hosts.
3. **L3 session-start SQLite `no such column: 8`** — `vega session-start --mode L3 --json` raises this SQLite error on fresh invocation. Likely a parametrized query where placeholder position 8 exceeds the query's parameter count. Cause unknown without investigation.

This batch fixes what's fixable with minimal scope; signals that require deeper investigation get filed as new issues.

No amend — new commit on HEAD (parent = `706824c`).

## Scope

### 1. Telegram + Slack Markdown escape

#### 1a. Triage: which Telegram/Slack file is active?

`rg -n "parse_mode" src/` to find the call sites. Possible locations:
- `src/notify/telegram.ts` (14a / older channel)
- `src/alert/channels/telegram.ts` (14a)
- `src/alert/channels/slack.ts` (14a, Markdown mode likely)

Both Telegram files exist; investigate which is actually wired in production `NotificationManager`. Fix only that path (or both if both are reachable).

#### 1b. Escape helper

Add a tiny escape function. Telegram's MarkdownV2 requires escaping `_*[]()~\`>#+-=|{}.!`. Slack Markdown has different rules but `*_~<>` minimum.

```ts
// src/notify/telegram.ts (or src/alert/channels/telegram.ts — pick actual site)

function escapeTelegramMarkdown(text: string): string {
  // Escape special chars per Telegram MarkdownV2 spec
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// In send(...) before POST:
body: JSON.stringify({
  chat_id: this.#chatId,
  text: escapeTelegramMarkdown(message),
  parse_mode: "MarkdownV2"
})
```

OR simpler: drop `parse_mode` entirely when message contains any special chars. Let Telegram render as plain text. This is the safest minimum-scope fix.

```ts
// Plain-text fallback pattern:
const unsafe = /[_*\[\]()~`>#+\-=|{}.!\\]/.test(message);
body: JSON.stringify({
  chat_id: this.#chatId,
  text: message,
  ...(unsafe ? {} : { parse_mode: "Markdown" })
})
```

Pick the simpler plain-text fallback unless existing tests specifically assert formatted output.

#### 1c. Slack equivalent

For Slack Markdown (`mrkdwn: true` or default), escape `&`, `<`, `>` per Slack spec. Simpler approach: HTML-entity-encode these 3 chars before sending.

```ts
function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

Apply to message body before POST.

### 2. URL scheme validation

#### 2a. Webhook

`src/alert/channels/webhook.ts` — in the constructor or `send(...)` method, add:

```ts
function validateWebhookUrl(raw: string): string {
  const url = new URL(raw);  // throws on invalid URL
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`unsupported protocol: ${url.protocol}`);
  }
  // Reject internal admin paths (loose heuristic)
  const bannedHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
  if (url.protocol === "http:" && !bannedHosts.has(url.hostname)) {
    throw new Error(`plain http not allowed for non-loopback: ${url.hostname}`);
  }
  return raw;
}
```

Call at construction time. If URL is invalid, throw early — webhook channel won't activate.

#### 2b. Slack

Same pattern in `src/alert/channels/slack.ts` — slack webhook URLs are `https://hooks.slack.com/...` so tight https-only is appropriate.

### 3. L3 session-start SQLite bug — investigate + triage

#### 3a. Reproduce

Run `vega session-start --dir /tmp --mode L3 --json` (or equivalent harness). Observe which SQL query throws. Likely suspects:
- `src/session/` (if exists)
- `src/api/routes.ts` session handler
- `src/mcp/server.ts` session tool

Find the query with ≥ 8 `?` placeholders where only 7 (or fewer) values are supplied. Or `$8` named parameter without binding.

#### 3b. Fix if straightforward

If the bug is a simple off-by-one (missing placeholder binding), fix in the query-site file. Add a regression test that calls the session-start path with mode=L3 and asserts no SQL error.

#### 3c. Defer if not straightforward

If the bug touches sealed areas (e.g. reconciliation, monitoring) OR requires >1 file fix >20 lines, DO NOT force-fix in this batch. Instead:
- Open a new GitHub issue via `gh issue create` documenting the reproduction + symptom + suspected code path
- Include this new issue in the commit body's "Deferred" section

## Out of scope — do NOT touch

- Everything outside the following allowed files
- `src/notify/manager.ts` (internal state machine; don't touch)
- `src/notify/alert-file.ts` (14a sealed)
- `src/reconciliation/**` except maybe alert-dispatcher.ts (B8)
- `src/monitoring/**`, `src/backup/**`, `src/promotion/**`, `src/db/**`, `src/wiki/**`, `src/retrieval/**`, `src/feature-flags/**`, `src/sdk/**`, `src/api/**` (only if L3 bug site requires minimal touch)
- `.eslintrc.cjs`, `package.json`, all briefs except this one

Allowed:
- `src/notify/telegram.ts` OR `src/alert/channels/telegram.ts` (fix only the active one; add escape + plain-text fallback)
- `src/alert/channels/slack.ts`
- `src/alert/channels/webhook.ts`
- `src/alert/channels/telegram.ts` (if different from `src/notify/telegram.ts`)
- `src/tests/notify-telegram-escape.test.ts` (new, if needed)
- `src/tests/alert-url-validation.test.ts` (new)
- For L3 bug: the one query-site file IF the fix is ≤ 20 lines; otherwise file issue
- This brief file (document the triage result + any deferred follow-up)

## Forbidden patterns

- Tests MUST NOT send real alerts (stub fetch)
- NO amend of prior commits — new commit on HEAD (parent = `706824c`)
- Escape functions MUST be tested (don't trust first-try regex)
- URL validation MUST throw (not silently skip) at construction time
- If L3 bug is deferred, commit body + new GH issue MUST document the observed symptom + reproduction command

## Acceptance criteria

1. `rg -nE "escape(Telegram|Slack|Markdown)" src/notify/ src/alert/channels/` ≥ 2 (both channels have escape helper)
2. `rg -nE "new URL\\(|protocol !== " src/alert/channels/webhook.ts src/alert/channels/slack.ts` ≥ 2 (URL validation present on both)
3. For L3 bug: either (a) regression test exists in `src/tests/session-start-mode-l3.test.ts` AND asserts no SQL error, OR (b) a new GH issue exists (not checked programmatically; verify via commit body mention)
4. Tests for escape + URL validation: new files exist; combined `rg -c "^test\\(" ...` ≥ 4 cases
5. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1260 pass / 0 fail (1256 + ≥ 4 new)
6. `npm run lint:readonly-guard` exits 0
7. Not-amend; parent of new commit = `706824c`
8. Commit title prefix `fix(notify):` OR `fix(alert):`
9. Commit body:
    ```
    Harden soft signals from Phase 8 audit.

    - src/notify/telegram.ts (or src/alert/channels/telegram.ts):
      unsafe markdown chars trigger plain-text fallback (parse_mode
      omitted) rather than MarkdownV2 parse error. Prevents Telegram
      API "can't parse entities" when alert text contains _, *, [, etc.
    - src/alert/channels/slack.ts: HTML-entity escape of &, <, > per
      Slack spec before POST; URL validated at construction (https
      only).
    - src/alert/channels/webhook.ts: URL scheme validation at
      construction time — https required for non-loopback hosts;
      malformed URLs throw early.
    - L3 session-start SQLite "no such column: 8": [either]
      [fixed in <file>:<line>] OR [deferred — filed as #NN with
      reproduction details].

    Tests:
    - notify-telegram-escape.test.ts covers unsafe-char fallback.
    - alert-url-validation.test.ts covers valid/invalid URL cases
      for slack + webhook.

    Scope: notify + alert channels. Zero touches to sealed modules.

    Scope-risk: low
    Reversibility: clean
    ```

## Review checklist

- Telegram path: plain-text fallback triggers on any of `_*[]()~\`>#+-=|{}.!`?
- Slack escape covers at minimum `&<>`?
- URL validation throws on construction (not silent)?
- URL validation blocks `http://` for non-loopback hosts?
- L3 bug: either regression test exists OR issue is filed with reproduction steps?
- Tests stub real HTTP (no real Telegram / webhook)?
- New commit stacks on `706824c` (not amend)?

## Commit discipline

- Single atomic commit
- Prefix `fix(notify):` OR `fix(alert):` (codex picks based on which dominates)
- Body per Acceptance #9
- Files changed: 2-3 channel files + 1-2 test files. Possibly 1 L3-bug fix file OR 1 new GH issue filed.

## Triage result

- `src/notify/telegram.ts` is live through `NotificationManager`.
- `src/alert/channels/telegram.ts` and `src/alert/channels/slack.ts` are both runtime-reachable through the alert-channel loader, so both paths were hardened.
- The L3 reproduction in this repo converged on mixed alphanumeric FTS terms such as `Batch 25a completed`, not a placeholder-count bug. The minimal repo fix point is `src/db/fts-query-escape.ts`.
