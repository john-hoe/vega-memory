import type { DatabaseAdapter } from "./adapter.js";

export const CANDIDATE_MEMORIES_TABLE = "candidate_memories";

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const CANDIDATE_MEMORY_DDL = `
  CREATE TABLE IF NOT EXISTS ${CANDIDATE_MEMORIES_TABLE} (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    type TEXT NOT NULL,
    project TEXT,
    tags TEXT,
    metadata TEXT,
    extraction_source TEXT NOT NULL,
    extraction_confidence REAL,
    promotion_score REAL NOT NULL DEFAULT 0,
    visibility_gated INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

// Columns that a pre-existing partial schema may be missing. Each entry must
// be safe to ALTER-ADD on a populated table (nullable or has DEFAULT).
const ADDITIVE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["tags", "tags TEXT"],
  ["metadata", "metadata TEXT"],
  ["extraction_confidence", "extraction_confidence REAL"],
  ["promotion_score", "promotion_score REAL NOT NULL DEFAULT 0"],
  ["visibility_gated", "visibility_gated INTEGER NOT NULL DEFAULT 1"]
];

const CANDIDATE_MEMORY_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_candidate_memories_project_created ON ${CANDIDATE_MEMORIES_TABLE}(project, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_candidate_memories_type ON ${CANDIDATE_MEMORIES_TABLE}(type)`,
  `CREATE INDEX IF NOT EXISTS idx_candidate_memories_promotion_score ON ${CANDIDATE_MEMORIES_TABLE}(promotion_score DESC)`
] as const;

export function applyCandidateMemoryMigration(db: DatabaseAdapter): void {
  db.exec(CANDIDATE_MEMORY_DDL);

  // Bring pre-existing partial schemas up to date additively before creating
  // indexes that reference newer columns. Without this, a table missing
  // `promotion_score` would make the promotion_score index creation fail.
  const columns = db
    .prepare<[], TableInfoRow>(`PRAGMA table_info(${CANDIDATE_MEMORIES_TABLE})`)
    .all();
  const columnNames = new Set(columns.map((column) => column.name));

  for (const [columnName, alterClause] of ADDITIVE_COLUMNS) {
    if (!columnNames.has(columnName)) {
      db.exec(`ALTER TABLE ${CANDIDATE_MEMORIES_TABLE} ADD COLUMN ${alterClause}`);
    }
  }

  for (const statement of CANDIDATE_MEMORY_INDEXES) {
    db.exec(statement);
  }
}
