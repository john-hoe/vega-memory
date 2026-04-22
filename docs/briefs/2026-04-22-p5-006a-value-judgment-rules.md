# P5-006a — Value Judgment Rules 收敛

## 这批只做什么

只做 `P5-006` 的细化文档：

- 把当前 value judgment 已有的规则写清楚
- 把 policy / evaluator / score helper 的边界写清楚
- 不改产品代码

## 这批不做什么

不做：

- 新的打分算法实现
- retrieval ranking 反馈
- usage.ack 闭环
- 宿主侧规则下沉

## 输入基线

- `/Users/johnmacmini/workspace/vega-memory/src/promotion/policy.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/evaluator.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/calculatePromotionScore.ts`
- `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-005-007-promoted-judgment-flow-v1.md`

## 交付物

- `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-006-value-judgment-rules.md`

## 验收标准

- artifact:
  - `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-006-value-judgment-rules.md`
- command:
  - `test -f /Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-006-value-judgment-rules.md`
- assertion:
  - 文档里必须明确出现这些意思：
    - 当前正式规则里已经有 manual / age / ack
    - evaluator 是收上下文，不是自己发明规则
    - `calculatePromotionScore.ts` 只是局部 helper
    - value judgment 需要能解释结果
    - usage.ack 闭环不属于本批
- output:
  - 一份能直接指导后续 `P5-006.a / P5-006.b` 的规则说明

## 完成标志

这份文档写完后，后面才好继续拆：

- 正式判断信号
- 解释规则
- 配置边界
