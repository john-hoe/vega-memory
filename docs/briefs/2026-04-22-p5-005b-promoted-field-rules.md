# P5-005b — Promoted Field Rules 收敛

## 这批只做什么

只做 `P5-005` 的细化文档：

- 把 promoted 当前到底落在哪写清楚
- 把哪些字段属于正式 promoted 落点写清楚
- 把哪些 promotion 信息不该塞进主表写清楚

## 这批不做什么

不做：

- retrieval API
- visibility runtime filtering
- retention cleanup job
- 任何产品代码改造

## 输入基线

- `/Users/johnmacmini/workspace/vega-memory/src/db/repository.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/core/types.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/retrieval/sources/promoted-memory.ts`
- `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-005-007-promoted-judgment-flow-v1.md`

## 交付物

- `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-005-promoted-field-rules.md`

## 验收标准

- artifact:
  - `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-005-promoted-field-rules.md`
- command:
  - `test -f /Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-005-promoted-field-rules.md`
- assertion:
  - 文档里必须明确出现这些意思：
    - promoted 现在不是独立表
    - promoted 当前落在正式 `memories`
    - promotion audit 不该塞进 memory 主表
    - candidate 过程信息不该抄进 promoted 主表
    - visibility / retention 先收规则，不做 runtime 实现
    - promoted retrieval API 不属于本批
- output:
  - 一份能直接指导后续 `P5-005.a.1 / P5-005.a.2` 的字段和规则说明

## 完成标志

这份文档写完后，后面才好继续拆：

- promoted 字段规则
- visibility 规则
- retention 分类
