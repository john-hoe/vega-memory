[English](README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md) | **한국어**

# Vega 메모리 시스템

AI 도구와 에이전트에 **영구적인 크로스 세션 메모리**를 제공하는 로컬 우선 메모리 서버입니다. Cursor, Claude Code, Codex, OpenClaw 또는 모든 MCP 호환 클라이언트를 연결하세요 — 모든 도구가 동일한 지식 베이스를 공유하므로, 한 세션에서 학습한 내용이 다음 세션에서 사라지지 않습니다.

### 주요 기능

- **기억** — 세션 간에 의사결정, 함정, 선호도, 프로젝트 컨텍스트를 보존합니다
- **회상** — 새로운 작업을 시작할 때 하이브리드 시맨틱 검색(Vector + BM25)으로 관련 경험을 불러옵니다
- **자동 중복 제거** — 동일한 내용을 두 번 저장하면 복제 대신 병합됩니다
- **사전 경고** — "지난번에 FFmpeg 작업 시 62%의 이슈가 경로 관련이었습니다"
- **오프라인 동작** — SQLite + 로컬 Ollama, 클라우드 의존성 없음, API 비용 없음

### 지원하는 AI 도구

| 도구 | 인터페이스 | 연결 방법 |
|------|-----------|----------|
| **Cursor** | MCP (stdio) | `~/.cursor/mcp.json`에 등록 — Agent가 메모리 도구를 자동 호출 |
| **Claude Code** | CLI | `CLAUDE.md`에 규칙 추가 — 셸에서 `vega recall/store` 실행 |
| **Codex CLI** | CLI | `AGENTS.md`에 규칙 추가 — 동일한 CLI 패턴 |
| **OpenClaw** | HTTP API | Agent가 `/api/recall`, `/api/store`를 HTTP로 호출 |
| **모든 MCP 클라이언트** | MCP (stdio) | Cursor와 동일한 설정 — MCP 호환 도구면 모두 사용 가능 |
| **스크립트 / CI** | CLI 또는 HTTP | `vega recall --json` 또는 `curl /api/recall` |

### 도입 전후 비교

| | Vega 없이 | Vega 사용 시 |
|---|---|---|
| 새 세션 컨텍스트 | 처음부터 시작하거나 전체 `AGENTS.md`(~4000 토큰)를 로드 | 관련 메모리만 로드(~500 토큰) |
| 크로스 세션 지식 | 대화 종료 시 소실 | SQLite에 영구 저장, 영원히 검색 가능 |
| 멀티 도구 일관성 | 각 도구가 독립된 사일로 | Cursor, Claude Code, Codex가 동일한 메모리 공유 |
| 같은 버그 반복 수정 | "이거 전에 해결하지 않았나?" | `session_start`가 이전 함정 기록을 자동 표시 |
| 원격 머신 | 수동으로 컨텍스트 복사-붙여넣기 | Tailscale로 자동 동기화, 오프라인 캐시 |

## 아키텍처

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

**세 가지 인터페이스, 하나의 메모리:**

| 인터페이스 | 전송 방식 | 적합한 용도 |
|-----------|----------|-----------|
| **MCP** | stdio | Cursor (Agent가 자동 호출) |
| **CLI** | shell | Claude Code, Codex, 스크립트, 모든 터미널 |
| **HTTP API** | REST | 원격 머신, 커스텀 통합, 웹 대시보드 |

---

## 사전 요구 사항

- **Node.js** 18+
- **Ollama**가 로컬에서 실행 중이며 `bge-m3` 모델이 풀링되어 있어야 합니다 (`ollama pull bge-m3`)

Ollama는 선택 사항입니다 — Ollama가 사용 불가능한 경우 Vega는 키워드 검색(FTS5)으로 자동 대체됩니다.

---

## 빠른 시작

### 1. 클론 및 빌드

```bash
git clone https://github.com/your-username/vega-memory.git
cd vega-memory
npm install
npm run build
npm link   # `vega` 명령어를 전역으로 사용 가능하게 합니다
```

### 2. 설정

환경 변수 예제 파일을 복사하고 값을 입력하세요:

```bash
cp .env.example .env
```

**`.env.example`:**
```bash
VEGA_DB_PATH=./data/memory.db
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=bge-m3
VEGA_API_KEY=              # HTTP API에 필수 — 강력한 랜덤 키를 생성하세요
VEGA_API_PORT=3271
VEGA_TG_BOT_TOKEN=         # 선택사항: 알림용 Telegram 봇 토큰
VEGA_TG_CHAT_ID=           # 선택사항: 알림용 Telegram 채팅 ID
```

> **보안:** `.env` 파일을 절대 git에 커밋하지 마세요. 강력한 API 키 생성: `openssl rand -hex 16`

### 3. 확인

```bash
vega health
```

상태 보고서가 표시됩니다. Ollama가 실행 중이면 `ollama: true`로 나타납니다.

### 4. 첫 번째 메모리 저장

```bash
vega store "Always use WAL mode for SQLite concurrent access" \
  --type decision --project my-project
```

### 5. 메모리 회상

```bash
vega recall "sqlite concurrency" --project my-project
```

### 6. AI 도구 연결

| 도구 | 인터페이스 | 설정 방법 |
|------|-----------|----------|
| **Cursor** | MCP (자동) | `~/.cursor/mcp.json`에 추가 → [Cursor 설정](#cursor-mcp--recommended) |
| **Claude Code** | CLI | `CLAUDE.md`에 규칙 추가 → [Claude Code 설정](#claude-code-cli) |
| **Codex CLI** | CLI | `AGENTS.md`에 규칙 추가 → [Codex 설정](#codex-cli-cli) |
| **OpenClaw / 커스텀** | HTTP API | `/api/*` 엔드포인트 호출 → [HTTP API 설정](#openclaw--custom-agents-http-api) |
| **모든 MCP 클라이언트** | MCP (stdio) | Cursor와 동일한 설정 |
| **스크립트 / CI** | CLI 또는 HTTP | `vega recall --json` 또는 `curl /api/recall` |

각 도구에 대한 자세한 내용은 아래 [AI 도구 연결](#connecting-ai-tools) 섹션을 참조하세요.

---

## 배포

### 옵션 A: 로컬 단일 머신 (권장 시작 방법)

모든 것이 하나의 머신에서 실행됩니다. MCP 서버는 세션마다 Cursor가 생성하며, 스케줄러 데몬이 백업, 압축, HTTP API를 위해 백그라운드에서 실행됩니다.

```bash
# 백그라운드 스케줄러 시작 (HTTP API + 대시보드 포함)
export VEGA_API_KEY=$(openssl rand -hex 16)
node dist/scheduler/index.js &

# 대시보드: http://127.0.0.1:3271
# 동일한 API 키로 로그인
```

**macOS에서 자동 시작** (launchd 사용):

```bash
# plist 생성 (경로를 조정하세요)
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

# 로드
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.vega-memory.plist
```

### 옵션 B: 서버 + 원격 클라이언트 (Tailscale)

Vega를 중앙 서버(예: 상시 가동 Mac mini 또는 VPS)에서 실행합니다. 원격 머신은 [Tailscale](https://tailscale.com) — 설정이 필요 없는 WireGuard 메시 VPN — 을 통해 HTTP API로 연결합니다.

#### 1단계: 모든 머신에 Tailscale 설치

```bash
# macOS
brew install tailscale
# 또는 https://tailscale.com/download 에서 다운로드

# Linux
curl -fsSL https://tailscale.com/install.sh | sh

# Windows
# https://tailscale.com/download/windows 에서 다운로드
```

각 머신에서 로그인:

```bash
sudo tailscale up
```

동일한 Tailscale 계정의 모든 머신이 이제 사설 암호화 네트워크(`100.x.x.x`)에 연결됩니다.

#### 2단계: 서버의 Tailscale IP 확인

서버(Vega가 실행 중인 머신)에서:

```bash
tailscale ip -4
# 출력: 100.x.x.x  (이것이 Tailscale IP입니다)
```

#### 3단계: 서버에서 Vega 시작

```bash
# 빌드 및 설정 (위의 빠른 시작 참조)
export VEGA_API_KEY=$(openssl rand -hex 16)
echo "Save this key: $VEGA_API_KEY"

node dist/scheduler/index.js
# API가 이제 모든 Tailscale 기기에서 http://100.x.x.x:3271로 접근 가능합니다
```

#### 4단계: 원격 머신 연결

각 원격 머신에서 (동일한 Tailscale 네트워크에 있어야 함):

```bash
npm install -g vega-memory   # 또는 클론 후 npm link

vega setup --server 100.x.x.x --port 3271 --api-key YOUR_API_KEY
```

이 명령어는 다음을 수행합니다:
1. 서버 연결 정보가 포함된 `~/.vega/config.json` 생성
2. `~/.cursor/mcp.json`에 클라이언트 모드로 Vega 등록
3. 오프라인 복원력을 위한 로컬 SQLite 캐시 설정

#### 5단계: 확인

```bash
# 원격 머신에서
vega health
# 표시 예상: status: "healthy", 서버에 연결됨

vega recall "test" --json
# 서버의 메모리 데이터베이스에서 결과를 반환해야 합니다
```

#### 오프라인 모드

원격 머신이 서버와의 연결을 잃으면(예: 인터넷 없음) Vega는 자동으로 로컬 캐시로 대체됩니다:

- **읽기**는 캐시된 사본에서 제공
- **쓰기**는 `~/.vega/pending/`에 큐잉
- **재연결** 시 자동 동기화 — 대기 중인 쓰기가 일반 중복 제거 파이프라인을 통해 전송

#### Tailscale ACL (선택적 보안 강화)

추가 보안을 위해 [Tailscale ACL 정책](https://login.tailscale.com/admin/acls)에서 Vega 포트에 접근할 수 있는 기기를 제한하세요:

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

> **보안:** Tailscale은 모든 트래픽에 WireGuard 암호화를 제공합니다. Vega API 포트(3271)는 Tailscale 네트워크 내에서만 접근 가능하며 — 공용 인터넷에는 절대 노출되지 않습니다. API 키는 네트워크 수준 보안 위에 추가적인 인증 계층을 제공합니다.

---

## AI 도구 연결

### Cursor (MCP — 권장)

Vega는 Cursor가 자동으로 호출하는 MCP 서버로 등록됩니다.

**1. `~/.cursor/mcp.json`에 추가:**

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

**2. Cursor 규칙 추가** — 워크스페이스에 `.cursor/rules/memory.mdc` 파일 생성:

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

**3. Cursor를 재시작하세요.** Agent가 이제 각 대화 시작 시 자동으로 `session_start`를 호출하고 작업 중에 메모리를 저장합니다.

---

### Claude Code (CLI)

Claude Code는 셸 명령어를 통해 `vega` CLI를 사용합니다. 프로젝트의 `CLAUDE.md`에 다음을 추가하세요:

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

### Codex CLI (CLI)

Claude Code와 동일한 패턴입니다. 프로젝트의 `AGENTS.md`에 추가하세요:

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

### Codex App (데스크톱 — 원격 MCP 연결)

Codex 데스크톱 앱은 MCP를 지원합니다. 원격 구성(예: Windows의 Codex가 Mac/Linux 서버의 Vega에 연결)에서는 `client/vega-remote-mcp.mjs`에 포함된 경량 원격 MCP 프록시를 사용하세요.

**1단계: 클라이언트 머신에서 클론 및 설치**

```powershell
# Windows PowerShell (or bash on Mac/Linux)
git clone https://github.com/john-hoe/vega-memory.git
cd vega-memory
npm install @modelcontextprotocol/sdk
```

> 클라이언트에는 SDK만 필요합니다 — 네이티브 의존성, SQLite, Ollama는 필요 없습니다.

**2단계: Codex App에 MCP 서버 추가**

Codex App 열기 → Settings → **MCP Servers** → Add:

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

| 변수 | 값 | 확인 방법 |
|----------|-------|-------------|
| `VEGA_SERVER_URL` | `http://100.x.x.x:3271` | 서버에서 `tailscale ip -4` 실행 |
| `VEGA_API_KEY` | 생성한 키 | 스케줄러를 시작할 때 사용한 키 |

> macOS/Linux에서는 경로를 `/path/to/vega-memory/client/vega-remote-mcp.mjs`로 바꾸세요.

**3단계: 사용자 지정 지침 추가**

Codex App → Settings → **Personalization** → Custom Instructions:

```
Follow CODEX.md and AGENTS.md rules strictly. Proactively store memories to Vega Memory (via MCP) as events happen — do NOT wait for user to ask. Each task completed, decision made, or bug fixed = one memory_store call immediately.
```

**4단계: 확인**

Codex App 대화에서 다음을 요청하세요:

```
Check Vega Memory health
```

에이전트가 `memory_health`를 호출해 서버 상태를 반환해야 합니다. `"status": "healthy"`가 표시되면 연결이 정상입니다.

---

### HTTP API (모든 도구 / 커스텀 통합)

HTTP 요청이 가능한 모든 도구에서 Vega를 사용할 수 있습니다. 인증은 Bearer 토큰 방식입니다.

```bash
# 메모리 저장
curl -X POST http://YOUR_SERVER:3271/api/store \
  -H "Authorization: Bearer $VEGA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Always checkpoint WAL before backup",
    "type": "pitfall",
    "project": "my-project"
  }'

# 메모리 회상
curl -X POST http://YOUR_SERVER:3271/api/recall \
  -H "Authorization: Bearer $VEGA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "sqlite backup", "project": "my-project", "limit": 5}'

# 세션 시작
curl -X POST http://YOUR_SERVER:3271/api/session/start \
  -H "Authorization: Bearer $VEGA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"working_directory": "/path/to/project"}'

# 상태 확인
curl -H "Authorization: Bearer $VEGA_API_KEY" \
  http://YOUR_SERVER:3271/api/health
```

전체 API 문서는 [`docs/API.md`](docs/API.md)를 참조하세요.

---

### OpenClaw / 커스텀 Agent (HTTP API)

OpenClaw 에이전트 또는 모든 커스텀 AI 에이전트에 HTTP API를 호출하도록 설정합니다. 에이전트 규칙 예시:

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

> **중요:** API 키는 항상 환경 변수를 통해 전달하세요. 에이전트 설정 파일에 자격 증명을 하드코딩하지 마세요.

---

## 자동 메모리 저장

Vega의 진짜 힘은 **자동** 메모리 저장입니다. AI 도구가 작업하는 동안 능동적으로 메모리를 저장하므로, 매번 "이거 기억해 줘"라고 말할 필요가 없습니다.

### 동작 방식

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

### 무엇이 저장되는가 (그리고 무엇은 안 되는가)

| 저장함 | 저장하지 않음 |
|-------|-------------|
| 추론이 담긴 결정 | 감정적인 불만 |
| 오류 메시지가 있는 버그 수정 | 아무 결과도 없었던 실패한 디버그 시도 |
| 파일 경로, 명령, 버전 번호 | 일회성 질문 |
| 아키텍처 선택 | 원시 데이터 덤프 |
| 사용자 선호 | 일반적인 프로그래밍 지식 |

**핵심 원칙:** 각 메모리는 하나의 구체적인 사실이며, 대화 요약이 아닙니다. 구체적인 내용(오류 메시지, 경로, 명령)을 보존하세요.

### 도구별 설정

#### Cursor (MCP — auto)

Cursor는 MCP 도구를 자동으로 호출합니다. 워크스페이스에 다음 규칙 파일을 추가하세요:

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

#### Claude Code (CLI)

Claude Code는 셸 명령을 사용합니다. 프로젝트의 **`CLAUDE.md`**에 추가하세요:

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

Claude Code와 동일한 패턴입니다. 프로젝트의 **`CODEX.md`**에 추가하세요:

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

#### Codex App (Desktop)

Codex 데스크톱 앱에서 MCP를 사용하는 경우 **Settings → Personalization → Custom Instructions**에 다음을 추가하세요:

```
Follow CODEX.md and AGENTS.md rules strictly. Proactively store memories to Vega Memory (via MCP) as events happen — do NOT wait for user to ask. Each task completed, decision made, or bug fixed = one memory_store call immediately.
```

#### OpenClaw / Custom Agents (HTTP API)

HTTP API를 사용하는 에이전트에는 다음을 지시하세요:

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

### 동작 확인

작업 세션 후 메모리가 저장되었는지 확인하세요:

```bash
# List recent memories
vega list --sort "created_at DESC" --json | head -20

# Check memory count
vega health --json | grep memories

# Search for something discussed in the session
vega recall "topic from your session"
```

메모리가 하나도 보이지 않으면 규칙 파일이 올바른 위치에 있는지, MCP 서버 또는 CLI에 접근할 수 있는지 확인하세요.

---

## CLI 레퍼런스

### 핵심 워크플로우

| 명령어 | 용도 |
|--------|------|
| `vega store <content> --type <type> --project <p>` | 메모리 저장 |
| `vega recall <query> [--project <p>] [--type <t>] [--json]` | 시맨틱 검색 |
| `vega list [--project <p>] [--type <t>] [--sort <s>]` | 메모리 목록 조회 |
| `vega session-start [--dir <path>] [--hint <text>]` | 세션 컨텍스트 로드 |
| `vega session-end --project <p> --summary <text>` | 세션 종료, 메모리 추출 |
| `vega health [--json]` | 시스템 상태 보고서 |

### 유지보수

| 명령어 | 용도 |
|--------|------|
| `vega compact [--project <p>]` | 중복 병합, 오래된 항목 아카이브 |
| `vega diagnose [--issue <text>]` | 진단 보고서 생성 |
| `vega backup [--cloud]` | 백업 생성 |
| `vega export [--format json\|md] [-o file]` | 메모리 내보내기 |
| `vega import <file>` | JSON 또는 Markdown에서 가져오기 |
| `vega compress [--project <p>] [--min-length 1200]` | Ollama를 통한 긴 메모리 압축 |
| `vega quality [--project <p>]` | 메모리 품질 점수 |
| `vega benchmark [--suite all\|write\|recall]` | 성능 벤치마크 |

### 지식 및 인덱싱

| 명령어 | 용도 |
|--------|------|
| `vega graph <entity> [--depth <n>]` | 지식 그래프 쿼리 |
| `vega index <dir> [--ext ts,tsx,js]` | 소스 코드 인덱싱 |
| `vega index-docs <path> [--project <p>]` | 마크다운 문서 인덱싱 |
| `vega git-import <repo> [--since <date>]` | git 히스토리 가져오기 |
| `vega generate-docs --project <p>` | 메모리로부터 문서 생성 |

### 설정 및 관리

| 명령어 | 용도 |
|--------|------|
| `vega setup --server <host> --port <port> --api-key <key>` | 원격 클라이언트 설정 |
| `vega init-encryption` | macOS Keychain에 암호화 키 생성 |
| `vega stats` | 타입/프로젝트/상태별 집계 |
| `vega audit [--actor <a>] [--action <a>]` | 감사 로그 조회 |
| `vega snapshot` | 마크다운 스냅샷 내보내기 |
| `vega plugins list` | 설치된 플러그인 목록 |
| `vega templates list` / `vega templates install <name>` | 스타터 템플릿 |

모든 명령어는 기계 판독 가능한 출력을 위해 `--json` 옵션을 지원합니다.

### 메모리 타입

| 타입 | 용도 | 감쇠 |
|------|------|------|
| `preference` | 사용자 선호도, 코딩 스타일 | 없음 |
| `project_context` | 아키텍처, 기술 스택, 구조 | 매우 느림 |
| `task_state` | 현재 작업 진행 상황 | 빠름 (완료 → 아카이브) |
| `pitfall` | 버그, 에러, 해결책 | 없음 |
| `decision` | 근거를 포함한 기술적 결정 | 보통 |
| `insight` | 자동 생성된 패턴 (시스템 전용) | 해당 없음 |

---

## MCP 도구

| 도구 | 용도 | 주요 파라미터 |
|------|------|-------------|
| `memory_store` | 메모리 저장 | `content`, `type`, `project?`, `title?`, `tags?` |
| `memory_recall` | 시맨틱 검색 | `query`, `project?`, `type?`, `limit?` |
| `memory_list` | 메모리 탐색 | `project?`, `type?`, `limit?`, `sort?` |
| `memory_update` | 메모리 수정 | `id`, `content?`, `importance?`, `tags?` |
| `memory_delete` | 메모리 삭제 | `id` |
| `session_start` | 세션 컨텍스트 로드 | `working_directory`, `task_hint?` |
| `session_end` | 세션 종료 | `project`, `summary`, `completed_tasks?` |
| `memory_health` | 상태 보고서 | — |
| `memory_compact` | 병합 및 아카이브 | `project?` |
| `memory_diagnose` | 진단 | `issue?` |
| `memory_graph` | 지식 그래프 쿼리 | `entity`, `depth` |
| `memory_compress` | Ollama를 통한 압축 | `memory_id?`, `project?`, `min_length?` |
| `memory_observe` | 패시브 도구 관찰 | `tool_name`, `project?`, `input?`, `output?` |

---

## HTTP API

스케줄러는 `VEGA_API_KEY`가 설정되면 인증된 REST API를 제공합니다.

| 경로 | 메서드 | 용도 |
|------|--------|------|
| `/` | `GET` | 웹 대시보드 (로그인 필요) |
| `/dashboard/login` | `POST` | API 키를 세션 쿠키로 교환 |
| `/dashboard/logout` | `POST` | 세션 클리어 |
| `/api/store` | `POST` | 메모리 저장 |
| `/api/recall` | `POST` | 메모리 회상 |
| `/api/list` | `GET` | 메모리 목록 조회 |
| `/api/memory/:id` | `PATCH` | 메모리 수정 |
| `/api/memory/:id` | `DELETE` | 메모리 삭제 |
| `/api/session/start` | `POST` | 세션 시작 |
| `/api/session/end` | `POST` | 세션 종료 |
| `/api/health` | `GET` | 상태 확인 |
| `/api/compact` | `POST` | 압축 실행 |

인증: `Authorization: Bearer <your-api-key>` 또는 대시보드 세션 쿠키.

전체 요청/응답 예시는 [`docs/API.md`](docs/API.md)를 참조하세요.

---

## 설정

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `VEGA_DB_PATH` | `./data/memory.db` | SQLite 데이터베이스 경로 |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API 기본 URL |
| `OLLAMA_MODEL` | `bge-m3` | 임베딩 모델 이름 |
| `VEGA_API_KEY` | — | HTTP API에 **필수**. `openssl rand -hex 16`으로 생성 |
| `VEGA_API_PORT` | `3271` | HTTP API 포트 |
| `VEGA_TOKEN_BUDGET` | `2000` | 세션 시작 시 주입되는 최대 토큰 수 |
| `VEGA_SIMILARITY_THRESHOLD` | `0.85` | 중복 제거 유사도 임계값 |
| `VEGA_BACKUP_RETENTION_DAYS` | `7` | 백업 보관 일수 |
| `VEGA_MODE` | `server` | `server` (기본) 또는 `client` (원격) |
| `VEGA_SERVER_URL` | — | 원격 Vega 서버 URL (클라이언트 모드) |
| `VEGA_CACHE_DB` | `~/.vega/cache.db` | 로컬 캐시 DB (클라이언트 모드) |
| `VEGA_OBSERVER_ENABLED` | `false` | 패시브 도구 관찰 활성화 |
| `VEGA_TG_BOT_TOKEN` | — | 알림용 Telegram 봇 토큰 |
| `VEGA_TG_CHAT_ID` | — | 알림용 Telegram 채팅 ID |
| `VEGA_ENCRYPTION_KEY` | — | 암호화된 내보내기용 Hex 키 |
| `VEGA_CLOUD_BACKUP_DIR` | — | 클라우드 백업 동기화 디렉토리 |

> **보안 주의:** 모든 비밀 정보(`VEGA_API_KEY`, `VEGA_TG_BOT_TOKEN`, `VEGA_ENCRYPTION_KEY`)는 환경 변수 또는 `.env` 파일을 통해 설정해야 합니다. 절대 버전 관리에 커밋하지 마세요.

---

## 동작 원리

### 메모리 라이프사이클

```
생성 → 활발한 사용 → 냉각 → 아카이브/병합 → 정리
```

1. **저장**: 콘텐츠 검열(비밀 정보 제거) → 임베딩(Ollama bge-m3) → 중복 제거(유사도 >0.85 이상이면 병합) → SQLite에 저장
2. **검색**: 쿼리 임베딩 → 하이브리드 검색(Vector 70% + BM25 30%, FTS5 사용) → `유사도×0.5 + 중요도×0.3 + 최신성×0.2`로 순위 결정
3. **세션**: `session_start`가 2000 토큰 예산 내에서 관련 컨텍스트를 주입. `session_end`가 요약에서 새로운 메모리를 추출
4. **유지보수**: 일일 백업, 주간 압축, 누락된 임베딩 재구축

### 신뢰 시스템

| 상태 | 의미 | 검색 가중치 |
|------|------|-----------|
| `verified` | 사용자가 확인함 | ×1.0 |
| `unverified` | 자동 추출, 아직 검토 안 됨 | ×0.7 |
| `rejected` | 사용자가 부정확하다고 표시 | 제외 |
| `conflict` | 기존 검증된 메모리와 충돌 | 해결을 위해 표시 |

### 프로젝트 간 공유

메모리는 `project` 범위로 시작합니다. 2개 이상의 서로 다른 프로젝트에서 접근하면 자동으로 `global` 범위로 승격되어 모든 세션에 나타납니다.

---

## 개발

### 빌드 및 테스트

```bash
rm -rf dist
npx tsc
node --test dist/tests/*.test.js
```

### 프로젝트 구조

```
src/
├── index.ts              # MCP 서버 진입점
├── config.ts             # 설정 로더
├── core/                 # 메모리, 회상, 세션, 압축, 라이프사이클
├── db/                   # SQLite 스키마, 리포지토리, 백업, CRDT
├── embedding/            # Ollama 통합, 캐시
├── search/               # 브루트포스 엔진, 랭킹, 하이브리드 검색
├── security/             # 검열기, 암호화, RBAC, Keychain
├── mcp/                  # MCP 도구 정의
├── cli/                  # CLI 명령어 (commander.js)
├── api/                  # HTTP API 라우트, 인증
├── web/                  # 대시보드
├── scheduler/            # 백그라운드 데몬
├── insights/             # 패턴 감지, 인사이트 생성
├── notify/               # Telegram, 알림 파일
├── sync/                 # 원격 클라이언트 동기화
├── plugins/              # 플러그인 로더, SDK
└── tests/                # 테스트 스위트
```

### 플러그인

플러그인은 `data/plugins/<plugin-name>/plugin.json`에서 검색됩니다:

```json
{
  "name": "example-plugin",
  "version": "0.1.0",
  "main": "index.js"
}
```

스타터 템플릿: `vega templates list` / `vega templates install <name>`.

---

## 보안

- **민감 데이터 검열**: API 키, 토큰, 비밀번호가 저장 전에 자동으로 제거됩니다
- **저장 시 암호화**: macOS Keychain 키 관리를 통한 선택적 SQLCipher 암호화
- **API 인증**: 모든 HTTP API 호출에 Bearer 토큰 필요
- **감사 로깅**: 모든 작업이 행위자, 타임스탬프, 액션과 함께 기록됩니다
- **안전한 삭제**: 메모리가 무단으로 삭제되지 않음 — 알림 + 다운로드 기간 + 확인 필요
- **네트워크 보안**: 원격 접근 시 항상 VPN(Tailscale/WireGuard) 사용. API 포트를 인터넷에 직접 노출하지 마세요

---

## 라이선스

MIT
