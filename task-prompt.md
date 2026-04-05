Task 48-52: Phase 7 — Performance + Scale (all 5 tasks).

Read AGENTS.md for rules. Read ALL src/ files to understand the current codebase.

## Task 48: sqlite-vec Production Deployment
Files: src/search/sqlite-vec.ts, src/search/engine.ts
- Improve SqliteVecEngine.createIndex() to build a persistent in-memory index from all embeddings
- Add rebuildIndex() method that forces a full re-index
- SearchEngine should log when switching from brute-force to sqlite-vec
- Add CLI command: vega reindex (force rebuild vector index)
- If sqlite-vec extension is available, auto-build index on first search

## Task 49: Memory Sharding
File: src/db/shard.ts
Export class ShardManager:
  - constructor(baseDir: string)
  - getShardPath(project: string): string
    Return path: baseDir/shards/<project>.db
  - getOrCreateShard(project: string): Repository
    If shard exists, open it. Otherwise create new shard db.
    Cache open connections.
  - listShards(): string[]
    List all project shard files
  - closeAll(): void
    Close all cached connections

This is foundation — the main repository stays as primary, sharding is opt-in for large-scale use.
Add config: shardingEnabled: boolean (default false, from VEGA_SHARDING_ENABLED)

## Task 50: Streaming Search
File: src/search/streaming.ts
Export class StreamingSearch:
  - constructor(repository: Repository, config: VegaConfig)
  - async *searchStream(query: string, queryEmbedding: Float32Array | null, options: SearchOptions): AsyncGenerator<SearchResult>
    Yield results one at a time instead of collecting all in memory
    Process in chunks of 100 memories
    Apply ranking as results are yielded
  
This is useful for very large memory sets. Regular search stays as default.
Add to API: GET /api/recall/stream (SSE endpoint, optional)

## Task 51: Embedding Cache
File: src/embedding/cache.ts
Export class EmbeddingCache:
  - constructor(maxSize: number = 1000)
  - get(text: string): Float32Array | undefined
    LRU cache lookup by content hash
  - set(text: string, embedding: Float32Array): void
    Store with LRU eviction
  - clear(): void
  - size(): number
  - hitRate(): { hits: number, misses: number, rate: number }

Integrate into src/embedding/ollama.ts generateEmbedding():
  Before calling Ollama, check cache. On cache hit, return cached. On miss, call Ollama and cache result.

## Task 52: Search Relevance Tuning
File: src/search/tuning.ts
Export class RelevanceTuner:
  - constructor(repository: Repository)
  - analyzeSearchQuality(): SearchQualityReport
    1. Get last 100 recall operations from performance_log
    2. Calculate: avg latency, avg result count, % of recalls returning 0 results
    3. Analyze: avg similarity scores, distribution of memory types in results
    Return report with recommendations

  - suggestWeightAdjustments(): { vectorWeight: number, bm25Weight: number, similarityThreshold: number }
    Based on analysis: if too many zero-result recalls, suggest lowering threshold
    If BM25 results rarely appear, suggest increasing bm25Weight

Add CLI: vega tune (print tuning analysis and suggestions)

SearchQualityReport = { avg_latency_ms, avg_results, zero_result_pct, type_distribution, recommendations: string[] }

## Tests:
File: src/tests/performance.test.ts
- Test: EmbeddingCache get/set/eviction cycle
- Test: EmbeddingCache.hitRate tracks hits and misses
- Test: ShardManager.getShardPath returns correct path
- Test: ShardManager.getOrCreateShard creates new shard
- Test: ShardManager.listShards returns shard names
- Test: StreamingSearch yields results progressively (use mock data)
- Test: RelevanceTuner.analyzeSearchQuality returns valid report

After all:
  rm -rf dist && npx tsc
  node --test dist/tests/performance.test.js
  node --test dist/tests/*.test.js

Then commit:
  git add -A && git commit -m "feat: Phase 7 — sqlite-vec production, sharding, streaming search, embedding cache, relevance tuning"
  git tag v0.9.0-phase7
  git push origin main --tags
