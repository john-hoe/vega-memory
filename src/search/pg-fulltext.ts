const quoteIdentifier = (value: string): string => `"${value.replaceAll(`"`, `""`)}"`;

const extractTokens = (value: string): string[] =>
  Array.from(value.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu), (match) => match[0]);

export class PgFullTextSearch {
  async search(
    query: string,
    options: { language?: string; limit?: number; tenantId?: string }
  ): Promise<{ id: string; rank: number }[]> {
    void query;
    void options;
    throw new Error("PgFullText not connected");
  }

  generateTsVectorDDL(tableName: string, columns: string[]): string {
    if (columns.length === 0) {
      throw new Error("PgFullTextSearch requires at least one column");
    }

    const quotedTableName = quoteIdentifier(tableName);
    const vectorColumnName = "search_vector";
    const indexName = quoteIdentifier(`${tableName}_${vectorColumnName}_gin_idx`);
    const documentExpression = columns
      .map((column) => `coalesce(${quoteIdentifier(column)}, '')`)
      .join(` || ' ' || `);

    return [
      `ALTER TABLE ${quotedTableName}`,
      `ADD COLUMN IF NOT EXISTS ${vectorColumnName} tsvector GENERATED ALWAYS AS (to_tsvector('simple', ${documentExpression})) STORED;`,
      `CREATE INDEX IF NOT EXISTS ${indexName} ON ${quotedTableName} USING GIN (${vectorColumnName});`
    ].join("\n");
  }

  toTsQuery(query: string, language = "simple"): string {
    void language;

    const parts = Array.from(query.matchAll(/"([^"]+)"|(\S+)/g), (match) => ({
      raw: match[0] ?? "",
      value: match[1] ?? match[2] ?? ""
    }));
    const terms = parts
      .map((part) => {
        const tokens = extractTokens(part.value);

        if (tokens.length === 0) {
          return "";
        }

        if (part.raw.startsWith(`"`)) {
          return tokens.map((token) => `${token}:*`).join(" <-> ");
        }

        return tokens.map((token) => `${token}:*`).join(" & ");
      })
      .filter((part) => part.length > 0);

    return terms.join(" & ");
  }
}
