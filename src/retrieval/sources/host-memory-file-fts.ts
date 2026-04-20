import type { DatabaseAdapter } from "../../db/adapter.js";

export const HOST_MEMORY_FILE_FTS_TABLE = "host_memory_file_fts";
export const HOST_MEMORY_FILE_ENTRIES_TABLE = "host_memory_file_entries";

const HOST_MEMORY_FILE_FTS_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS ${HOST_MEMORY_FILE_FTS_TABLE}
  USING fts5(
    path UNINDEXED,
    surface UNINDEXED,
    title,
    content,
    tokenize='porter unicode61'
  )
`;

const HOST_MEMORY_FILE_ENTRIES_DDL = `
  CREATE TABLE IF NOT EXISTS ${HOST_MEMORY_FILE_ENTRIES_TABLE} (
    path TEXT PRIMARY KEY,
    surface TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    content_sha256 TEXT NOT NULL
  )
`;

const HOST_MEMORY_FILE_ENTRIES_INDEXES = [
  `CREATE INDEX IF NOT EXISTS host_memory_file_entries_surface_idx ON ${HOST_MEMORY_FILE_ENTRIES_TABLE} (surface)`
] as const;

export function applyHostMemoryFileFtsMigration(db: DatabaseAdapter): void {
  if (db.isPostgres) return;

  db.exec(HOST_MEMORY_FILE_FTS_DDL);
  db.exec(HOST_MEMORY_FILE_ENTRIES_DDL);

  for (const statement of HOST_MEMORY_FILE_ENTRIES_INDEXES) {
    db.exec(statement);
  }
}
