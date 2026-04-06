[English](README.md) | **中文** | [日本語](README.ja.md) | [한국어](README.ko.md)

# Vega 记忆系统

一个本地优先的记忆服务器，为 AI 工具和 Agent 提供**持久化、跨会话的记忆能力**。连接 Cursor、Claude Code、Codex、OpenClaw 或任何兼容 MCP 的客户端——它们共享同一个知识库，确保在一个会话中学到的经验不会在下一个会话中丢失。

### 功能特性

- **记住** 决策、踩坑经验、用户偏好和项目上下文，跨会话持久保存
- **召回** 通过混合语义搜索（向量 + BM25）自动回忆相关经验
- **去重** 自动处理——存储相同内容时会合并而非重复创建
- **主动预警** ——"上次你处理 FFmpeg 时，62% 的问题与路径相关"
- **离线可用** ——SQLite + 本地 Ollama，零云依赖，零 API 费用

### 支持的 AI 工具

| 工具 | 接口 | 连接方式 |
|------|------|----------|
| **Cursor** | MCP (stdio) | 注册到 `~/.cursor/mcp.json` — Agent 自动调用记忆工具 |
| **Claude Code** | CLI | 在 `CLAUDE.md` 中配置规则 — 通过 shell 执行 `vega recall/store` |
| **Codex CLI** | CLI | 在 `AGENTS.md` 中配置规则 — 同样的 CLI 模式 |
| **OpenClaw** | HTTP API | Agent 通过 HTTP 调用 `/api/recall`、`/api/store` |
| **任何 MCP 客户端** | MCP (stdio) | 与 Cursor 相同的配置 — 适用于所有兼容 MCP 的工具 |
| **脚本 / CI** | CLI 或 HTTP | `vega recall --json` 或 `curl /api/recall` |

### 使用前后对比

| | 没有 Vega | 使用 Vega |
|---|---|---|
| 新会话上下文 | 从零开始，或加载整个 `AGENTS.md`（约 4000 token） | 仅加载相关记忆（约 500 token） |
| 跨会话知识 | 对话结束即丢失 | 持久存储在 SQLite 中，永久可搜索 |
| 多工具一致性 | 每个工具各自独立 | Cursor、Claude Code、Codex 共享同一记忆 |
| 重复修复 Bug | "这个问题我们之前不是解决过了吗？" | `session_start` 自动浮现之前的踩坑记录 |
| 远程机器 | 手动复制粘贴上下文 | 通过 Tailscale 自动同步，支持离线缓存 |

## 架构

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

**三种接口，同一记忆：**

| 接口 | 传输方式 | 最佳用途 |
|------|----------|----------|
| **MCP** | stdio | Cursor（Agent 自动调用） |
| **CLI** | shell | Claude Code、Codex、脚本、任何终端 |
| **HTTP API** | REST | 远程机器、自定义集成、Web 仪表盘 |

---

## 前置条件

- **Node.js** 18+
- **Ollama** 在本地运行并已拉取 `bge-m3` 模型（`ollama pull bge-m3`）

Ollama 为可选项——当 Ollama 不可用时，Vega 会优雅降级为关键词搜索（FTS5）。

---

## 快速开始

### 1. 克隆并构建

```bash
git clone https://github.com/your-username/vega-memory.git
cd vega-memory
npm install
npm run build
npm link   # makes the `vega` command available globally
```

### 2. 配置

复制示例环境变量文件并填入你的值：

```bash
cp .env.example .env
```

**`.env.example`：**
```bash
VEGA_DB_PATH=./data/memory.db
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=bge-m3
VEGA_API_KEY=              # REQUIRED for HTTP API — generate a strong random key
VEGA_API_PORT=3271
VEGA_TG_BOT_TOKEN=         # Optional: Telegram bot token for alerts
VEGA_TG_CHAT_ID=           # Optional: Telegram chat ID for alerts
```

> **安全提示：** 切勿将 `.env` 提交到 git。生成强 API 密钥：`openssl rand -hex 16`

### 3. 验证

```bash
vega health
```

你应该会看到一份健康报告。如果 Ollama 正在运行，则显示 `ollama: true`。

### 4. 存储第一条记忆

```bash
vega store "Always use WAL mode for SQLite concurrent access" \
  --type decision --project my-project
```

### 5. 召回记忆

```bash
vega recall "sqlite concurrency" --project my-project
```

### 6. 连接你的 AI 工具

| 工具 | 接口 | 配置方法 |
|------|------|----------|
| **Cursor** | MCP（自动） | 添加到 `~/.cursor/mcp.json` → [Cursor 配置](#cursor-mcp--recommended) |
| **Claude Code** | CLI | 添加规则到 `CLAUDE.md` → [Claude Code 配置](#claude-code-cli) |
| **Codex CLI** | CLI | 添加规则到 `AGENTS.md` → [Codex 配置](#codex-cli-cli) |
| **OpenClaw / 自定义** | HTTP API | 调用 `/api/*` 端点 → [HTTP API 配置](#openclaw--custom-agents-http-api) |
| **任何 MCP 客户端** | MCP (stdio) | 与 Cursor 相同的配置 |
| **脚本 / CI** | CLI 或 HTTP | `vega recall --json` 或 `curl /api/recall` |

各工具的详细配置说明见下方 [连接 AI 工具](#connecting-ai-tools) 章节。

---

## 部署

### 方案 A：本地单机部署（推荐起步方案）

所有组件在同一台机器上运行。MCP 服务器由 Cursor 在每次会话时启动；后台调度守护进程负责备份、压缩和 HTTP API。

```bash
# Start the background scheduler (includes HTTP API + dashboard)
export VEGA_API_KEY=$(openssl rand -hex 16)
node dist/scheduler/index.js &

# Dashboard is at http://127.0.0.1:3271
# Log in with the same API key
```

**macOS 自动启动**（通过 launchd）：

```bash
# Create the plist (adjust paths)
cat > ~/Library/LaunchAgents/dev.vega-memory.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://plist.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.vega-memory</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/vega-memory/dist/scheduler/index.js</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>VEGA_DB_PATH</key><string>/path/to/vega-memory/data/memory.db</string>
    <key>OLLAMA_BASE_URL</key><string>http://localhost:11434</string>
    <key>OLLAMA_MODEL</key><string>bge-m3</string>
    <key>VEGA_API_KEY</key><string>YOUR_GENERATED_KEY</string>
    <key>VEGA_API_PORT</key><string>3271</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/path/to/vega-memory/data/logs/scheduler-stdout.log</string>
  <key>StandardErrorPath</key><string>/path/to/vega-memory/data/logs/scheduler-stderr.log</string>
</dict>
</plist>
EOF

# Load it
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.vega-memory.plist
```

### 方案 B：服务器 + 远程客户端（Tailscale）

在中心服务器（例如常开的 Mac mini 或 VPS）上运行 Vega。远程机器通过 [Tailscale](https://tailscale.com)（零配置 WireGuard 网状 VPN）上的 HTTP API 连接。

#### 第 1 步：在所有机器上安装 Tailscale

```bash
# macOS
brew install tailscale
# or download from https://tailscale.com/download

# Linux
curl -fsSL https://tailscale.com/install.sh | sh

# Windows
# Download from https://tailscale.com/download/windows
```

在每台机器上登录：

```bash
sudo tailscale up
```

同一 Tailscale 账户下的所有机器现在都在一个私有加密网络上（`100.x.x.x`）。

#### 第 2 步：查找服务器的 Tailscale IP

在服务器（运行 Vega 的机器）上：

```bash
tailscale ip -4
# Output: 100.x.x.x  (this is your Tailscale IP)
```

#### 第 3 步：在服务器上启动 Vega

```bash
# Build and configure (see Quick Start above)
export VEGA_API_KEY=$(openssl rand -hex 16)
echo "Save this key: $VEGA_API_KEY"

node dist/scheduler/index.js
# API is now accessible at http://100.x.x.x:3271 from any Tailscale device
```

#### 第 4 步：连接远程机器

在每台远程机器上（需在同一 Tailscale 网络中）：

```bash
npm install -g vega-memory   # or clone and npm link

vega setup --server 100.x.x.x --port 3271 --api-key YOUR_API_KEY
```

此命令将：
1. 创建 `~/.vega/config.json` 保存服务器连接信息
2. 在 `~/.cursor/mcp.json` 中以客户端模式注册 Vega
3. 设置本地 SQLite 缓存以保障离线可用

#### 第 5 步：验证

```bash
# On the remote machine
vega health
# Should show: status: "healthy", connected to the server

vega recall "test" --json
# Should return results from the server's memory database
```

#### 离线模式

当远程机器与服务器断开连接时（例如无网络），Vega 会自动降级到本地缓存：

- **读取** 从缓存副本提供服务
- **写入** 排队到 `~/.vega/pending/`
- **重新连接** 后触发自动同步——待处理的写入通过正常的去重管道发送

#### Tailscale ACL（可选加固）

为增强安全性，可在 [Tailscale ACL 策略](https://login.tailscale.com/admin/acls) 中限制哪些设备可以访问 Vega 的端口：

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["group:engineering"],
      "dst": ["tag:vega-server:3271"]
    }
  ]
}
```

> **安全说明：** Tailscale 对所有流量提供 WireGuard 加密。Vega API 端口（3271）仅在你的 Tailscale 网络内可达——不会暴露到公共互联网。API 密钥在网络层安全之上增加了第二层身份验证。

---

## 连接 AI 工具

### Cursor（MCP — 推荐）

Vega 注册为 MCP 服务器，Cursor 会自动调用。

**1. 添加到 `~/.cursor/mcp.json`：**

```json
{
  "mcpServers": {
    "vega": {
      "command": "node",
      "args": ["/absolute/path/to/vega-memory/dist/index.js"],
      "env": {
        "VEGA_DB_PATH": "/absolute/path/to/vega-memory/data/memory.db",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_MODEL": "bge-m3"
      }
    }
  }
}
```

**2. 添加 Cursor 规则** `.cursor/rules/memory.mdc` 到你的工作区：

```markdown
---
globs: ["**/*"]
alwaysApply: true
---

## Memory System Rules

### Normal Mode (MCP available)
- Session start → call vega.session_start(working_directory, task_hint)
- Task completed → call vega.memory_store(type: "task_state")
- Decision made → call vega.memory_store(type: "decision")
- Bug fixed → call vega.memory_store(type: "pitfall")
- New preference → call vega.memory_store(type: "preference")
- User says "remember" → call vega.memory_store(source: "explicit")
- Session ending → call vega.session_end(summary)
- Before storing → verify content is NOT: emotional complaints, failed debug attempts, one-time queries, raw data, common knowledge

### Fallback Mode (MCP unavailable)
- Session start → read data/snapshots/memory-snapshot.md
- New memories → append to data/snapshots/pending-memories.jsonl

### Alert Check
- Session start → check data/alerts/active-alert.md → if exists, read and inform user
```

**3. 重启 Cursor。** Agent 现在会在每次对话开始时自动调用 `session_start`，并在你工作过程中存储记忆。

---

### Claude Code（CLI）

Claude Code 通过 shell 命令使用 `vega` CLI。将以下内容添加到项目的 `CLAUDE.md`：

```markdown
# Vega Memory Rules

## Session start
Run: `vega session-start --dir $(pwd) --json`
Parse the JSON output and use it as context for this session.

## Auto-store (do these automatically when appropriate)
- Task completed: `vega store "what was done" --type task_state --project PROJECT_NAME`
- Bug fixed: `vega store "error + solution" --type pitfall --project PROJECT_NAME`
- Decision made: `vega store "decision + reasoning" --type decision --project PROJECT_NAME`
- User says "remember": `vega store "content" --type preference --source explicit`

## Before making changes, search memory
Run: `vega recall "relevant query" --project PROJECT_NAME --json`

## Session end
Run: `vega session-end --project PROJECT_NAME --summary "what was accomplished"`
```

---

### Codex CLI（CLI）

与 Claude Code 模式相同。将以下内容添加到项目的 `AGENTS.md`：

```markdown
# Vega Memory Rules

- Read the task instruction FIRST before doing anything
- On start: run `vega session-start --dir $(pwd) --json`, use output as context
- On task complete: `vega store "..." --type task_state --project PROJECT_NAME`
- On error solved: `vega store "..." --type pitfall --project PROJECT_NAME`
- On session end: `vega session-end --project PROJECT_NAME --summary "..."`
- Before changes, search: `vega recall "query" --project PROJECT_NAME --json`
```

---

### HTTP API（任何工具 / 自定义集成）

任何可以发送 HTTP 请求的工具都能使用 Vega。认证方式为 Bearer token。

```bash
# Store a memory
curl -X POST http://YOUR_SERVER:3271/api/store \
  -H "Authorization: Bearer $VEGA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Always checkpoint WAL before backup",
    "type": "pitfall",
    "project": "my-project"
  }'

# Recall memories
curl -X POST http://YOUR_SERVER:3271/api/recall \
  -H "Authorization: Bearer $VEGA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "sqlite backup", "project": "my-project", "limit": 5}'

# Start a session
curl -X POST http://YOUR_SERVER:3271/api/session/start \
  -H "Authorization: Bearer $VEGA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"working_directory": "/path/to/project"}'

# Health check
curl -H "Authorization: Bearer $VEGA_API_KEY" \
  http://YOUR_SERVER:3271/api/health
```

完整 API 文档请参阅 [`docs/API.md`](docs/API.md)。

---

### OpenClaw / 自定义 Agent（HTTP API）

对于 OpenClaw 或任何自定义 AI Agent，配置 Agent 调用 HTTP API。示例 Agent 规则：

```markdown
# Vega Memory Connection
Server: http://YOUR_SERVER:3271
Auth: Bearer token (set via environment variable, never hardcode)

## When to store
- User shares a lesson learned → POST /api/store with type="pitfall"
- Technical decision made → POST /api/store with type="decision"
- User says "remember" → POST /api/store with source="explicit"

## When to recall
- Before answering technical questions → POST /api/recall
- At session start → POST /api/session/start
```

> **重要提示：** 始终通过环境变量传递 API 密钥。切勿在 Agent 配置文件中硬编码凭据。

---

## 自动记忆存储

Vega 的真正威力在于**自动**记忆存储——AI 工具会在工作过程中主动写入记忆，而不必每次都让你说「记住这个」。

### 工作原理

```
AI works on a task
    ↓
Completes a task     → auto-stores as task_state
Makes a decision     → auto-stores as decision
Fixes a bug          → auto-stores as pitfall
Learns a preference  → auto-stores as preference
    ↓
Next session → session_start loads relevant memories automatically
```

### 存储什么（以及不存储什么）

| 应存储 | 不应存储 |
|-------|-------------|
| 含推理的决策 | 情绪性抱怨 |
| 含错误信息的 bug 修复 | 无果而终的失败调试尝试 |
| 文件路径、命令、版本号 | 一次性查询 |
| 架构选择 | 原始数据转储 |
| 用户偏好 | 常见编程知识 |

**核心原则：** 每条记忆是一个具体事实，而非对话摘要。保留具体细节（错误信息、路径、命令）。

### 按工具配置

#### Cursor（MCP — 自动）

Cursor 会自动调用 MCP 工具。将以下规则文件加入工作区：

**`.cursor/rules/memory.mdc`:**
```markdown
---
globs: ["**/*"]
alwaysApply: true
---

Memory System Rules — MANDATORY (never skip, never wait for user reminder)

### Normal Mode (MCP available)
- Session start → call vega.session_start(working_directory, task_hint)
- Task completed → call vega.memory_store(type: "task_state") IMMEDIATELY
- Decision made → call vega.memory_store(type: "decision") IMMEDIATELY
- Bug fixed → call vega.memory_store(type: "pitfall") IMMEDIATELY
- New preference → call vega.memory_store(type: "preference") IMMEDIATELY
- User says "remember" → call vega.memory_store(source: "explicit")
- Session ending → call vega.session_end(summary)
- CRITICAL: Store memories AS events happen. Do NOT batch. Do NOT wait for user to ask.
- Before storing → verify content is NOT: emotional complaints, failed debug attempts, one-time queries, raw data, common knowledge
```

#### Claude Code（CLI）

Claude Code 使用 shell 命令。将以下内容加入项目的 **`CLAUDE.md`：**

```markdown
# Vega Memory — MANDATORY (auto-store, never wait for user reminder)

## Session lifecycle
- Start: `vega session-start --dir $(pwd) --json` — use output as context
- End: `vega session-end --project PROJECT --summary "what was done"`

## Auto-store (do these IMMEDIATELY when events happen)
- Task done: `vega store "what was done" --type task_state --project PROJECT --title "title"`
- Bug fixed: `vega store "error + fix" --type pitfall --project PROJECT --title "title"`
- Decision: `vega store "choice + why" --type decision --project PROJECT --title "title"`
- Preference: `vega store "preference" --type preference --project PROJECT --title "title"`

## Before changes, search memory
- `vega recall "query" --project PROJECT --json`

## Rules
- Store AS events happen, not at session end
- Each fact = one separate store call
- Preserve specifics: error messages, file paths, commands
```

#### Codex CLI

与 Claude Code 相同模式。将以下内容加入项目的 **`CODEX.md`：**

```markdown
# Vega Memory — MANDATORY (auto-store, never wait for user reminder)

- On start: `vega session-start --dir $(pwd) --json`
- Task done: `vega store "..." --type task_state --project PROJECT --title "..."`
- Bug fixed: `vega store "..." --type pitfall --project PROJECT --title "..."`
- Decision: `vega store "..." --type decision --project PROJECT --title "..."`
- On end: `vega session-end --project PROJECT --summary "..."`
- Before changes: `vega recall "query" --project PROJECT --json`
- CRITICAL: Store immediately as events happen. Do NOT wait for user to ask.
```

#### Codex App（桌面版）

如果使用带 MCP 的 Codex 桌面应用，请将以下内容添加到 **Settings → Personalization → Custom Instructions：**

```
Follow CODEX.md and AGENTS.md rules strictly. Proactively store memories to Vega Memory (via MCP) as events happen — do NOT wait for user to ask. Each task completed, decision made, or bug fixed = one memory_store call immediately.
```

#### OpenClaw / 自定义 Agent（HTTP API）

对于使用 HTTP API 的 Agent，请指示其：

```markdown
## Vega Memory (HTTP API)
Server: http://YOUR_SERVER:3271
Auth: Bearer YOUR_API_KEY

## Auto-store (call immediately when events happen)
- POST /api/store {"content":"...", "type":"pitfall", "project":"..."}
- POST /api/store {"content":"...", "type":"decision", "project":"..."}
- POST /api/store {"content":"...", "type":"task_state", "project":"..."}

## Before answering questions, recall
- POST /api/recall {"query":"...", "project":"..."}

## Session lifecycle
- POST /api/session/start {"working_directory":"..."}
- POST /api/session/end {"project":"...", "summary":"..."}
```

### 验证是否生效

结束一段工作后，检查是否已写入记忆：

```bash
# List recent memories
vega list --sort "created_at DESC" --json | head -20

# Check memory count
vega health --json | grep memories

# Search for something discussed in the session
vega recall "topic from your session"
```

若没有任何记忆，请检查规则文件是否在正确位置，以及 MCP 服务器或 CLI 是否可用。

---

## CLI 参考

### 核心工作流

| 命令 | 用途 |
|------|------|
| `vega store <content> --type <type> --project <p>` | 存储记忆 |
| `vega recall <query> [--project <p>] [--type <t>] [--json]` | 语义搜索 |
| `vega list [--project <p>] [--type <t>] [--sort <s>]` | 列出记忆 |
| `vega session-start [--dir <path>] [--hint <text>]` | 加载会话上下文 |
| `vega session-end --project <p> --summary <text>` | 结束会话，提取记忆 |
| `vega health [--json]` | 系统健康报告 |

### 维护

| 命令 | 用途 |
|------|------|
| `vega compact [--project <p>]` | 合并重复项，归档过期项 |
| `vega diagnose [--issue <text>]` | 生成诊断报告 |
| `vega backup [--cloud]` | 创建备份 |
| `vega export [--format json\|md] [-o file]` | 导出记忆 |
| `vega import <file>` | 从 JSON 或 Markdown 导入 |
| `vega compress [--project <p>] [--min-length 1200]` | 通过 Ollama 压缩长记忆 |
| `vega quality [--project <p>]` | 评估记忆质量 |
| `vega benchmark [--suite all\|write\|recall]` | 性能基准测试 |

### 知识与索引

| 命令 | 用途 |
|------|------|
| `vega graph <entity> [--depth <n>]` | 查询知识图谱 |
| `vega index <dir> [--ext ts,tsx,js]` | 索引源代码 |
| `vega index-docs <path> [--project <p>]` | 索引 Markdown 文档 |
| `vega git-import <repo> [--since <date>]` | 导入 git 历史 |
| `vega generate-docs --project <p>` | 从记忆生成文档 |

### 配置与管理

| 命令 | 用途 |
|------|------|
| `vega setup --server <host> --port <port> --api-key <key>` | 配置远程客户端 |
| `vega init-encryption` | 在 macOS Keychain 中生成加密密钥 |
| `vega stats` | 按类型/项目/状态汇总统计 |
| `vega audit [--actor <a>] [--action <a>]` | 查看审计日志 |
| `vega snapshot` | 导出 Markdown 快照 |
| `vega plugins list` | 列出已安装插件 |
| `vega templates list` / `vega templates install <name>` | 入门模板 |

所有命令支持 `--json` 以输出机器可读的格式。

### 记忆类型

| 类型 | 用途 | 衰减 |
|------|------|------|
| `preference` | 用户偏好、编码风格 | 永不 |
| `project_context` | 架构、技术栈、项目结构 | 极慢 |
| `task_state` | 当前任务进度 | 快速（完成后 → 归档） |
| `pitfall` | Bug、错误、解决方案 | 永不 |
| `decision` | 技术决策及其理由 | 中等 |
| `insight` | 自动生成的模式（仅系统） | 不适用 |

---

## MCP 工具

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `memory_store` | 存储记忆 | `content`、`type`、`project?`、`title?`、`tags?` |
| `memory_recall` | 语义搜索 | `query`、`project?`、`type?`、`limit?` |
| `memory_list` | 浏览记忆 | `project?`、`type?`、`limit?`、`sort?` |
| `memory_update` | 更新记忆 | `id`、`content?`、`importance?`、`tags?` |
| `memory_delete` | 删除记忆 | `id` |
| `session_start` | 加载会话上下文 | `working_directory`、`task_hint?` |
| `session_end` | 结束会话 | `project`、`summary`、`completed_tasks?` |
| `memory_health` | 健康报告 | — |
| `memory_compact` | 合并与归档 | `project?` |
| `memory_diagnose` | 诊断 | `issue?` |
| `memory_graph` | 知识图谱查询 | `entity`、`depth` |
| `memory_compress` | 通过 Ollama 压缩 | `memory_id?`、`project?`、`min_length?` |
| `memory_observe` | 被动工具观察 | `tool_name`、`project?`、`input?`、`output?` |

---

## HTTP API

当配置了 `VEGA_API_KEY` 时，调度器会提供经过身份验证的 REST API。

| 路由 | 方法 | 用途 |
|------|------|------|
| `/` | `GET` | Web 仪表盘（需登录） |
| `/dashboard/login` | `POST` | 用 API 密钥换取会话 cookie |
| `/dashboard/logout` | `POST` | 清除会话 |
| `/api/store` | `POST` | 存储记忆 |
| `/api/recall` | `POST` | 召回记忆 |
| `/api/list` | `GET` | 列出记忆 |
| `/api/memory/:id` | `PATCH` | 更新记忆 |
| `/api/memory/:id` | `DELETE` | 删除记忆 |
| `/api/session/start` | `POST` | 开始会话 |
| `/api/session/end` | `POST` | 结束会话 |
| `/api/health` | `GET` | 健康状态 |
| `/api/compact` | `POST` | 执行压缩 |

认证方式：`Authorization: Bearer <your-api-key>` 或仪表盘会话 cookie。

完整请求/响应示例请参阅 [`docs/API.md`](docs/API.md)。

---

## 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VEGA_DB_PATH` | `./data/memory.db` | SQLite 数据库路径 |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API 基础 URL |
| `OLLAMA_MODEL` | `bge-m3` | Embedding 模型名称 |
| `VEGA_API_KEY` | — | HTTP API **必填**。使用 `openssl rand -hex 16` 生成 |
| `VEGA_API_PORT` | `3271` | HTTP API 端口 |
| `VEGA_TOKEN_BUDGET` | `2000` | 会话启动时注入的最大 token 数 |
| `VEGA_SIMILARITY_THRESHOLD` | `0.85` | 去重相似度阈值 |
| `VEGA_BACKUP_RETENTION_DAYS` | `7` | 备份保留天数 |
| `VEGA_MODE` | `server` | `server`（主节点）或 `client`（远程） |
| `VEGA_SERVER_URL` | — | 远程 Vega 服务器 URL（客户端模式） |
| `VEGA_CACHE_DB` | `~/.vega/cache.db` | 本地缓存数据库（客户端模式） |
| `VEGA_OBSERVER_ENABLED` | `false` | 启用被动工具观察 |
| `VEGA_TG_BOT_TOKEN` | — | Telegram 机器人 token（用于告警） |
| `VEGA_TG_CHAT_ID` | — | Telegram 聊天 ID（用于告警） |
| `VEGA_ENCRYPTION_KEY` | — | 加密导出的十六进制密钥 |
| `VEGA_CLOUD_BACKUP_DIR` | — | 云备份同步目录 |

> **安全提醒：** 所有密钥（`VEGA_API_KEY`、`VEGA_TG_BOT_TOKEN`、`VEGA_ENCRYPTION_KEY`）必须通过环境变量或 `.env` 文件设置。切勿将其提交到版本控制。

---

## 工作原理

### 记忆生命周期

```
Create → Active Use → Cool Down → Archive/Merge → Cleanup
```

1. **存储**：内容脱敏（去除密钥）→ 向量化（Ollama bge-m3）→ 去重（相似度 >0.85 则合并）→ 存入 SQLite
2. **检索**：查询向量化 → 混合搜索（向量 70% + BM25 30%，基于 FTS5）→ 按 `相似度×0.5 + 重要性×0.3 + 时效性×0.2` 排序
3. **会话**：`session_start` 在 2000 token 预算内注入相关上下文；`session_end` 从摘要中提取新记忆
4. **维护**：每日备份、每周压缩、缺失 embedding 重建

### 信任体系

| 状态 | 含义 | 搜索权重 |
|------|------|----------|
| `verified` | 用户已确认 | ×1.0 |
| `unverified` | 自动提取，尚未审核 | ×0.7 |
| `rejected` | 用户标记为不正确 | 排除 |
| `conflict` | 与已验证记忆冲突 | 浮现供用户解决 |

### 跨项目共享

记忆初始为 `project` 级别作用域。当被 2 个及以上不同项目访问时，自动提升为 `global` 级别，并出现在所有会话中。

---

## 开发

### 构建与测试

```bash
rm -rf dist
npx tsc
node --test dist/tests/*.test.js
```

### 项目结构

```
src/
├── index.ts              # MCP server entry
├── config.ts             # Configuration loader
├── core/                 # Memory, recall, session, compact, lifecycle
├── db/                   # SQLite schema, repository, backup, CRDT
├── embedding/            # Ollama integration, cache
├── search/               # Brute-force engine, ranking, hybrid search
├── security/             # Redactor, encryption, RBAC, keychain
├── mcp/                  # MCP tool definitions
├── cli/                  # CLI commands (commander.js)
├── api/                  # HTTP API routes, auth
├── web/                  # Dashboard
├── scheduler/            # Background daemon
├── insights/             # Pattern detection, insight generation
├── notify/               # Telegram, alert files
├── sync/                 # Remote client sync
├── plugins/              # Plugin loader, SDK
└── tests/                # Test suites
```

### 插件

插件从 `data/plugins/<plugin-name>/plugin.json` 自动发现：

```json
{
  "name": "example-plugin",
  "version": "0.1.0",
  "main": "index.js"
}
```

入门模板：`vega templates list` / `vega templates install <name>`。

---

## 安全

- **敏感数据脱敏**：API 密钥、token、密码在存储前自动清除
- **静态加密**：可选 SQLCipher 加密，密钥由 macOS Keychain 管理
- **API 认证**：所有 HTTP API 调用需要 Bearer token
- **审计日志**：每个操作都记录了执行者、时间戳和操作类型
- **安全删除**：记忆不会被静默删除——需要通知 + 下载窗口 + 确认
- **网络安全**：远程访问时务必使用 VPN（Tailscale/WireGuard）。切勿将 API 端口直接暴露到互联网

---

## 许可证

MIT
