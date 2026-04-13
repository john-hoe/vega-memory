[English](README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md) | **한국어**

# Vega Memory

여러 AI 코딩 에이전트가 같은 장기 메모리를 공유하도록 만드는 기반 계층.

Vega Memory는 Cursor, Codex, Claude Code, OpenClaw, 그리고 MCP 또는 API 기반으로 동작하는 다른 에이전트를 위한 로컬 우선, 셀프호스트 가능한 공유 메모리 레이어입니다. 보통 세션이 끝나면 사라지는 지식을 다시 쓸 수 있는 엔지니어링 메모리로 바꿔 주어, 서로 다른 도구, 서로 다른 머신, 서로 다른 세션이 같은 문맥 위에서 계속 작업할 수 있게 합니다.

오늘 한 에이전트가 문제를 해결하고, 내일 다른 에이전트가 이어받더라도 Vega가 있으면 다시 처음부터 시작할 필요가 없습니다.

[5분 만에 시작하기](#5분-만에-시작하기) · [접속 방식](#접속-방식) · [배포](#배포-경로) · [HTTP API](docs/API.md) · [배포 문서](docs/deployment.md) · [이슈](https://github.com/john-hoe/vega-memory/issues)

Vega는 범용 노트 앱이나 일반 지식 베이스라기보다, 에이전트 워크플로의 하단에 위치한 shared memory runtime으로 이해하는 것이 가장 정확합니다.

## 왜 Vega가 필요한가

대부분의 에이전트 워크플로에서 진짜 병목은 모델이 약하다는 점이 아니라, 모델이 지난번에 무슨 일이 있었는지 기억하지 못한다는 점입니다.

공유 메모리 계층이 없으면:

- 각 도구가 서로 분리된 문맥 사일로를 갖게 됩니다
- 새 세션이 너무 많은 프롬프트를 다시 읽거나, 반대로 중요한 문맥을 놓칩니다
- 같은 수정, 같은 판단, 같은 함정을 계속 반복하게 됩니다
- 원격 머신, 스크립트, 백그라운드 작업이 로컬 에이전트의 경험을 이어받지 못합니다

Vega는 이것을 재사용 가능한 루프로 바꿉니다:

- 작업 시작 시 `session_start`로 관련 메모리를 주입하고
- 작업 중에는 `memory_store`로 재사용 가능한 지식을 쌓고
- 작업 종료 시 `session_end`로 요약과 지식을 저장하고
- 다음 세션에서는 `memory_recall`과 session preload로 다시 꺼내 씁니다

## 어떤 사용자에게 맞는가

Vega는 특히 다음 사용자에게 잘 맞습니다:

- 같은 프로젝트에서 여러 코딩 에이전트를 함께 쓰는 개인 개발자
- 팀 차원의 공유 에이전트 메모리 계층이 필요한 소규모 엔지니어링 팀
- 셀프호스트형 에이전트 인프라를 구축 중인 내부 플랫폼 팀
- MCP, CLI, HTTP 3가지 진입점을 가진 메모리 백엔드가 필요한 툴 제작자

핵심 문제가 “여러 에이전트가 세션을 넘어 같은 문맥을 공유해야 한다”라면, Vega는 일반 지식 플랫폼으로 보는 것보다 훨씬 잘 맞습니다.

## Vega의 강점

- **단일 채팅 메모리가 아니라 공유 메모리**: 하나의 대화창이 아니라 여러 에이전트와 여러 진입점을 전제로 합니다
- **클라우드 우선이 아니라 로컬 우선**: SQLite와 로컬 모델 경로를 기반으로 하므로 프라이버시 민감 환경과 오프라인 사용에 적합합니다
- **데모가 아니라 인프라 지향**: MCP, CLI, HTTP API, dashboard, backup, audit, encryption, sync가 이미 갖춰져 있습니다
- **노트 저장이 아니라 워크플로 연속성**: 목표는 메모를 쌓는 것이 아니라 다음 에이전트가 실제로 기억한 상태를 만드는 것입니다

## 핵심 기능

- **공유 메모리 원형 기능**: `memory_store`, `memory_recall`, `memory_list`, `session_start`, `session_end`
- **하이브리드 검색**: 벡터 검색, BM25, reranking, topic-aware recall, deep recall
- **운영 신뢰성**: 버전 이력, 감사 로그, compaction, 백업, 데이터베이스 암호화
- **다중 접속 표면**: MCP, CLI, HTTP API, dashboard
- **상위 레이어 기능**: wiki synthesis, graph 뷰, multi-tenant 제어, analytics 등

## 실행 환경

- **권장 런타임**: Node 20 LTS
- **기본 저장소**: SQLite, 로컬 우선, 기본 DB 경로는 `./data/memory.db`
- **기본 임베딩 경로**: Ollama + `bge-m3`
- **폴백 동작**: Ollama가 없어도 시스템은 동작하지만, 검색은 더 보수적인 키워드 / 비벡터 경로로 내려갑니다

## 접속 방식

| 방식 | 전송 방식 | 가장 적합한 용도 |
| --- | --- | --- |
| MCP | stdio | Cursor 및 다른 MCP 클라이언트에서의 에이전트 네이티브 연결 |
| CLI | shell | Codex, Claude Code, 스크립트, CI, 로컬 터미널 워크플로 |
| HTTP API | REST | 원격 머신, dashboard, 커스텀 통합, sync 클라이언트 |

실무적으로는 이렇게 보면 됩니다:

- 에이전트가 자동으로 메모리를 호출하게 하고 싶다면 MCP
- 스크립트나 터미널 중심이라면 CLI
- 원격 공유나 백그라운드 서비스가 필요하다면 HTTP API

## 전형적인 워크플로

1. 에이전트가 작업 시작 시 `session_start`를 호출합니다
2. Vega가 활성 작업, 선호, 관련 메모리, 사전 경고를 반환합니다
3. 작업 중에는 에이전트가 `memory_store`로 재사용 가능한 지식을 기록합니다
4. 작업 종료 시 `session_end`로 요약과 추출 지식을 저장합니다
5. 다음 에이전트가 같은 메모리를 이어서 사용합니다

이 루프가 곧 Vega의 핵심 제품입니다.

## 5분 만에 시작하기

### 1. 클론하고 빌드하기

```bash
git clone https://github.com/john-hoe/vega-memory.git
cd vega-memory
npm install
npm run build
npm link
```

### 2. 최소 환경 설정

```bash
cp .env.example .env
```

로컬에서 자주 쓰는 최소 설정은 다음과 같습니다:

```bash
VEGA_DB_PATH=./data/memory.db
VEGA_DB_ENCRYPTION=false
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=bge-m3
VEGA_API_KEY=change-me
VEGA_API_PORT=3271
```

### 3. 설치 확인

```bash
vega health
```

### 4. 가장 작은 메모리 루프 실행

```bash
vega store "Always checkpoint WAL before copying SQLite backups" \
  --type pitfall \
  --project my-project \
  --title "SQLite backup checklist"

vega recall "sqlite backup" --project my-project
```

## 배포 경로

Vega에서 현재 권장하는 대표 배포 경로는 세 가지입니다.

### 경로 A: 로컬 단일 머신 모드

개인 개발과 로컬 중심 워크플로에 적합합니다.

- SQLite를 기본 로컬 저장소로 사용합니다
- MCP 진입점은 클라이언트가 필요할 때마다 띄웁니다
- scheduler 프로세스가 HTTP API, dashboard, backup, maintenance를 제공합니다

```bash
export VEGA_API_KEY="$(openssl rand -hex 16)"
node dist/scheduler/index.js
```

### 경로 B: Docker / Compose

전체 스택을 빠르게 체험하고 싶을 때 적합합니다.

```bash
docker compose up --build
```

현재 Compose는 다음을 함께 올립니다:

- `vega`: scheduler + HTTP API
- `ollama`: 로컬 모델 서비스

참고로 저장소에 포함된 Compose 파일은 외부에 `3000` 포트를 노출하며, 문서 기본값 `3271`과는 다릅니다.

### 경로 C: 원격 공유 모드

여러 머신이나 소규모 팀이 같은 메모리 기반을 공유할 때 적합합니다.

- 중앙에서 server mode로 Vega를 운영하고
- HTTP API 또는 client mode를 통해 접근하며
- 로컬 캐시와 원격 동기화 동작을 함께 사용합니다

## 처음 시도하기 좋은 사용 사례

처음 Vega를 써본다면 다음 중 하나부터 시작하는 것이 좋습니다:

- Cursor, Codex, Claude Code가 같은 저장소에서 함정과 교훈을 공유하도록 만들기
- 오래 가는 프로젝트의 의사결정과 선호를 임시 채팅이 아니라 지속 메모리로 남기기
- 셀프호스트 환경에서 팀 공용 Agent memory backend 만들기
- 작업 시작 전 기본 문맥 주입 경로로 `session_start`를 사용하기

## 기술적 경계와 현실적인 기대치

첫인상에서 오해하지 않도록, 다음 경계는 미리 명확히 하는 것이 좋습니다:

- Vega는 현재 SQLite-first이며, 원격 공유와 다중 머신 사용은 API와 sync 계층으로 확장합니다
- HTTP API와 dashboard는 `VEGA_API_KEY`를 명시적으로 설정했을 때만 시작됩니다
- dashboard는 별도 프런트엔드 앱이 아니라 scheduler 프로세스가 제공합니다
- Ollama가 기본 embedding/provider 경로이지만 다른 provider도 설정할 수 있습니다
- 원격 MCP 클라이언트는 현재 경량 호환 레이어이며, 로컬 MCP 기능의 완전한 미러는 아닙니다
- wiki, graph, analytics, billing 등의 기능은 존재하지만 첫 도입 시의 주 학습 경로는 아닙니다

## 아키텍처 개요

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

## 다음에 어디를 보면 좋은가

- API 표면을 보고 싶다면: [HTTP API](docs/API.md)
- 배포 세부사항을 보고 싶다면: [배포 문서](docs/deployment.md)
- 에이전트별 연결 방법을 보고 싶다면: 이 README의 아래쪽 섹션을 계속 읽기
- 문제를 제보하고 싶다면: [GitHub Issues](https://github.com/john-hoe/vega-memory/issues)
- 커뮤니티 동선을 강화하고 싶다면: 향후 discussions / docs 진입 구조를 더 정리할 가치가 있습니다
