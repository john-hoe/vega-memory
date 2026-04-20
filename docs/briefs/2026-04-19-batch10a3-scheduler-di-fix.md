# Batch 10a.3 — Replace keychain manipulation in scheduler test with DI

## Problem
Commit `db4c93d` 为了让 scheduler 测试在 macOS 上稳定产出 `.db`（非 `.db.enc`）备份文件，在 `src/tests/scheduler.test.ts` 里加了真实读/删/恢复 macOS 钥匙串的代码。**风险**：测试期间临时删除用户真实 Vega 加密 key；`kill -9` / macOS security 对话框超时 / 并发测试 / uncaught 异常绕 finally 都可能让用户**永久丢 key**。

根因：`src/scheduler/tasks.ts:274` 在 `dailyMaintenance` 内部无条件调 `resolveConfiguredEncryptionKey(config)`，没有 DI 口子让测试 mock 掉。

## Scope

### 1. Production — 给 `dailyMaintenance` 加 DI 口子（`src/scheduler/tasks.ts`）
- 在现有 options 类型里追加一个可选字段：
  ```ts
  resolveEncryptionKey?: (config: VegaConfig) => Promise<string | undefined>;
  ```
- 函数体把 line 274 的 `await resolveConfiguredEncryptionKey(config)` 替换为：
  ```ts
  await (options.resolveEncryptionKey ?? resolveConfiguredEncryptionKey)(config)
  ```
- 默认行为**完全保留**：不传 `resolveEncryptionKey` 时，`??` 右侧 fallback 仍是 `resolveConfiguredEncryptionKey`，跟现状字节级一致
- 不动其他函数 / 不改 `import` 列表除非必要 / 不改 `resolveConfiguredEncryptionKey` 自身签名

### 2. Test — 干净 revert + 用 DI no-op（`src/tests/scheduler.test.ts`）
- 删除 `db4c93d` 引入的 3 处 keychain 操作：
  - 约 line 195-198：`const originalKey = ... getKey(...)`
  - 约 line 222-225：`await deleteKey(...)`
  - 约 line 241-248：`finally` 里的 `deleteKey` / `setKey` 分支
- 删除对应的 import：`getKey` / `setKey` / `deleteKey` / `VEGA_KEYCHAIN_SERVICE` / `VEGA_ENCRYPTION_ACCOUNT`（只要是 `db4c93d` 新加的都删）
- 在调用 `dailyMaintenance({...})` 的地方传入：
  ```ts
  resolveEncryptionKey: async () => undefined
  ```
- 所有 `process.platform === "darwin"` 条件块全部删除（现在跨平台 hermetic 不再需要判断）
- `dbEncryption: false` **保留**（10a.2 已打进去的，别动）
- `.db` 严格 regex **保留**（10a.2 已改回的，别动）

## Out of scope — do NOT touch
- `src/security/keychain.ts`（不动，现有 `resolveConfiguredEncryptionKey` 不改签名 / 不改行为）
- `src/config.ts` / `src/core/integration-surface-status.ts` / `src/cli/commands/doctor.ts`（continue revert-locked from 10a.1）
- `src/monitoring/**`（metrics 层全部不动）
- `src/retrieval/**` / `src/usage/**` / `src/api/server.ts`（不动）
- 其他 scheduler 函数（`refreshWikiProjection` / `pollAllFeeds` / `weeklyHealthReport` / `monitorOllamaAvailability` / `backfillSummaries` 不改）
- 其他测试文件（`src/tests/metrics-*.test.ts` / `config.test.ts` / `doctor.test.ts` 不动）
- DB schema / contracts / docs / root-level markdown / 本 brief

## Forbidden patterns（Wave 5 全程继续）
- Production 代码不得嗅探测试环境
- Production 代码不得分支走"只在测试生效"
- 测试**严禁**触碰 macOS 真实钥匙串、真实用户 HOME、真实用户 config 文件等 OS-level 全局状态；隔离只能靠 DI / 参数注入 / mock

## Acceptance criteria
1. `grep -nE 'getKey|setKey|deleteKey|VEGA_KEYCHAIN_SERVICE|VEGA_ENCRYPTION_ACCOUNT' src/tests/scheduler.test.ts` 返回空（import 和调用全清）
2. `grep -nE 'process\.platform === "darwin"' src/tests/scheduler.test.ts` 返回空（无平台判断）
3. `grep -nE 'resolveEncryptionKey' src/scheduler/tasks.ts` 至少返回 2 处：option 类型定义 + 调用点使用；**同时** `grep -nE 'resolveConfiguredEncryptionKey\(config\)' src/scheduler/tasks.ts` 仍返回 1 处（作为 `??` 右侧默认 fallback），确认 production 默认行为字节级保留
4. `grep -nE 'resolveEncryptionKey: async \(\) => undefined' src/tests/scheduler.test.ts` 返回 ≥ 1 处
5. `git diff HEAD -- src/security/keychain.ts` 为空（没动）
6. `git diff HEAD -- src/config.ts src/core/integration-surface-status.ts src/cli/commands/doctor.ts src/monitoring/vega-metrics.ts src/monitoring/metrics.ts src/retrieval/circuit-breaker.ts` 全部为空（其他文件没动）
7. `dailyMaintenance` 现有 production callers（如果有）**不需要修改**就能编译通过 —— 即新增字段必须是 optional，默认行为与现状一致
8. `npm run build` 成功退出；`npm test` 全绿（具体测试数不做死约束，以 pass/fail 计数为准）
9. 严格**不 amend** commit `db4c93d`，新起 commit 在其上
10. Commit title 前缀 `fix(scheduler):` 或 `refactor(scheduler):`
11. Commit body 必须包含：
    ```
    Replaces keychain manipulation in scheduler.test.ts (introduced in
    db4c93d) with a DI seam on dailyMaintenance(). The test no longer
    reads, deletes, or restores the user's real macOS keychain; it now
    passes `resolveEncryptionKey: async () => undefined` to skip the
    keychain read entirely.

    Production behavior is preserved: when the caller omits the new
    optional option, dailyMaintenance still calls
    resolveConfiguredEncryptionKey(config) exactly as before.

    Scope-risk: low
    Reversibility: clean
    ```

## Review checklist
- scheduler/tasks.ts 的 DI 字段是否 optional + 默认调 `resolveConfiguredEncryptionKey`（行为 100% 保留）？
- `??` 右侧 fallback 是否真的是 `resolveConfiguredEncryptionKey` 而不是别的（例如被换成 `async () => undefined`）？
- scheduler.test.ts 里是否 **任何** keychain 相关 import / 调用 / `process.platform` 判断都消失了？
- 新 commit 是否在 `db4c93d` 下方（`git log --oneline -3`）而非 amend？
- 其他文件是否零变动（用 diff 严格核）？
- Forbidden patterns 是否被触犯（例如 codex 会不会又悄悄给别处加嗅探）？

## Commit discipline
- 单 atomic commit，新起，不 amend
- 前缀 `fix(scheduler):` 或 `refactor(scheduler):`
- body 按 Acceptance #11 模板
- 不创建 markdown / root-level 文档
