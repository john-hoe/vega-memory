# P7-002 Usage Fallback Ladder v1

## 这份文档是干什么的

这份文档只回答一件事：

当 `decision_state = needs_external` 时，宿主应该如何从 Vega 内部知识升级到下一层信息源，并且保证顺序稳定、边界清楚、成本受控。

## 核心原则

### 1. 先 Vega，后本地，再外部

Phase 7 的 fallback 顺序固定为：

1. 先判断 Vega 是否还够
2. 不够时先查 local workspace
3. 本地也不够时才允许去 external

### 2. fallback 属于 usage，不属于 retrieval

fallback ladder 的职责是：

- 判断是否升级
- 决定升级到本地还是外部
- 决定在哪一层停止

它不负责：

- 设计 Vega 内部 retrieval 策略
- 改写 retrieval orchestration

### 3. 查到足够推进的信息就停

fallback 的停止条件不是“知道得更多”，
而是“已经足够回到 execution”。

## P7-002.1 Local workspace fallback

### P7-002.1.1 local workspace 可查询源清单

本地 fallback 默认允许的 source 包括：

- 当前 repo 代码
- 当前文件内容
- 当前配置文件
- 当前测试输出
- 当前运行日志
- 当前命令输出
- 当前环境状态

这条边界的目的，是防止宿主一缺信息就直接跳外部。

### P7-002.1.2 local fallback 停止条件

出现以下任一情况，即可停止 local fallback 并回到 execution：

- 已拿到足够支撑下一步推进的事实
- 已定位到问题根因或下一步操作点
- 已确认缺口不在本地，而在外部来源

不允许的反模式：

- 本地已经给出根因，还继续无界扫 repo
- 本地证据已经足够，还继续扩张读取范围

## P7-002.2 External fallback

### P7-002.2.1 external source allowlist

外部 fallback 允许的来源应限制在：

- 官方文档
- 官方博客
- 官方 GitHub repo / issue / discussion
- 明确可信的第三方文档

默认不鼓励：

- 无出处论坛传言
- 低可信转载
- 与当前问题无关的泛搜索内容

### P7-002.2.2 external fallback 停止条件与用户决策边界

出现以下任一情况，即可停止 external fallback：

- 已拿到足够支撑下一步推进的官方/可信事实
- 已确认当前行为边界和下一步实现方向
- 已确认必须由用户做高层决策

需要升级到用户决策的典型情形：

- 外部来源之间存在冲突，且需要产品取舍
- 需要接受不可逆外部副作用
- 需要跨系统授权或权限变更

## P7-002 到 Execution 的返回条件

无论 fallback 停在本地还是外部，只要满足下面条件就应该返回 execution：

- 已有一个明确下一步动作
- 该动作所需事实已经足够
- 当前不再需要继续扩张信息源

## P7-002 与 Observability 的关系

fallback 阶段至少应可记录：

- 进入 fallback 的原因
- 进入的是 local 还是 external
- 最终在哪一层拿到推进所需信息
- 有没有产生新的结果事件回流

## 反模式

1. `needs_external` 后直接跳外部，绕过本地
2. 明明是外部时效性问题，还在本地疯狂翻日志
3. 已经拿到足够信息，却继续扩张检索
4. fallback 结束后没有把新结果事件回流 Vega

## 一句话版本

`P7-002` 要做的，是把宿主在 Vega 不足时的升级路径固定下来：先查本地，再查外部；查到足够推进的信息就停。
