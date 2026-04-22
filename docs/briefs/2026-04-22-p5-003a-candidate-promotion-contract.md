# P5-003a — Candidate / Promotion Contract 收敛

## 这批只做什么

只做 `P5-003` 的第一步：

- 把 candidate / dedup / value judgment / promotion / promoted 的边界写清楚
- 不改产品代码

## 这批不做什么

不做：

- retrieval API
- usage.ack
- ranking 反馈回路
- runtime 过滤实现
- 真正的代码改造

## 输入基线

以当前仓库里的现状为准：

- `/Users/johnmacmini/workspace/vega-memory/src/db/candidate-repository.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/db/candidate-memory-migration.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/policy.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/evaluator.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/orchestrator.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/audit-store.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/calculatePromotionScore.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/retrieval/sources/promoted-memory.ts`

## 交付物

### 1. 总说明文档

文件：

- `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-003-candidate-promotion-v1.md`

必须讲清楚：

- candidate 是什么
- dedup 的两层含义
- value judgment 该怎么定位
- promotion 只负责什么
- promoted 先定义到什么程度

### 2. 现状对照

文档里要直接指出：

- 现在 `candidate-repository.ts` 已经提供了什么
- 现在真实的 candidate 状态是 `pending / held / ready / discarded`
- `policy / evaluator / orchestrator` 分别已经承担了什么
- `promotion-audit-store.ts` 已经承担了什么
- `calculatePromotionScore.ts` 只是局部 helper，不等于整套 value judgment 已经定稿
- `promoted-memory source` 说明当前 promoted 已经进入 retrieval 输入面
- 哪些部分属于现有代码已经覆盖
- 哪些部分仍然需要 Phase 5 后续任务去补齐

## 验收标准

- artifact:
  - `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-003-candidate-promotion-v1.md`
- command:
  - `test -f /Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-003-candidate-promotion-v1.md`
- assertion:
  - 文档里必须明确出现这些意思：
    - candidate 是待判断层
    - 当前 candidate 基线状态是 `pending / held / ready / discarded`
    - `raw_dedup_key` 和 `semantic_fingerprint` 不是一回事
    - 这两个去重概念现在还是 Phase 5 需要收清的目标，不是假装当前代码里已经完整存在
    - value judgment 是 Vega 的责任
    - 当前 promotion 已经有 `policy / evaluator / orchestrator / audit` 基线
    - promotion 不等于 dedup，也不等于 retrieval
    - promoted retrieval API 不属于本批
    - usage.ack 不属于本批
- output:
  - 一份能直接指导后续 `P5-003.* / P5-005.* / P5-006.* / P5-007.*` 任务继续写 spec/brief 的总说明，并且口径和当前代码一致

## 建议写法

写法要求：

- 继续说人话
- 重点讲边界
- 不搞大而全

## 完成标志

这份文档写完后，下一步才能继续：

- `P5-003.a`
- `P5-003.b`
- `P5-003.c`
- `P5-003.d`
- `P5-006`
- `P5-007`

也就是先把主链说清楚，再落到 scoring 和 promotion。
