// pgvector search stub — requires PostgreSQL with pgvector extension. Install: CREATE EXTENSION vector;

export interface PgVectorConfig {
  dimensions: number;
  indexType: "ivfflat" | "hnsw";
  lists?: number;
  m?: number;
  efConstruction?: number;
}

const quoteIdentifier = (value: string): string => `"${value.replaceAll(`"`, `""`)}"`;

export class PgVectorSearch {
  private tableName = "memories";

  constructor(private config: PgVectorConfig) {}

  async createIndex(tableName: string): Promise<void> {
    this.tableName = tableName;
    process.stderr.write(`${this.generateIndexDDL()}\n`);
  }

  async search(
    embedding: number[],
    limit: number,
    filter?: { tenantId?: string; project?: string }
  ): Promise<{ id: string; distance: number }[]> {
    void embedding;
    void limit;
    void filter;
    throw new Error("PgVector not connected");
  }

  async upsert(id: string, embedding: number[], metadata?: Record<string, unknown>): Promise<void> {
    void id;
    void embedding;
    void metadata;
  }

  async delete(id: string): Promise<void> {
    void id;
  }

  generateIndexDDL(): string {
    const quotedTableName = quoteIdentifier(this.tableName);
    const quotedIndexName = quoteIdentifier(`${this.tableName}_embedding_${this.config.indexType}_idx`);
    const parameters =
      this.config.indexType === "ivfflat"
        ? this.config.lists === undefined
          ? []
          : [`lists = ${this.config.lists}`]
        : [
            ...(this.config.m === undefined ? [] : [`m = ${this.config.m}`]),
            ...(this.config.efConstruction === undefined
              ? []
              : [`ef_construction = ${this.config.efConstruction}`])
          ];
    const withClause = parameters.length === 0 ? "" : ` WITH (${parameters.join(", ")})`;

    return `CREATE INDEX IF NOT EXISTS ${quotedIndexName} ON ${quotedTableName} USING ${this.config.indexType} (embedding vector_cosine_ops)${withClause};`;
  }
}
