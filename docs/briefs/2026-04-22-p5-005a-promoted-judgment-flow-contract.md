# P5-005a — Promoted / Value Judgment / Promotion Flow 收敛

## 这批只做什么

只做 `P5-005 / P5-006 / P5-007` 的第一步：

- 把 promoted 的现状落点写清楚
- 把 value judgment 的现状和边界写清楚
- 把 promotion flow 已经做到哪一步写清楚
- 不改产品代码

## 这批不做什么

不做：

- retrieval API
- ranking 反馈回路
- usage.ack
- visibility runtime filtering
- 真正的 promotion 代码重构

## 输入基线

以当前仓库里的现状为准：

- `/Users/johnmacmini/workspace/vega-memory/src/db/repository.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/core/types.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/policy.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/evaluator.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/orchestrator.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/audit-store.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/calculatePromotionScore.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/retrieval/sources/promoted-memory.ts`

## 交付物

### 1. 总说明文档

文件：

- `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-005-007-promoted-judgment-flow-v1.md`

必须讲清楚：

- 当前 promoted 实际落在哪里
- 当前 value judgment 已经有什么
- 当前 promotion flow 怎么跑
- 哪些是已经完成的基线
- 哪些还是 Phase 5 后续要补的规则

### 2. 现状对照

文档里要直接指出：

- 当前 promoted 不是独立表，而是通用 `memories` 行
- `createFromCandidate()` / `demoteToCandidate()` 已经提供了 promotion 主链
- `policy / evaluator / orchestrator / audit` 已经形成现有基线
- `calculatePromotionScore.ts` 只是局部 helper，不等于 value judgment 已经完全定稿
- `promoted-memory.ts` 说明 promoted 已经进入 retrieval 输入面
- visibility / retention 现在还主要是规则层问题，不是说 runtime filtering 已经完工

## 验收标准

- artifact:
  - `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-005-007-promoted-judgment-flow-v1.md`
- command:
  - `test -f /Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-005-007-promoted-judgment-flow-v1.md`
- assertion:
  - 文档里必须明确出现这些意思：
    - 当前 promoted 不是独立表，而是正式 memory store 的一部分
    - current promotion 已经有 `policy / evaluator / orchestrator / audit`
    - `calculatePromotionScore.ts` 只是局部 helper
    - `createFromCandidate()` 和 `demoteToCandidate()` 已经构成 promotion 主链
    - promoted retrieval API 不属于本批
    - usage.ack 不属于本批
- output:
  - 一份能直接指导后续 `P5-005.* / P5-006.* / P5-007.*` 继续拆和继续写 brief 的总说明

## 建议写法

写法要求：

- 继续说人话
- 明确“现在已经有什么”
- 明确“还缺什么”
- 不要假装当前代码是 greenfield

## 完成标志

这份文档写完后，下一步才能继续：

- `P5-005.a`
- `P5-005.a.1`
- `P5-005.a.2`
- `P5-006`
- `P5-007`

也就是先把 promoted / judgment / promotion 这一组真实边界收清，再继续拆叶子任务。
