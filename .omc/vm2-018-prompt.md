# VM2-018：生成 GRAPH_REPORT 风格项目结构摘要

## 背景
VM2-016 提供了图查询工具，VM2-017 建了 code/doc graph sidecar。现在为图 sidecar 生成一页结构地图，供 agent 在大仓库中先看结构再做 recall/grep。

## 必须先读的代码
- src/core/knowledge-graph.ts — graphStats, query, getNeighbors
- src/core/code-index.ts — 代码结构提取
- src/core/doc-index.ts — 文档结构提取
- src/core/graph-sidecar.ts — sidecar 逻辑

## 实现要求

### GRAPH_REPORT 生成
路径：新增 src/core/graph-report.ts
- generateGraphReport(project): 生成项目结构摘要
- 内容包含：
  - 模块/文件结构概览（从 code graph 提取）
  - 核心实体和关系（top entities by relation count）
  - 模块间依赖关系
  - 文档结构（从 doc graph 提取）
  - 图谱统计摘要

### 输出格式
- Markdown 格式
- 可作为 session_start 的附加 context（可选，不默认注入）
- 存储到 data/{project}-graph-report.md

### CLI
- vega graph report [project]: 生成并输出报告
- vega graph report --save: 保存到文件

### MCP 工具
- graph_report: 生成并返回报告

### 与 session_start 的可选集成
- 新增配置：VEGA_SESSION_INCLUDE_GRAPH_REPORT（默认 false）
- 启用时在 L2/L3 模式的 session_start 中附加图谱摘要

## 交付物
1. src/core/graph-report.ts
2. CLI 命令
3. MCP 工具
4. session.ts 可选集成
5. 测试

## 质量要求
- npm run build 通过
- npm test 通过
- 报告内容准确反映图谱状态
