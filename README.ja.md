[English](README.md) | [中文](README.zh-CN.md) | **日本語** | [한국어](README.ko.md)

# Vega Memory

複数の AI コーディング Agent で、同じ長期記憶を共有するための基盤。

Vega Memory は、Cursor、Codex、Claude Code、OpenClaw、その他 MCP または API 経由で動く Agent のための、ローカルファーストかつセルフホスト可能な共有メモリーレイヤーです。通常はセッション終了とともに失われる知識を、再利用可能なエンジニアリング記憶に変え、異なるツール・異なるマシン・異なるセッションでも同じ文脈を引き継げるようにします。

今日ある Agent が解決したことを、明日別の Agent がそのまま引き継げるようにする。それが Vega の価値です。

[5分で始める](#5分で始める) · [接続方法](#接続方法) · [デプロイ](#デプロイ方法) · [HTTP API](docs/API.md) · [デプロイドキュメント](docs/deployment.md) · [Issue](https://github.com/john-hoe/vega-memory/issues)

Vega は、汎用的なノートアプリやナレッジベースというより、Agent ワークフローの下層にある shared memory runtime として理解するのが最も適切です。

## なぜ Vega が必要なのか

多くの Agent ワークフローの本当のボトルネックは、モデルが弱いことではなく、前回何が起きたかを覚えていないことです。

共有メモリー層がない場合：

- 各ツールがそれぞれ独立した文脈サイロを持つ
- 新しいセッションで、プロンプトを読み込みすぎるか、重要な文脈を落とす
- 同じ修正、同じ判断、同じ落とし穴を何度も繰り返す
- リモートマシン、スクリプト、バックグラウンド処理がローカル Agent の経験を引き継げない

Vega はこれを再利用可能なループに変えます：

- タスク開始時に `session_start` で関連記憶を注入する
- 作業中に `memory_store` で再利用可能な知識を蓄積する
- 作業終了時に `session_end` で要約を記録し、知識を抽出する
- 次のセッションで `memory_recall` と session preload によって再利用する

## 誰に向いているか

Vega が特に向いているのは次のような人たちです：

- 同じプロジェクトで複数のコーディング Agent を使う個人開発者
- チームで共有 Agent メモリー層を持ちたい小規模エンジニアリングチーム
- セルフホストの Agent 基盤を作っている社内プラットフォームチーム
- MCP、CLI、HTTP の3つの入口を持つメモリーバックエンドが必要なツール開発者

もしあなたの課題が「複数 Agent で文脈を共有したい」「セッションをまたいで記憶を失いたくない」であるなら、Vega は単なる汎用知識プラットフォームとして見るよりずっと適しています。

## Vega の強み

- **単一チャットではなく共有メモリー**：ひとつの会話画面だけでなく、複数の Agent と複数の入口を前提にしている
- **クラウド前提ではなくローカルファースト**：SQLite とローカルモデルで動かせるため、プライバシー重視やオフライン運用に向く
- **デモではなくインフラとして設計**：MCP、CLI、HTTP API、dashboard、backup、audit、encryption、sync がすでに揃っている
- **ノート保存ではなくワークフロー継続性**：目的は知識を積むことより、次の Agent が本当に覚えている状態を作ること

## コア機能

- **共有メモリー原語**：`memory_store`、`memory_recall`、`memory_list`、`session_start`、`session_end`
- **ハイブリッド検索**：ベクトル検索、BM25、reranking、topic-aware recall、deep recall
- **運用信頼性**：履歴管理、監査ログ、コンパクション、バックアップ、DB 暗号化
- **複数の接続面**：MCP、CLI、HTTP API、dashboard
- **上位レイヤー機能**：wiki synthesis、graph 表示、multi-tenant 制御、analytics など

## 実行環境

- **推奨ランタイム**：Node 20 LTS
- **標準ストレージ**：SQLite（ローカルファースト）、既定の DB パスは `./data/memory.db`
- **標準 embedding 経路**：Ollama + `bge-m3`
- **フォールバック挙動**：Ollama がなくても動作はするが、検索はより保守的なキーワード / 非ベクトル経路に退避する

## 接続方法

| 接続方法 | 伝送方式 | 向いている用途 |
| --- | --- | --- |
| MCP | stdio | Cursor や他の MCP クライアントでの Agent ネイティブ接続 |
| CLI | shell | Codex、Claude Code、スクリプト、CI、ローカル端末ワークフロー |
| HTTP API | REST | リモートマシン、dashboard、独自統合、sync クライアント |

実務上の考え方はシンプルです：

- Agent に自動で呼ばせたいなら MCP
- スクリプトやターミナルに載せたいなら CLI
- リモート共有やバックグラウンド運用なら HTTP API

## 典型的なワークフロー

1. Agent がタスク開始時に `session_start` を呼ぶ
2. Vega がアクティブなタスク、設定、関連メモリー、事前警告を返す
3. 作業中に Agent が `memory_store` で再利用可能な知識を記録する
4. 作業終了時に `session_end` で要約と抽出知識を保存する
5. 次の Agent が同じ記憶をそのまま再利用する

このループこそが Vega のプロダクトの中核です。

## 5分で始める

### 1. クローンしてビルド

```bash
git clone https://github.com/john-hoe/vega-memory.git
cd vega-memory
npm install
npm run build
npm link
```

### 2. 最小構成を用意する

```bash
cp .env.example .env
```

ローカルでよく使う最小構成は次のとおりです：

```bash
VEGA_DB_PATH=./data/memory.db
VEGA_DB_ENCRYPTION=false
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=bge-m3
VEGA_API_KEY=change-me
VEGA_API_PORT=3271
```

### 3. 動作確認

```bash
vega health
```

### 4. 最小のメモリーループを試す

```bash
vega store "Always checkpoint WAL before copying SQLite backups" \
  --type pitfall \
  --project my-project \
  --title "SQLite backup checklist"

vega recall "sqlite backup" --project my-project
```

## デプロイ方法

Vega が現在想定している代表的なデプロイ経路は3つです。

### パターン A: ローカル単体マシン

個人開発やローカル中心のワークフローに向いています。

- SQLite をローカルの主ストアとして使う
- MCP エントリーポイントはクライアント側が必要時に起動する
- scheduler プロセスが HTTP API、dashboard、backup、maintenance を提供する

```bash
export VEGA_API_KEY="$(openssl rand -hex 16)"
node dist/scheduler/index.js
```

### パターン B: Docker / Compose

スタック全体をすぐに試したい場合に向いています。

```bash
docker compose up --build
```

現在の Compose は次を起動します：

- `vega`：scheduler + HTTP API
- `ollama`：ローカルモデルサービス

なお、同梱の Compose ファイルは外向けに `3000` ポートを公開しており、ドキュメント既定の `3271` とは異なります。

### パターン C: リモート共有モード

複数マシンや小規模チームで同じメモリー基盤を共有したい場合に向いています。

- server mode で中央集約的に Vega を動かす
- HTTP API または client mode から利用する
- ローカルキャッシュとリモート同期を併用する

## 最初に試すべきユースケース

初めて Vega を試すなら、まずは次のどれかから始めるのがよいです：

- Cursor、Codex、Claude Code で同じリポジトリの落とし穴を共有する
- 長寿命プロジェクトの判断や設定を、一時的なチャットではなく永続的に残す
- セルフホスト環境でチーム共有の Agent memory backend を作る
- 作業開始前の標準コンテキスト入口として `session_start` を使う

## 技術的な境界と正直な期待値

最初の理解を誤らせないために、次の境界は明示しておくべきです：

- Vega は現時点では SQLite ファーストであり、リモート共有や複数マシン対応は API と sync 層で拡張している
- HTTP API と dashboard は `VEGA_API_KEY` を明示的に設定したときだけ起動する
- dashboard は別アプリではなく scheduler プロセスが配信する
- Ollama が既定の embedding/provider 経路だが、他の provider も設定可能
- リモート MCP クライアントは現時点では軽量な互換レイヤーであり、ローカル MCP の完全な鏡ではない
- wiki、graph、analytics、billing などの機能は存在するが、初回採用時の主経路ではない

## アーキテクチャ概要

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

## 次にどこを見るか

- API 面を見たい: [HTTP API](docs/API.md)
- デプロイ詳細を見たい: [デプロイドキュメント](docs/deployment.md)
- Agent ごとの接続方法を見たい: この README の後半を読む
- 問題を報告したい: [GitHub Issues](https://github.com/john-hoe/vega-memory/issues)
- コミュニティ導線が欲しい: 今後の改善として discussions / docs 導線をさらに整理する余地がある
