# P5-002a — Layered Ingestion Contract 收敛

## 这批只做什么

只做 `P5-002` 的第一步：

- 把 `raw_inbox / candidate / promoted` 三层边界写清楚
- 把 ingestion 主线写清楚
- 不改产品代码

## 这批不做什么

不做：

- retrieval API
- usage.ack
- visibility runtime filtering
- promotion 具体实现
- 值得分算法实现

## 输入基线

以当前仓库里的现状为准：

- `/Users/johnmacmini/workspace/vega-memory/src/ingestion/raw-inbox.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/ingestion/ingest-event-handler.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/db/candidate-repository.ts`

## 交付物

### 1. 总说明文档

文件：

- `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-002-layered-ingestion-v1.md`

必须讲清楚：

- 为什么只保留 3 层
- 每层负责什么
- raw_inbox 保存什么，不保存什么
- candidate 和 promoted 的角色区别
- ingestion pipeline 的主线

### 2. 现状对照

文档里要直接指出：

- 当前 `raw-inbox.ts` 已经实现了哪些基础能力
- 当前 `ingest-event-handler.ts` 已经做到哪一步
- 当前 `candidate-repository.ts` 代表了哪一层
- 哪些东西属于已有基线
- 哪些东西仍然是 Phase 5 后续任务

## 验收标准

- artifact:
  - `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-002-layered-ingestion-v1.md`
- command:
  - `test -f /Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-002-layered-ingestion-v1.md`
- assertion:
  - 文档里必须明确出现这些意思：
    - 只保留 `raw_inbox / candidate / promoted` 三层
    - `wiki/fact/insight` 不是独立 layer
    - raw_inbox 保存原始 envelope，不落 `normalized_*`
    - `raw_dedup_key` 和 `semantic_fingerprint` 是两个不同概念
    - retrieval API / usage.ack 不属于本批
- output:
  - 一份能直接指导后续 `P5-002.*` 和 `P5-003.*` 任务继续拆和继续实现的分层总说明

## 建议写法

写法要求：

- 继续用说人话的方式写
- 重点放在边界和流转
- 不要写成大而空的架构宣言

## 完成标志

这份文档写完后，下一步才能继续：

- `P5-002.b`
- `P5-002.c`
- `P5-003.a`

也就是先把分层说清楚，再做 candidate/promoted 主链。

