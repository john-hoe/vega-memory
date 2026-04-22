# P5-001a — Host Envelope Contract 收敛

## 这批只做什么

只做 `P5-001` 的第一步：

- 把宿主侧“存”的入口规则写清楚
- 把 Host 和 Vega 的边界写清楚
- 不改产品代码

## 这批不做什么

不做：

- retrieval
- usage.ack
- promotion
- candidate/promoted 设计
- 任何运行时逻辑改动

## 输入基线

以当前仓库里的现状为准：

- `/Users/johnmacmini/workspace/vega-memory/src/core/contracts/envelope.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/core/contracts/enums.ts`

目标不是推翻现状，而是把规则定稿。

## 交付物

### 1. 总说明文档

文件：

- `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-001-host-envelope-v1.md`

内容必须讲清楚：

- 宿主负责什么
- Vega 负责什么
- 哪些字段属于宿主 transport contract
- 哪些归一化动作属于 Vega ingestion
- 哪些内容不属于 `P5-001`

### 2. 现状对照

文档里必须明确写出：

- 当前 `envelope.ts` 已经实现了哪些字段
- 当前 `enums.ts` 已经实现了哪些 canonical values
- 这些实现里，哪些属于宿主 contract
- 哪些只是 Vega 内部方便处理的现有实现

## 验收标准

- artifact:
  - `/Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-001-host-envelope-v1.md`
- command:
  - `test -f /Users/johnmacmini/workspace/vega-memory/docs/specs/2026-04-22-p5-001-host-envelope-v1.md`
- assertion:
  - 文档里必须明确出现这几组意思：
    - `Host thin, Vega thick`
    - 宿主只做 transport-level 校验
    - canonical normalization 在 Vega 侧
    - `thread_id/project/cwd` 可为 `null`
    - `retrieval / usage.ack / promotion` 不属于本批
- output:
  - 一份能直接拿来指导后续 `P5-001.*` 细拆和 brief 的总说明

## 建议写法

写法要求：

- 用说人话的方式写
- 不要写成 blueprint 大作文
- 重点是边界清楚

## 完成标志

这份文档写完后，下一步才能继续：

- `P5-001.1`
- `P5-001.2`
- `P5-001.3`

也就是先定规则，再拆实现。

