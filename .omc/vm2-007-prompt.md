# VM2-007：冷层膨胀控制：分层索引、延迟 embedding、hash 去重

## 背景
VM2-006 实现了冷存档层。现在需要控制 raw_archives 的数据库体积、索引时间和 embedding 成本，避免冷层拖慢主路径。

## 重要约束
- 冷层不影响热路径性能
- hash 去重已在 VM2-006 实现（content_hash），这里加强
- 延迟 embedding：冷层不在写入时做 embedding

## 必须先读的代码
- src/core/archive-service.ts — 现有存储逻辑
- src/db/repository.ts — raw_archives CRUD
- src/db/schema.ts — raw_archives 表和 raw_archives_fts
- src/core/regression-guard.ts — 性能指标

## 实现要求

### 分层索引
- raw_archives 内容默认只建 FTS 索引（已有）
- embedding 列保持 nullable，不在写入时生成
- 新增后台任务：批量为无 embedding 的冷层记录生成 embedding

### 延迟 embedding
- ArchiveService.store() 不调用 Ollama embedding
- 新增 ArchiveService.buildEmbeddings(batchSize, project?): 后台批量生成
- 可通过 CLI 手动触发：vega archive embed --batch 50

### 体积控制
- 新增 ArchiveService.getStats(): 返回冷层体积统计（记录数、总大小、有/无 embedding 数量）
- 超过阈值时在 health report 中警告
- 阈值：VEGA_ARCHIVE_MAX_SIZE_MB（默认 500MB）

### hash 去重加强
- 确认 SHA-256 hash 去重在 store 路径上生效
- 新增批量去重扫描：找出内容相同但 hash 未计算的旧记录

## 交付物
1. archive-service.ts 扩展（延迟 embedding + stats）
2. config.ts 新增阈值配置
3. health.ts 集成冷层体积警告
4. CLI 命令（archive embed / archive stats）
5. 测试

## 质量要求
- npm run build 通过
- npm test 通过
- 冷层写入不调用 Ollama（验证延迟 embedding）
