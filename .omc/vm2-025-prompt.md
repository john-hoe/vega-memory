# VM2-025：raw archive 脱敏时序：在 store 脱敏前捕获原文存入冷层

## 背景
VM2-006 实现了冷存档层，VM2-007 加了膨胀控制。当前 MemoryService.store() 会在脱敏后写入 hot memory，同时通过 captureRawArchive 在脱敏后也存一份到冷层。但如果需要保留未脱敏的原文作为证据，需要在脱敏前捕获。

## 重要约束
- 不改变 hot memory 的脱敏行为（hot memory 必须脱敏后存储）
- 冷层可以保存原文（用户明确选择时）
- 默认行为：冷层也存脱敏后的版本（安全优先）
- 通过配置或参数控制是否保留原文

## 必须先读的代码
- src/core/memory.ts — MemoryService.store() 流程，看脱敏和 captureRawArchive 的时序
- src/core/archive-service.ts — ArchiveService store/deepRecall
- src/security/redactor.ts — 脱敏逻辑
- src/config.ts — 现有配置

## 实现要求

### Store 流程调整
- 在 memory.ts store() 中，脱敏前先捕获原文
- 新增 store 参数：preserve_raw（默认 false）
- preserve_raw=true 时：原文存入冷层，脱敏版存入 hot memory
- preserve_raw=false 时：脱敏版同时存入冷层和 hot memory（当前行为）

### 配置
- VEGA_ARCHIVE_PRESERVE_RAW：全局默认值（默认 false）
- 可通过 store 调用参数覆盖全局配置

### 安全考虑
- 冷层保存原文时标记 metadata.contains_raw=true
- deep_recall 返回包含原文的结果时加警告标记
- audit_log 记录原文存储操作

### MCP/API 扩展
- memory_store 工具增加 preserve_raw 可选参数
- /api/store 接受 preserve_raw 参数

## 交付物
1. memory.ts 调整 store 时序
2. config.ts 新增配置
3. MCP/API 参数扩展
4. 审计日志
5. 测试

## 质量要求
- npm run build 通过
- npm test 通过
- 默认行为（preserve_raw=false）与之前完全一致
