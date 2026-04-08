import assert from "node:assert/strict";
import test from "node:test";

import { PgFullTextSearch } from "../search/pg-fulltext.js";
import { PgVectorSearch } from "../search/pg-vector.js";

test("PgVectorSearch.generateIndexDDL renders ivfflat DDL", () => {
  const search = new PgVectorSearch({
    dimensions: 1536,
    indexType: "ivfflat",
    lists: 100
  });

  assert.equal(
    search.generateIndexDDL(),
    `CREATE INDEX IF NOT EXISTS "memories_embedding_ivfflat_idx" ON "memories" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);`
  );
});

test("PgVectorSearch.generateIndexDDL renders hnsw DDL after createIndex selects the table", async () => {
  const search = new PgVectorSearch({
    dimensions: 1536,
    indexType: "hnsw",
    m: 16,
    efConstruction: 64
  });
  const messages: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);

  process.stderr.write = ((chunk: string | Uint8Array) => {
    messages.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await search.createIndex("memory_embeddings");

    assert.equal(
      search.generateIndexDDL(),
      `CREATE INDEX IF NOT EXISTS "memory_embeddings_embedding_hnsw_idx" ON "memory_embeddings" USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);`
    );
    assert.match(messages.join(""), /memory_embeddings_embedding_hnsw_idx/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("PgFullTextSearch.generateTsVectorDDL renders stored tsvector and gin index DDL", () => {
  const search = new PgFullTextSearch();

  assert.equal(
    search.generateTsVectorDDL("memories", ["title", "content"]),
    [
      `ALTER TABLE "memories"`,
      `ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("content", ''))) STORED;`,
      `CREATE INDEX IF NOT EXISTS "memories_search_vector_gin_idx" ON "memories" USING GIN (search_vector);`
    ].join("\n")
  );
});

test("PgFullTextSearch.toTsQuery converts keywords and phrases", () => {
  const search = new PgFullTextSearch();

  assert.equal(
    search.toTsQuery(`vector search "tenant filter"`),
    `vector:* & search:* & tenant:* <-> filter:*`
  );
});

test("PgVectorSearch.search throws the stub connection error", async () => {
  const search = new PgVectorSearch({
    dimensions: 3,
    indexType: "ivfflat"
  });

  await assert.rejects(
    search.search([0.1, 0.2, 0.3], 5),
    /PgVector execution requires an async PostgreSQL adapter/
  );
});

test("PgFullTextSearch.search throws the stub connection error", async () => {
  const search = new PgFullTextSearch();

  await assert.rejects(
    search.search("query", { limit: 5 }),
    /PgFullText execution requires an async PostgreSQL adapter/
  );
});

test("PgVectorSearch.search executes through the provided executor", async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const search = new PgVectorSearch({
    dimensions: 3,
    indexType: "ivfflat",
    executor: {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        calls.push({ sql, params });
        return {
          rows: [{ id: "m-1", distance: 0.12 }] as T[]
        };
      }
    }
  });

  const rows = await search.search([0.1, 0.2, 0.3], 5, {
    tenantId: "tenant-a"
  });

  assert.deepEqual(rows, [{ id: "m-1", distance: 0.12 }]);
  assert.match(calls[0]?.sql ?? "", /embedding <=> \$1::vector/);
  assert.deepEqual(calls[0]?.params, ["[0.1,0.2,0.3]", "tenant-a", 5]);
});

test("PgFullTextSearch.search executes through the provided executor", async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const search = new PgFullTextSearch({
    executor: {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        calls.push({ sql, params });
        return {
          rows: [{ id: "m-1", rank: 0.87 }] as T[]
        };
      }
    }
  });

  const rows = await search.search("memory system", {
    project: "vega",
    limit: 3
  });

  assert.deepEqual(rows, [{ id: "m-1", rank: 0.87 }]);
  assert.match(calls[0]?.sql ?? "", /ts_rank_cd/);
  assert.deepEqual(calls[0]?.params, ["memory:* & system:*", "vega", 3]);
});

test("PgVectorSearch.generateSearchSQL includes tenant and project filters", () => {
  const search = new PgVectorSearch({
    dimensions: 3,
    indexType: "ivfflat"
  });

  assert.deepEqual(
    search.generateSearchSQL([0.1, 0.2, 0.3], 7, {
      tenantId: "tenant-a",
      project: "vega"
    }),
    {
      sql: [
        `SELECT id, embedding <=> $1::vector AS distance`,
        `FROM "memories"`,
        `WHERE tenant_id = $2 AND project = $3`,
        `ORDER BY embedding <=> $1::vector ASC`,
        `LIMIT $4`
      ].join("\n"),
      params: ["[0.1,0.2,0.3]", "tenant-a", "vega", 7]
    }
  );
});

test("PgFullTextSearch.generateSearchSQL emits ranked tenant-aware SQL", () => {
  const search = new PgFullTextSearch();

  assert.deepEqual(
    search.generateSearchSQL(`vector search "tenant filter"`, {
      tenantId: "tenant-a",
      project: "vega",
      limit: 5
    }),
    {
      sql: [
        `SELECT id, ts_rank_cd(search_vector, to_tsquery('simple', $1)) AS rank`,
        `FROM "memories"`,
        `WHERE search_vector @@ to_tsquery('simple', $1) AND tenant_id = $2 AND project = $3`,
        `ORDER BY rank DESC, updated_at DESC`,
        `LIMIT $4`
      ].join("\n"),
      params: ["vector:* & search:* & tenant:* <-> filter:*", "tenant-a", "vega", 5]
    }
  );
});
