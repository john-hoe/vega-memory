# Batch 10a.4 — Plug the last keychain leak in scheduler test

## Problem
Round-2 review 发现 `df0f916` 只修了 1/3 的 `dailyMaintenance` 调用点。`src/tests/scheduler.test.ts:285` 的 RSS/wiki 维护测试仍不传 `resolveEncryptionKey`，于是走默认 `??` fallback 到 `resolveConfiguredEncryptionKey(config)`，在 macOS 上可能间接读真实 Vega 钥匙串。

## Scope
Exactly one file, one addition:
- `src/tests/scheduler.test.ts`：找到约 line 285 的 `dailyMaintenance(...)` 调用（options 对象现在只含 `rssService: { listFeeds: [...] }`），在 options 对象里追加一行 `resolveEncryptionKey: async () => undefined`
- 保留 `rssService` 和其他现有字段不变，只是追加
- 不改其他两个已正确的调用点（line 219、line 453）

## Out of scope
- 其他任何文件都不动
- `src/scheduler/tasks.ts` 不动（DI seam 已在 df0f916 里落好）
- 其他 scheduler.test.ts 内容不动

## Forbidden files
- 除 `src/tests/scheduler.test.ts` 外所有文件
- 任何 markdown / 根目录文档

## Acceptance criteria
1. `grep -nE 'dailyMaintenance\s*\(' src/tests/scheduler.test.ts` 列出的每个调用点往后 5 行内都包含 `resolveEncryptionKey`
2. `git diff HEAD -- src/tests/scheduler.test.ts | wc -l` 应为**极少行**（仅 1 行添加 + 上下文 patch 格式行，总改动预期 < 10 行）
3. `git diff HEAD` 只涉及 `src/tests/scheduler.test.ts` 一个文件
4. `npm run build` 成功退出；`npm test` 全绿
5. 新 commit 叠在 `df0f916` 上，不 amend
6. Commit title 前缀 `test(scheduler):` 或 `fix(scheduler):`
7. Commit body：
   ```
   Closes Round-2 finding on df0f916. The RSS/wiki maintenance test at
   scheduler.test.ts:285 was the last dailyMaintenance call site missing
   an injected resolveEncryptionKey, which meant it still fell back to
   resolveConfiguredEncryptionKey(config) and could read the real macOS
   keychain on darwin hosts. Blanket-inject async () => undefined there.

   Scope-risk: none
   Reversibility: clean
   ```

## Review checklist
- 是不是**只**动了那一个调用点的 options？
- 有没有顺手改其他测试或 production 代码？
- commit 是新起的（不 amend df0f916）？

## Commit discipline
- 单 atomic commit，新起
- 不创建 markdown / 根目录文档
