# P6-008 实现 promoted memory retrieval API

- Wave: 6B Vega Retrieval Orchestration
- Group: B 检索编排
- Priority: P0
- Value: 高
- Depends on: P6-001, P6-002, P6-003
- Type: implementation

## Context

在 Host-side Retrieval Workflow、Vega orchestration 和 token guardrails 已收口后，交付真正可调用的 promoted memory retrieval API。

## Acceptance Criteria

- **Artifact**: `src + tests + docs for promoted memory retrieval API surface`
- **Command**: `npm run build && npm test`
- **Assertion**: 实现同时覆盖 API surface、wiring 和测试验证，且构建与测试全绿。
- **Output**: `promoted memory retrieval API 以 HTTP/MCP/CLI 约定之一落地，并与 Phase 6 contract 对齐。`

## Steps

1. 按 P6-001 contract 暴露 retrieval request / bundle 返回面
2. 按 P6-002 / P6-003 落 retrieval orchestration 与 token guardrails wiring
3. 补测试与文档，验证 API surface 与 retrieval contract 对齐

## Verification

```bash
npm run build
npm test
```
