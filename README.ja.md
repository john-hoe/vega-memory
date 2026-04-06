[English](README.md) | [中文](README.zh-CN.md) | **日本語** | [한국어](README.ko.md)

# Vega メモリーシステム

ローカルファーストのメモリーサーバーで、AIツールとエージェントに**永続的なクロスセッションメモリー**を提供します。Cursor、Claude Code、Codex、OpenClaw、またはMCP対応クライアントを接続すれば、すべて同じナレッジベースを共有し、あるセッションで学んだことが次のセッションで失われることはありません。

### できること

- **記憶する** — 決定事項、落とし穴、好み、プロジェクトのコンテキストをセッションをまたいで記憶
- **想起する** — 新しいタスクを始めるとき、ハイブリッドセマンティック検索（Vector + BM25）で関連する経験を呼び出す
- **重複排除する** — 同じ教訓を二度保存しても、重複せずに自動マージ
- **事前に警告する** — 「前回 FFmpeg を扱った際、問題の62%はパス関連でした」
- **オフラインで動作する** — SQLite + ローカル Ollama、クラウド依存ゼロ、API コストゼロ

### 対応AIツール

| ツール | インターフェース | 接続方法 |
|------|-----------|----------------|
| **Cursor** | MCP (stdio) | `~/.cursor/mcp.json` に登録 — Agent がメモリーツールを自動呼び出し |
| **Claude Code** | CLI | `CLAUDE.md` にルール記述 — シェル経由で `vega recall/store` を実行 |
| **Codex CLI** | CLI | `AGENTS.md` にルール記述 — 同様の CLI パターン |
| **OpenClaw** | HTTP API | Agent が `/api/recall`、`/api/store` を HTTP 経由で呼び出し |
| **任意の MCP クライアント** | MCP (stdio) | Cursor と同じ設定 — MCP 対応ツールならすべて利用可能 |
| **スクリプト / CI** | CLI または HTTP | `vega recall --json` または `curl /api/recall` |

### 導入前 vs 導入後

| | Vega なし | Vega あり |
|---|---|---|
| 新規セッションのコンテキスト | ゼロから開始、または `AGENTS.md` 全体を読み込み（〜4000トークン） | 関連するメモリーのみ読み込み（〜500トークン） |
| クロスセッションの知識 | 会話終了で消失 | SQLite に永続化、いつでも検索可能 |
| マルチツールの一貫性 | 各ツールがサイロ化 | Cursor、Claude Code、Codex が同一メモリーを共有 |
| 同じバグを二度修正 | 「前にも解決しなかったっけ？」 | `session_start` が過去の落とし穴を表示 |
| リモートマシン | コンテキストを手動コピー＆ペースト | Tailscale 経由で自動同期、オフラインキャッシュ対応 |

## アーキテクチャ

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

**3つのインターフェース、1つのメモリー：**

| インターフェース | トランスポート | 最適な用途 |
|-----------|-----------|----------|
| **MCP** | stdio | Cursor（Agent が自動呼び出し） |
| **CLI** | shell | Claude Code、Codex、スクリプト、任意のターミナル |
| **HTTP API** | REST | リモートマシン、カスタム連携、Web ダッシュボード |

---

## 前提条件

- **Node.js** 18以上
- **Ollama** がローカルで動作し、`bge-m3` モデルがプル済みであること（`ollama pull bge-m3`）

Ollama は任意です — Ollama が利用できない場合、Vega はキーワード検索（FTS5）にフォールバックします。

---

## クイックスタート

### 1. クローンとビルド

```bash
git clone https://github.com/your-username/vega-memory.git
cd vega-memory
npm install
npm run build
npm link   # `vega` コマンドをグローバルに利用可能にする
```

### 2. 設定

環境変数ファイルのサンプルをコピーし、値を記入してください：

```bash
cp .env.example .env
```

**`.env.example`:**
```bash
VEGA_DB_PATH=./data/memory.db
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=bge-m3
VEGA_API_KEY=              # HTTP API に必須 — 強力なランダムキーを生成してください
VEGA_API_PORT=3271
VEGA_TG_BOT_TOKEN=         # 任意: アラート用 Telegram ボットトークン
VEGA_TG_CHAT_ID=           # 任意: アラート用 Telegram チャット ID
```

> **セキュリティ：** `.env` を git にコミットしないでください。強力な API キーの生成方法：`openssl rand -hex 16`

### 3. 動作確認

```bash
vega health
```

ヘルスレポートが表示されます。Ollama が動作していれば `ollama: true` と表示されます。

### 4. 最初のメモリーを保存

```bash
vega store "Always use WAL mode for SQLite concurrent access" \
  --type decision --project my-project
```

### 5. 呼び出す

```bash
vega recall "sqlite concurrency" --project my-project
```

### 6. AIツールを接続

| ツール | インターフェース | セットアップ |
|------|-----------|-------|
| **Cursor** | MCP（自動） | `~/.cursor/mcp.json` に追加 → [Cursor セットアップ](#cursor-mcp--recommended) |
| **Claude Code** | CLI | `CLAUDE.md` にルール追加 → [Claude Code セットアップ](#claude-code-cli) |
| **Codex CLI** | CLI | `AGENTS.md` にルール追加 → [Codex セットアップ](#codex-cli-cli) |
| **OpenClaw / カスタム** | HTTP API | `/api/*` エンドポイントを呼び出し → [HTTP API セットアップ](#openclaw--custom-agents-http-api) |
| **任意の MCP クライアント** | MCP (stdio) | Cursor と同じ設定 |
| **スクリプト / CI** | CLI または HTTP | `vega recall --json` または `curl /api/recall` |

各ツールの詳細は後述の [AIツールの接続](#connecting-ai-tools) セクションを参照してください。

---

## デプロイ

### オプション A: ローカル単一マシン（推奨の開始方法）

すべてが1台のマシン上で動作します。MCP サーバーはセッションごとに Cursor が起動し、スケジューラーデーモンがバックアップ、コンパクション、HTTP API のためにバックグラウンドで動作します。

```bash
# バックグラウンドスケジューラーを起動（HTTP API + ダッシュボードを含む）
export VEGA_API_KEY=$(openssl rand -hex 16)
node dist/scheduler/index.js &

# ダッシュボードは http://127.0.0.1:3271 でアクセス可能
# 同じ API キーでログイン
```

**macOS での自動起動**（launchd を使用）：

```bash
# plist を作成（パスを適宜調整）
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

# 読み込み
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.vega-memory.plist
```

### オプション B: サーバー + リモートクライアント（Tailscale）

Vega を中央サーバー（常時稼働の Mac mini や VPS など）で実行します。リモートマシンは [Tailscale](https://tailscale.com)（ゼロコンフィグの WireGuard メッシュ VPN）経由の HTTP API で接続します。

#### ステップ 1: すべてのマシンに Tailscale をインストール

```bash
# macOS
brew install tailscale
# または https://tailscale.com/download からダウンロード

# Linux
curl -fsSL https://tailscale.com/install.sh | sh

# Windows
# https://tailscale.com/download/windows からダウンロード
```

各マシンでログイン：

```bash
sudo tailscale up
```

同じ Tailscale アカウントのすべてのマシンが、プライベート暗号化ネットワーク（`100.x.x.x`）で接続されます。

#### ステップ 2: サーバーの Tailscale IP を確認

サーバー（Vega を実行するマシン）上で：

```bash
tailscale ip -4
# 出力: 100.x.x.x  （これが Tailscale IP です）
```

#### ステップ 3: サーバーで Vega を起動

```bash
# ビルドと設定（上記のクイックスタートを参照）
export VEGA_API_KEY=$(openssl rand -hex 16)
echo "Save this key: $VEGA_API_KEY"

node dist/scheduler/index.js
# API は任意の Tailscale デバイスから http://100.x.x.x:3271 でアクセス可能
```

#### ステップ 4: リモートマシンを接続

各リモートマシン上で（同じ Tailscale ネットワーク上にある必要があります）：

```bash
npm install -g vega-memory   # またはクローンして npm link


vega setup --server 100.x.x.x --port 3271 --api-key YOUR_API_KEY
```

このコマンドは以下を実行します：
1. サーバー接続情報を含む `~/.vega/config.json` を作成
2. クライアントモードで `~/.cursor/mcp.json` に Vega を登録
3. オフライン耐性のためのローカル SQLite キャッシュをセットアップ

#### ステップ 5: 動作確認

```bash
# リモートマシン上で
vega health
# 次のように表示されるはずです: status: "healthy", サーバーに接続済み

vega recall "test" --json
# サーバーのメモリーデータベースから結果が返されるはずです
```

#### オフラインモード

リモートマシンがサーバーへの接続を失った場合（インターネットがない場合など）、Vega は自動的にローカルキャッシュにフォールバックします：

- **読み取り**はキャッシュされたコピーから提供
- **書き込み**は `~/.vega/pending/` にキューイング
- **再接続**時に自動同期 — 保留中の書き込みが通常の重複排除パイプラインを通じて送信

#### Tailscale ACL（オプションのセキュリティ強化）

追加のセキュリティとして、[Tailscale ACL ポリシー](https://login.tailscale.com/admin/acls)で Vega のポートにアクセスできるデバイスを制限できます：

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

> **セキュリティ：** Tailscale はすべてのトラフィックに WireGuard 暗号化を提供します。Vega の API ポート（3271）は Tailscale ネットワーク内からのみ到達可能であり、公開インターネットに露出されることはありません。API キーは、ネットワークレベルのセキュリティの上に第二の認証レイヤーを追加します。

---

## AIツールの接続

### Cursor（MCP — 推奨）

Vega は Cursor が自動的に呼び出す MCP サーバーとして登録されます。

**1. `~/.cursor/mcp.json` に追加：**

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

**2. Cursor ルール**をワークスペースの `.cursor/rules/memory.mdc` に追加：

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

**3. Cursor を再起動します。** これで Agent が各会話の冒頭で `session_start` を自動的に呼び出し、作業中にメモリーを保存するようになります。

---

### Claude Code（CLI）

Claude Code はシェルコマンドを通じて `vega` CLI を使用します。プロジェクトの `CLAUDE.md` に以下を追加してください：

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

Claude Code と同じパターンです。プロジェクトの `AGENTS.md` に追加してください：

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

### Codex App（デスクトップ版 — リモート MCP 接続）

Codex デスクトップアプリは MCP に対応しています。リモート構成（例：Windows 上の Codex から Mac/Linux サーバー上の Vega に接続する場合）は、`client/vega-remote-mcp.mjs` に含まれる軽量のリモート MCP プロキシを使用します。

**ステップ 1: クライアントマシンでクローンとインストール**

```powershell
# Windows PowerShell (or bash on Mac/Linux)
git clone https://github.com/john-hoe/vega-memory.git
cd vega-memory
npm install @modelcontextprotocol/sdk
```

> クライアント側に必要なのは SDK のみです — ネイティブ依存、SQLite、Ollama は不要です。

**ステップ 2: Codex App に MCP サーバーを追加**

Codex App を開く → 設定 → **MCP Servers** → 追加：

```json
{
  "command": "node",
  "args": ["C:\\path\\to\\vega-memory\\client\\vega-remote-mcp.mjs"],
  "env": {
    "VEGA_SERVER_URL": "http://100.x.x.x:3271",
    "VEGA_API_KEY": "your-api-key-here"
  }
}
```

| 変数名 | 値 | 確認方法 |
|----------|-------|-------------|
| `VEGA_SERVER_URL` | `http://100.x.x.x:3271` | サーバー上で `tailscale ip -4` を実行 |
| `VEGA_API_KEY` | 生成したキー | スケジューラー起動時に使ったキー |

> macOS/Linux では、パスを `/path/to/vega-memory/client/vega-remote-mcp.mjs` に変更してください。

**ステップ 3: カスタム指示を追加**

Codex App を開く → 設定 → **Personalization** → Custom Instructions：

```
Follow CODEX.md and AGENTS.md rules strictly. Proactively store memories to Vega Memory (via MCP) as events happen — do NOT wait for user to ask. Each task completed, decision made, or bug fixed = one memory_store call immediately.
```

**ステップ 4: 動作確認**

Codex App の会話で、次のように尋ねます：

```
Check Vega Memory health
```

エージェントは `memory_health` を呼び出し、サーバーのステータスを返すはずです。`"status": "healthy"` と表示されれば接続は正常です。

---

### HTTP API（任意のツール / カスタム連携）

HTTP リクエストを送信できるツールであれば、どれでも Vega を利用できます。認証は Bearer トークンで行います。

```bash
# メモリーを保存
curl -X POST http://YOUR_SERVER:3271/api/store \
  -H "Authorization: Bearer $VEGA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Always checkpoint WAL before backup",
    "type": "pitfall",
    "project": "my-project"
  }'

# メモリーを呼び出し
curl -X POST http://YOUR_SERVER:3271/api/recall \
  -H "Authorization: Bearer $VEGA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "sqlite backup", "project": "my-project", "limit": 5}'

# セッションを開始
curl -X POST http://YOUR_SERVER:3271/api/session/start \
  -H "Authorization: Bearer $VEGA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"working_directory": "/path/to/project"}'

# ヘルスチェック
curl -H "Authorization: Bearer $VEGA_API_KEY" \
  http://YOUR_SERVER:3271/api/health
```

完全な API ドキュメントは [`docs/API.md`](docs/API.md) を参照してください。

---

### OpenClaw / カスタム Agent（HTTP API）

OpenClaw エージェントやカスタム AI エージェントの場合、HTTP API を呼び出すようにエージェントを設定してください。エージェントルールの例：

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

> **重要：** API キーは必ず環境変数経由で渡してください。エージェント設定ファイルにクレデンシャルをハードコーディングしないでください。

---

## 自動メモリストレージ

Vega の真価は **自動** メモリストレージにあります。AI ツールが作業中に先回りしてメモリーを保存するため、毎回「これを覚えて」と言う必要はありません。

### 仕組み

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

### 何を保存するか（しないか）

| 保存する | 保存しない |
|-------|-------------|
| 根拠付きの意思決定 | 感情的な不満 |
| エラーメッセージ付きのバグ修正 | 先に進まなかった失敗したデバッグ試行 |
| file paths, commands, version numbers | one-time queries |
| アーキテクチャの選択 | raw data dumps |
| ユーザーの好み | ありふれたプログラミング知識 |

**原則：** 各メモリーは会話の要約ではなく、一つの具体的な事実です。エラーメッセージ、パス、コマンドなどの具体情報を残してください。

### ツール別セットアップ

#### Cursor（MCP — 自動）

Cursor は MCP ツールを自動で呼び出します。次のルールファイルをワークスペースに追加してください：

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

Claude Code はシェルコマンドを使います。プロジェクトの **`CLAUDE.md`** に追記してください：

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

Claude Code と同じパターンです。プロジェクトの **`CODEX.md`** に追記してください：

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

#### Codex App（デスクトップ）

Codex デスクトップアプリで MCP を使う場合、**設定 → Personalization → Custom Instructions** に次を追加してください：

```
Follow CODEX.md and AGENTS.md rules strictly. Proactively store memories to Vega Memory (via MCP) as events happen — do NOT wait for user to ask. Each task completed, decision made, or bug fixed = one memory_store call immediately.
```

#### OpenClaw / カスタムエージェント（HTTP API）

HTTP API を使うエージェントには、次のように指示してください：

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

### 動作確認

作業セッションのあと、メモリーが保存されているか確認します：

```bash
# List recent memories
vega list --sort "created_at DESC" --json | head -20

# Check memory count
vega health --json | grep memories

# Search for something discussed in the session
vega recall "topic from your session"
```

メモリーが表示されない場合は、ルールファイルの配置と、MCP サーバーまたは CLI にアクセスできるかを確認してください。

---

## CLI リファレンス

### コアワークフロー

| コマンド | 用途 |
|---------|---------|
| `vega store <content> --type <type> --project <p>` | メモリーを保存 |
| `vega recall <query> [--project <p>] [--type <t>] [--json]` | セマンティック検索 |
| `vega list [--project <p>] [--type <t>] [--sort <s>]` | メモリーを一覧表示 |
| `vega session-start [--dir <path>] [--hint <text>]` | セッションコンテキストを読み込み |
| `vega session-end --project <p> --summary <text>` | セッション終了、メモリーを抽出 |
| `vega health [--json]` | システムヘルスレポート |

### メンテナンス

| コマンド | 用途 |
|---------|---------|
| `vega compact [--project <p>]` | 重複をマージ、古いものをアーカイブ |
| `vega diagnose [--issue <text>]` | 診断レポートを生成 |
| `vega backup [--cloud]` | バックアップを作成 |
| `vega export [--format json\|md] [-o file]` | メモリーをエクスポート |
| `vega import <file>` | JSON または Markdown からインポート |
| `vega compress [--project <p>] [--min-length 1200]` | Ollama 経由で長いメモリーを圧縮 |
| `vega quality [--project <p>]` | メモリー品質をスコアリング |
| `vega benchmark [--suite all\|write\|recall]` | パフォーマンスベンチマーク |

### ナレッジ＆インデックス

| コマンド | 用途 |
|---------|---------|
| `vega graph <entity> [--depth <n>]` | ナレッジグラフをクエリ |
| `vega index <dir> [--ext ts,tsx,js]` | ソースコードをインデックス |
| `vega index-docs <path> [--project <p>]` | Markdown ドキュメントをインデックス |
| `vega git-import <repo> [--since <date>]` | git 履歴をインポート |
| `vega generate-docs --project <p>` | メモリーからドキュメントを生成 |

### セットアップ＆管理

| コマンド | 用途 |
|---------|---------|
| `vega setup --server <host> --port <port> --api-key <key>` | リモートクライアントを設定 |
| `vega init-encryption` | macOS Keychain に暗号化キーを生成 |
| `vega stats` | タイプ/プロジェクト/ステータス別の集計カウント |
| `vega audit [--actor <a>] [--action <a>]` | 監査ログを表示 |
| `vega snapshot` | Markdown スナップショットをエクスポート |
| `vega plugins list` | インストール済みプラグインを一覧表示 |
| `vega templates list` / `vega templates install <name>` | スターターテンプレート |

すべてのコマンドは機械可読な出力のために `--json` をサポートしています。

### メモリータイプ

| タイプ | 用途 | 減衰 |
|------|---------|-------|
| `preference` | ユーザーの好み、コーディングスタイル | なし |
| `project_context` | アーキテクチャ、技術スタック、構成 | 非常に遅い |
| `task_state` | 現在のタスクの進捗 | 速い（完了 → アーカイブ） |
| `pitfall` | バグ、エラー、解決策 | なし |
| `decision` | 技術的決定とその理由 | 中程度 |
| `insight` | 自動生成されたパターン（システム専用） | N/A |

---

## MCP ツール

| ツール | 用途 | 主なパラメーター |
|------|---------|---------------|
| `memory_store` | メモリーを保存 | `content`, `type`, `project?`, `title?`, `tags?` |
| `memory_recall` | セマンティック検索 | `query`, `project?`, `type?`, `limit?` |
| `memory_list` | メモリーを閲覧 | `project?`, `type?`, `limit?`, `sort?` |
| `memory_update` | メモリーを更新 | `id`, `content?`, `importance?`, `tags?` |
| `memory_delete` | メモリーを削除 | `id` |
| `session_start` | セッションコンテキストを読み込み | `working_directory`, `task_hint?` |
| `session_end` | セッションを終了 | `project`, `summary`, `completed_tasks?` |
| `memory_health` | ヘルスレポート | — |
| `memory_compact` | マージ＆アーカイブ | `project?` |
| `memory_diagnose` | 診断 | `issue?` |
| `memory_graph` | ナレッジグラフクエリ | `entity`, `depth` |
| `memory_compress` | Ollama 経由で圧縮 | `memory_id?`, `project?`, `min_length?` |
| `memory_observe` | パッシブなツール観察 | `tool_name`, `project?`, `input?`, `output?` |

---

## HTTP API

スケジューラーは `VEGA_API_KEY` が設定されている場合、認証付き REST API を提供します。

| ルート | メソッド | 用途 |
|-------|--------|---------|
| `/` | `GET` | Web ダッシュボード（ログイン必須） |
| `/dashboard/login` | `POST` | API キーをセッション Cookie に交換 |
| `/dashboard/logout` | `POST` | セッションをクリア |
| `/api/store` | `POST` | メモリーを保存 |
| `/api/recall` | `POST` | メモリーを呼び出し |
| `/api/list` | `GET` | メモリーを一覧表示 |
| `/api/memory/:id` | `PATCH` | メモリーを更新 |
| `/api/memory/:id` | `DELETE` | メモリーを削除 |
| `/api/session/start` | `POST` | セッション開始 |
| `/api/session/end` | `POST` | セッション終了 |
| `/api/health` | `GET` | ヘルスステータス |
| `/api/compact` | `POST` | コンパクションを実行 |

認証方法：`Authorization: Bearer <your-api-key>` またはダッシュボードのセッション Cookie。

完全なリクエスト/レスポンス例は [`docs/API.md`](docs/API.md) を参照してください。

---

## 設定

| 変数 | デフォルト | 説明 |
|----------|---------|-------------|
| `VEGA_DB_PATH` | `./data/memory.db` | SQLite データベースのパス |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API のベース URL |
| `OLLAMA_MODEL` | `bge-m3` | 埋め込みモデル名 |
| `VEGA_API_KEY` | — | HTTP API に**必須**。`openssl rand -hex 16` で生成 |
| `VEGA_API_PORT` | `3271` | HTTP API ポート |
| `VEGA_TOKEN_BUDGET` | `2000` | セッション開始時に注入する最大トークン数 |
| `VEGA_SIMILARITY_THRESHOLD` | `0.85` | 重複排除の類似度閾値 |
| `VEGA_BACKUP_RETENTION_DAYS` | `7` | バックアップの保持日数 |
| `VEGA_MODE` | `server` | `server`（プライマリ）または `client`（リモート） |
| `VEGA_SERVER_URL` | — | リモート Vega サーバーの URL（クライアントモード） |
| `VEGA_CACHE_DB` | `~/.vega/cache.db` | ローカルキャッシュ DB（クライアントモード） |
| `VEGA_OBSERVER_ENABLED` | `false` | パッシブなツール観察を有効化 |
| `VEGA_TG_BOT_TOKEN` | — | アラート用 Telegram ボットトークン |
| `VEGA_TG_CHAT_ID` | — | アラート用 Telegram チャット ID |
| `VEGA_ENCRYPTION_KEY` | — | 暗号化エクスポート用の Hex キー |
| `VEGA_CLOUD_BACKUP_DIR` | — | クラウドバックアップの同期ディレクトリ |

> **セキュリティに関する注意：** すべてのシークレット（`VEGA_API_KEY`、`VEGA_TG_BOT_TOKEN`、`VEGA_ENCRYPTION_KEY`）は環境変数または `.env` ファイルで設定してください。バージョン管理にコミットしないでください。

---

## 仕組み

### メモリーのライフサイクル

```
作成 → アクティブ利用 → クールダウン → アーカイブ/マージ → クリーンアップ
```

1. **保存**：コンテンツがリダクション（シークレット除去）→ 埋め込み（Ollama bge-m3）→ 重複排除（類似度 >0.85 でマージ）→ SQLite に保存
2. **検索**：クエリを埋め込み → ハイブリッド検索（Vector 70% + BM25 30%、FTS5 経由）→ `類似度×0.5 + 重要度×0.3 + 新しさ×0.2` でランキング
3. **セッション**：`session_start` が 2000 トークン予算内で関連コンテキストを注入。`session_end` がサマリーから新しいメモリーを抽出
4. **メンテナンス**：日次バックアップ、週次コンパクション、欠落分の埋め込み再構築

### 信頼システム

| ステータス | 意味 | 検索ウェイト |
|--------|---------|--------------|
| `verified` | ユーザーが確認済み | ×1.0 |
| `unverified` | 自動抽出、未レビュー | ×0.7 |
| `rejected` | ユーザーが不正確と判定 | 除外 |
| `conflict` | 既存の確認済みメモリーと矛盾 | 解決のために表示 |

### クロスプロジェクト共有

メモリーは最初 `project` スコープで作成されます。2つ以上の異なるプロジェクトからアクセスされると、自動的に `global` スコープに昇格し、すべてのセッションで表示されます。

---

## 開発

### ビルドとテスト

```bash
rm -rf dist
npx tsc
node --test dist/tests/*.test.js
```

### プロジェクト構成

```
src/
├── index.ts              # MCP サーバーエントリーポイント
├── config.ts             # 設定ローダー
├── core/                 # メモリー、リコール、セッション、コンパクト、ライフサイクル
├── db/                   # SQLite スキーマ、リポジトリ、バックアップ、CRDT
├── embedding/            # Ollama 統合、キャッシュ
├── search/               # ブルートフォースエンジン、ランキング、ハイブリッド検索
├── security/             # リダクター、暗号化、RBAC、Keychain
├── mcp/                  # MCP ツール定義
├── cli/                  # CLI コマンド（commander.js）
├── api/                  # HTTP API ルート、認証
├── web/                  # ダッシュボード
├── scheduler/            # バックグラウンドデーモン
├── insights/             # パターン検出、インサイト生成
├── notify/               # Telegram、アラートファイル
├── sync/                 # リモートクライアント同期
├── plugins/              # プラグインローダー、SDK
└── tests/                # テストスイート
```

### プラグイン

プラグインは `data/plugins/<plugin-name>/plugin.json` から検出されます：

```json
{
  "name": "example-plugin",
  "version": "0.1.0",
  "main": "index.js"
}
```

スターターテンプレート：`vega templates list` / `vega templates install <name>`

---

## セキュリティ

- **機密データのリダクション**：API キー、トークン、パスワードは保存前に自動的に除去
- **保存時の暗号化**：macOS Keychain による鍵管理を備えたオプションの SQLCipher 暗号化
- **API 認証**：すべての HTTP API 呼び出しに Bearer トークンが必要
- **監査ログ**：すべての操作がアクター、タイムスタンプ、アクション付きで記録
- **安全な削除**：メモリーは暗黙的に削除されない — 通知 + ダウンロード猶予期間 + 確認が必要
- **ネットワークセキュリティ**：リモートアクセスには必ず VPN（Tailscale/WireGuard）を使用。API ポートをインターネットに直接公開しないこと

---

## ライセンス

MIT
