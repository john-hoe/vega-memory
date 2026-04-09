# VM2-019：图谱侧内容哈希缓存与增量刷新机制

## 背景
VM2-017 实现了 code/doc graph sidecar。现在需要完善 SHA256 缓存机制，确保增量构建高效，避免重复解析未变更文件。

## 必须先读的代码
- src/core/code-index.ts — 代码索引（已有部分 hash 逻辑）
- src/core/doc-index.ts — 文档索引
- src/core/graph-sidecar.ts — 如果存在
- src/db/repository.ts — content hash 相关查询
- src/db/schema.ts — 相关表

## 实现要求

### Content Hash 缓存表
- 如果不存在，新增 graph_content_cache 表：file_path, content_hash, last_indexed_at, entity_count
- 索引前查缓存：hash 匹配则跳过
- 索引后更新缓存

### 增量刷新
- scanDirectory(path): 扫描目录，对比 hash
- 分类为：new（新文件）、modified（hash 变更）、deleted（文件不存在但有缓存）、unchanged
- 只处理 new + modified
- deleted 文件清理对应的 entities/relations

### Watch 模式（可选）
- 基于文件修改时间的快速检查（不计算 hash，先看 mtime）
- mtime 变更才计算 hash

### CLI
- vega index --incremental：增量索引
- vega index --status：显示缓存状态（多少文件已索引/待更新/已删除）

## 交付物
1. 缓存表 schema（如需要）
2. 增量扫描逻辑
3. CLI 命令
4. 测试

## 质量要求
- npm run build 通过
- npm test 通过
- 增量索引比全量快（跳过未变更文件）
