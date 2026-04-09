# VM2-017：设计 code/doc graph sidecar 接入（AST-first + semantic-second）

## 背景
借鉴 Graphify 的 repo ingestion pipeline，作为 sidecar lane 引入，不替代现有 hot memory 或 topic taxonomy。为代码和文档建立结构化图谱。

## 重要约束
- sidecar 设计，不改现有 hot memory 主链
- AST-first：先提取代码结构（函数、类、模块依赖），再做语义关联
- 失败时不影响现有功能
- 受 feature flag 控制

## 必须先读的代码
- src/core/code-index.ts — 现有代码索引功能
- src/core/doc-index.ts — 现有文档索引功能
- src/core/knowledge-graph.ts — 现有 KG（entities/relations）
- src/db/schema.ts — entities, relations 表
- src/core/types.ts — Entity, EntityRelation
- src/config.ts — feature flags 模式

## 设计要求

### Code Graph Sidecar
- 扩展现有 code-index.ts 能力
- 提取：函数签名、类定义、import/export 关系、模块依赖
- 存储到 entities/relations（复用现有 KG 表，entity type 增加 function/class/module）
- content hash 缓存：只在文件变更时重新解析

### Doc Graph Sidecar
- 扩展现有 doc-index.ts 能力
- 提取：标题层级、cross-reference（[[link]]）、术语定义
- 存储到 entities/relations

### 增量刷新
- 基于文件 content hash（SHA-256）判断是否需要重新解析
- 未变更的文件跳过
- 新增/修改/删除文件增量更新图谱

### Feature Flag
- VEGA_FEATURE_CODE_GRAPH：默认 false
- 启用时 code-index 和 doc-index 额外写入 KG

### CLI
- vega index --graph：索引时同时构建图谱
- vega graph stats：显示图谱统计

## 交付物
1. 规格文档：docs/specs/vm2-017-code-doc-graph.md
2. code-index.ts 扩展（图谱写入）
3. doc-index.ts 扩展（图谱写入）
4. config.ts feature flag
5. content hash 缓存逻辑
6. 测试

## 质量要求
- npm run build 通过
- npm test 通过
- flag 关闭时与现有行为完全一致
