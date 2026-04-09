# VM2-015：引入图关系置信度分层（EXTRACTED / INFERRED / AMBIGUOUS）

## 背景
VM2-005 实现了 fact_claims 的 confidence，VM2-008/009/010 实现了 topic 系统。现在需要为 knowledge graph 的 entity relations 也引入置信度分层。

## 必须先读的代码
- src/core/knowledge-graph.ts — KnowledgeGraphService
- src/db/schema.ts — entities, relations 表
- src/core/types.ts — Entity, EntityRelation
- src/db/repository.ts — createEntity, createRelation, queryGraph

## 实现要求

### Relation Confidence
- 扩展 relations 表增加 confidence 字段（REAL，0-1）
- 扩展 relations 表增加 extraction_method 字段：EXTRACTED（从代码/文档直接提取）、INFERRED（从关联推断）、AMBIGUOUS（不确定）
- schema.ts 增量迁移

### KnowledgeGraphService 扩展
- createRelation 接受 confidence 和 extraction_method
- queryGraph 支持按 confidence 阈值过滤
- inferRelations(): 推断间接关系并标记为 INFERRED

### 类型扩展
- ExtractionMethod 类型
- 扩展 EntityRelation 增加 confidence 和 extraction_method

### MCP/CLI
- memory_graph 工具支持 min_confidence 过滤
- vega graph 命令显示置信度

## 交付物
1. schema 扩展
2. types 扩展
3. KnowledgeGraphService 扩展
4. MCP/CLI 扩展
5. 测试

## 质量要求
- npm run build 通过
- npm test 通过
