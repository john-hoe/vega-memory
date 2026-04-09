# VM2-016：设计图查询工具集（query_graph / get_neighbors / shortest_path / graph_stats）

## 背景
VM2-010 实现了跨项目 topic graph/tunnel，VM2-015 加了关系置信度，VM2-017 加了 code/doc graph sidecar。现在需要提供图查询 MCP/API 原语。

## 必须先读的代码
- src/core/knowledge-graph.ts — 现有 query 方法
- src/core/topic-service.ts — tunnel view, cross-project 查询
- src/db/repository.ts — entities, relations 查询
- src/mcp/server.ts — 现有 memory_graph 工具

## 实现要求

### 新增图查询方法（KnowledgeGraphService 扩展）
- getNeighbors(entityName, depth?, minConfidence?): 获取邻居节点
- shortestPath(fromEntity, toEntity, maxDepth?): 两个实体间最短路径（BFS）
- graphStats(project?): 图谱统计（节点数、边数、按类型分布、平均置信度）
- subgraph(entityNames[], depth?): 获取子图（多个起点的邻域）

### MCP 工具
- graph_neighbors: 查邻居
- graph_path: 最短路径
- graph_stats: 统计信息
- graph_subgraph: 子图查询

### CLI
- vega graph neighbors <entity>
- vega graph path <from> <to>
- vega graph stats
- vega graph subgraph <entities...>

### Repository 扩展
- 路径查询需要递归 CTE 或多跳 JOIN
- 统计查询用聚合

## 交付物
1. KnowledgeGraphService 扩展
2. Repository 扩展
3. MCP 工具
4. CLI 命令
5. 测试

## 质量要求
- npm run build 通过
- npm test 通过
