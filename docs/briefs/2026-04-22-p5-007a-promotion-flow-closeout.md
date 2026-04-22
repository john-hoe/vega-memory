# P5-007a — Promotion Flow Closeout 收敛

## 这批只做什么

只做 `P5-007` 的细化文档：

- 把 promote / hold / discard / demote 这条主线写清楚
- 把 id 复用和 audit 这两个硬边界写清楚
- 不改产品代码

## 这批不做什么

不做：

- retrieval API
- ranking feedback
- usage.ack
- 运行时外围集成

## 输入基线

- `/Users/johnmacmini/workspace/vega-memory/src/db/repository.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/orchestrator.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/audit-store.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/tests/db-repository-promotion.test.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/tests/promotion-orchestrator.test.ts`
- `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-005-007-promoted-judgment-flow-v1.md`

## 交付物

- `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-007-promotion-flow-closeout.md`

## 验收标准

- artifact:
  - `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-007-promotion-flow-closeout.md`
- command:
  - `test -f /Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-007-promotion-flow-closeout.md`
- assertion:
  - 文档里必须明确出现这些意思：
    - 当前 promotion flow 已经存在真实主线
    - promote 会进入正式 `memories`
    - demote 会把同一个 id 放回 candidate
    - audit 是主线组成部分
    - retrieval API 和 usage.ack 不属于本批
- output:
  - 一份能直接指导后续 `P5-007.a / P5-007.b` 的流程说明

## 完成标志

这份文档写完后，后面才好继续拆：

- promotion 动作边界
- audit 规则
- lineage 规则
