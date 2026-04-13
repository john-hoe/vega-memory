[English](README.md) | **中文** | [日本語](README.ja.md) | [한국어](README.ko.md)

# Vega Memory

让多个 AI 编码 Agent 共享同一套长期记忆。

Vega Memory 是一个本地优先、可自托管的共享记忆层，服务于 Cursor、Codex、Claude Code、OpenClaw，以及其他基于 MCP 或 API 驱动的 Agent。它把“会话结束就丢失的经验”变成可持续复用的工程记忆，让不同工具、不同机器、不同时间点的 Agent 都能基于同一套上下文继续工作。

如果你今天让一个 Agent 修了问题，明天换另一个 Agent 接手，Vega 的价值就在于它不需要再从零开始。

[5 分钟开始](#5-分钟开始) · [接入方式](#接入方式) · [部署方式](#部署方式) · [HTTP API](docs/API.md) · [部署文档](docs/deployment.md) · [问题反馈](https://github.com/john-hoe/vega-memory/issues)

Vega 更适合被理解为一个位于 Agent 工作流底层的 shared memory runtime，而不是另一个泛化知识库或笔记系统。

## 为什么需要 Vega

大多数 Agent 工作流的真正瓶颈，不是模型不够聪明，而是模型不记得上一次发生了什么。

如果没有共享记忆层：

- 每个工具都有自己的上下文孤岛
- 新会话要么加载过多提示词，要么缺少关键上下文
- 同样的修复、决策和踩坑会被重复做很多次
- 远程机器、脚本和后台任务无法继承本地 Agent 的经验

Vega 把这些问题收束成一个可复用的闭环：

- 在任务开始时用 `session_start` 注入相关记忆
- 在任务过程中用 `memory_store` 持续沉淀经验
- 在任务结束时用 `session_end` 记录摘要并提取知识
- 在下一次任务里通过 `memory_recall` 和 session preload 把它们再利用起来

## 适合谁

Vega 当前最适合这些用户：

- 同一项目里同时使用多个编码 Agent 的独立开发者
- 想给团队建立共享 Agent 记忆层的小型工程团队
- 正在搭建自托管 Agent 基础设施的内部平台团队
- 需要 MCP、CLI、HTTP 三种接入能力的工具开发者

如果你现在最在意的是“多 Agent 共享上下文”和“跨会话不丢记忆”，Vega 比把它当成一个泛知识平台更值得先试。

## 为什么是 Vega

- **共享而不是单机记忆**：不是只服务一个聊天窗口，而是服务多个 Agent 和多个入口
- **本地优先而不是云依赖优先**：SQLite + 本地模型可跑，适合隐私敏感和离线场景
- **工程化而不是 demo 化**：有 MCP、CLI、HTTP API、dashboard、backup、audit、encryption、sync
- **先解决工作流断点**：重点不是多做一个知识库，而是让 Agent 在下一次任务里真的记得

## 核心能力

- **共享记忆原语**：`memory_store`、`memory_recall`、`memory_list`、`session_start`、`session_end`
- **混合检索**：向量检索、BM25、reranking、topic-aware recall、deep recall
- **运行可靠性**：版本历史、审计日志、压缩整理、备份、数据库加密
- **多入口接入**：MCP、CLI、HTTP API、dashboard
- **扩展能力**：wiki synthesis、graph 视图、多租户、analytics 等上层能力

## 运行环境

- **推荐 Node 20 LTS**
- **默认存储**：SQLite，本地优先，数据库默认路径为 `./data/memory.db`
- **默认 embedding 路径**：Ollama + `bge-m3`
- **降级策略**：没有 Ollama 时系统仍可运行，但召回能力会退回到更保守的关键词 / 非向量路径

## 接入方式

| 接入方式 | 传输方式 | 最适合的场景 |
| --- | --- | --- |
| MCP | stdio | Cursor 和其他 MCP 客户端中的 Agent 原生接入 |
| CLI | shell | Codex、Claude Code、脚本、CI、本地终端工作流 |
| HTTP API | REST | 远程机器、dashboard、自定义集成、同步客户端 |

当前推荐的理解方式很简单：

- 想让 Agent 自动调用：优先 MCP
- 想让终端和脚本接入：优先 CLI
- 想做远程共享或后台服务：优先 HTTP API

## 一个典型工作流

1. Agent 开始处理任务时调用 `session_start`
2. Vega 返回活跃任务、偏好、相关记忆和主动预警
3. Agent 在工作中用 `memory_store` 记录新的可复用经验
4. 任务结束时用 `session_end` 记录摘要，并抽取新的知识
5. 下一次任务开始时，新的 Agent 继续复用这些内容

这条闭环就是 Vega 的产品核心。

## 5 分钟开始

### 1. 克隆并构建

```bash
git clone https://github.com/john-hoe/vega-memory.git
cd vega-memory
npm install
npm run build
npm link
```

### 2. 配置最小环境

```bash
cp .env.example .env
```

最常见的本地配置是：

```bash
VEGA_DB_PATH=./data/memory.db
VEGA_DB_ENCRYPTION=false
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=bge-m3
VEGA_API_KEY=change-me
VEGA_API_PORT=3271
```

### 3. 验证服务是否可用

```bash
vega health
```

### 4. 跑一次最小记忆闭环

```bash
vega store "Always checkpoint WAL before copying SQLite backups" \
  --type pitfall \
  --project my-project \
  --title "SQLite backup checklist"

vega recall "sqlite backup" --project my-project
```

## 部署方式

Vega 当前最推荐的部署路径有三条：

### 方案 A：本地单机模式

适合独立开发者和本机工作流。

- 使用 SQLite 本地数据库
- MCP 入口由 Agent 客户端按需拉起
- 后台调度进程提供 HTTP API、dashboard、backup 和 maintenance

```bash
export VEGA_API_KEY="$(openssl rand -hex 16)"
node dist/scheduler/index.js
```

### 方案 B：Docker / Compose

适合想快速体验完整运行栈的用户。

```bash
docker compose up --build
```

默认 Compose 会启动：

- `vega`：scheduler + HTTP API
- `ollama`：本地模型服务

当前仓库里的 Compose 默认对外暴露的是 `3000` 端口，不是文档里的默认 `3271`。

### 方案 C：远程共享模式

适合多机器或小团队共享同一套记忆。

- 以 server mode 运行集中式 Vega
- 通过 HTTP API 或 client mode 访问
- 保留本地缓存和远程同步能力

## 当前最推荐的使用场景

如果你第一次试 Vega，我建议从这几个场景切入：

- 让 Cursor、Codex、Claude Code 在同一个仓库里共享踩坑记录
- 给长期维护的项目沉淀决策和偏好，而不是写在临时对话里
- 在自托管环境里建立一个团队共享的 Agent memory backend
- 把 `session_start` 变成进入任务时的标准上下文入口

## 技术边界和真实预期

为了避免第一次接触时误解，下面这些边界值得提前说清楚：

- Vega 默认使用 SQLite，本地体验最好，远程和多端共享通过 API / sync 扩展
- HTTP API 和 dashboard 只有在显式配置 `VEGA_API_KEY` 时才会启用
- dashboard 由 scheduler 进程提供，不是单独前端应用
- Ollama 是默认 embedding/provider 路径，但系统也支持其他 provider 配置
- 远程 MCP 客户端当前是轻量兼容层，不是本地 MCP 能力的完整镜像
- wiki、graph、analytics、billing 等能力已经存在，但不是第一次采用时的主学习路径

## 架构概览

```text
                           +---------------------------+
                           |    Cursor / MCP Client    |
                           |  stdio -> dist/index.js   |
                           +-------------+-------------+
                                         |
                                         v
+-------------+     +--------------------+--------------------+     +----------------------+
| CLI         |     | Vega Memory Runtime                      |     | Scheduler / Daemon   |
| commander.js| --> | MCP tools + HTTP API + dashboard mount  | <-- | health, backup,      |
| local ops   |     | Express routes, auth, session services  |     | compaction, alerts   |
+-------------+     +--------------------+--------------------+     +----------------------+
                                         |
                                         v
                           +-------------+-------------+
                           | Core Services             |
                           | memory, recall, session,  |
                           | compression, graph, docs, |
                           | plugins, templates, team  |
                           +-------------+-------------+
                                         |
                                         v
                           +-------------+-------------+
                           | SQLite (WAL mode)         |
                           | better-sqlite3, FTS5,     |
                           | hybrid search, versions   |
                           +-------------+-------------+
                                         |
                   +---------------------+----------------------+
                   |                                            |
                   v                                            v
          +--------+--------+                         +---------+---------+
          | Ollama           |                        | Local filesystem   |
          | embeddings/chat  |                        | backups, reports,  |
          | localhost:11434  |                        | plugins, exports   |
          +------------------+                        +-------------------+
```

## 下一步你会去哪里

- 想看 API：见 [HTTP API 文档](docs/API.md)
- 想看部署：见 [部署文档](docs/deployment.md)
- 想接入 Agent：继续看正式 README 中后半部分的工具接入说明
- 想提问题：去 [GitHub Issues](https://github.com/john-hoe/vega-memory/issues)
- 想参与讨论：后续建议补齐 Discussions 和更完整 docs 入口
