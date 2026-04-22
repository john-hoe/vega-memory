# P5-003.1.2 派生管线输入边界

## 这份文档是干什么的

定义 wiki、fact、insight 三类下游派生产物在 candidate → promoted 主线上的**输入条件**。

Phase 5 不把 wiki/fact/insight 当成独立活跃层，而是把它们视为 promoted memory 的下游派生视图。这份文档只回答：

**什么样的 promoted memory 有资格进入哪一类派生？**

## 输入条件

### wiki 输入条件

- **内容长度**：≥ 200 字符（不含空白和 markdown 标记）
- **主题一致性**：单条内容聚焦一个主题，不跨多个不相关领域
- **来源要求**：必须来自 `project_context` 或 `decision` 类型的 promoted memory
- **排除项**：
  - 纯命令记录（如 shell 命令、git 操作）
  - 临时调试日志
  - 个人偏好设置

### fact 输入条件

- **可验证性**：内容包含可独立验证的事实陈述，而非主观意见
- **时间锚点**：
  - 必须包含明确的时间戳（如 `2024-03-15`）
  - 或包含相对时间锚点（如 "v2.1 发布之后"）
  - 或包含版本/迭代标识
- **来源要求**：优先从 `decision`、`insight` 类型提取，也可从 `project_context` 中带有明确事实陈述的内容提取
- **排除项**：
  - 预测性陈述（"可能会..."、"计划..."）
  - 个人感受或偏好
  - 未经验证的假设

### insight 输入条件

- **可操作性**：内容必须包含可指导未来行动的具体建议、模式或教训
- **非显而易见**：不能是文档中已明确记录的基础知识，必须是实践中提炼出的经验
- **来源要求**：必须来自 `pitfall` 或 `insight` 类型的 promoted memory
- **排除项**：
  - 通用最佳实践（如 "写测试很重要"）
  - 纯描述性内容
  - 已收录在官方文档中的标准流程

## 输入边界汇总表

| 类型 | 最小数据量 | 质量阈值 | 类型限制 |
|------|-----------|---------|---------|
| wiki | wiki：≥200 字符 | 主题一致性 | project_context, decision |
| fact | fact：≥50 字符 | fact：可验证 + 时间锚点 | decision, insight, project_context（带事实陈述） |
| insight | insight：≥100 字符 | insight：可操作 + 非显而易见 | pitfall, insight |

## 与 P5-003 主线的关系

这份文档是 P5-003 candidate-promotion 的下游补充：

- P5-003 负责 candidate → promoted 的判断和晋升
- 这份文档负责 promoted → wiki/fact/insight 的输入过滤

派生管线的完整运行时、人工审核流、失败处理不属于 Phase 5 范围，将在后续阶段定义。
