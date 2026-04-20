import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { createLogger, type Logger } from "../../core/logging/index.js";
import type { DatabaseAdapter } from "../../db/adapter.js";

import {
  applyHostMemoryFileFtsMigration,
  HOST_MEMORY_FILE_ENTRIES_TABLE,
  HOST_MEMORY_FILE_FTS_TABLE
} from "./host-memory-file-fts.js";
import {
  enumeratePaths,
  type HostMemoryFileParser,
  type HostMemorySurface
} from "./host-memory-file-paths.js";
import {
  parseJson,
  parseMarkdownFrontmatter,
  parsePlainText
} from "./host-memory-file-parser.js";
import type { SourceAdapter, SourceRecord, SourceSearchInput } from "./types.js";

const MAX_CONTENT_CHARS = 4096;
const DEFAULT_POLL_INTERVAL_MS = 30_000;

interface HostMemoryFileEntryRow {
  path: string;
  surface: string;
  mtime_ms: number;
  indexed_at: number;
}

interface HostMemoryFileSearchRow {
  path: string;
  surface: string;
  title: string | null;
  content: string;
  indexed_at: number;
  bm25_score: number;
}

export interface HostMemoryFileAdapterOptions {
  db: DatabaseAdapter;
  homeDir: string;
  logger?: Logger;
}

export interface HostMemoryFileReader {
  search(input: SourceSearchInput): ReadonlyArray<SourceRecord>;
  refreshIndex(): void;
  dispose(): void;
}

const truncateContent = (content: string): string =>
  content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS - 1)}…` : content;

const toContentSha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const toRawScore = (bm25Score: number): number =>
  Number.isFinite(bm25Score) ? 1 / (1 + Math.max(0, bm25Score)) : 0.5;

const resolvePollIntervalMs = (): number => {
  const parsed = Number.parseInt(process.env.VEGA_HOST_MEMORY_FILE_POLL_INTERVAL_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;
};

function parseContent(
  parser: HostMemoryFileParser,
  content: string
): { title?: string; body: string } {
  switch (parser) {
    case "markdown_frontmatter":
      return parseMarkdownFrontmatter(content);
    case "plain_text":
      return parsePlainText(content);
    case "json":
      return parseJson(content);
  }
}

export class HostMemoryFileAdapter implements SourceAdapter, HostMemoryFileReader {
  readonly kind = "host_memory_file";
  readonly name = "host-memory-file";
  readonly #db: DatabaseAdapter;
  readonly #homeDir: string;
  readonly #logger: Logger;
  readonly #pollIntervalMs: number;
  #pollTimer: NodeJS.Timeout | null = null;
  #refreshInFlight = false;

  constructor(options: HostMemoryFileAdapterOptions) {
    this.#db = options.db;
    this.#homeDir = options.homeDir;
    this.#logger =
      options.logger ?? createLogger({ name: "retrieval-source-host-memory-file" });
    this.#pollIntervalMs = resolvePollIntervalMs();

    if (!this.#db.isPostgres) {
      applyHostMemoryFileFtsMigration(this.#db);
    }

    if (this.enabled) {
      this.refreshIndex();
      this.#pollTimer = setInterval(() => this.refreshIndex(), this.#pollIntervalMs);
      this.#pollTimer.unref?.();
    }
  }

  get enabled(): boolean {
    return !this.#db.isPostgres && process.env.VEGA_HOST_MEMORY_FILE_ENABLED !== "false";
  }

  search(input: SourceSearchInput): SourceRecord[] {
    if (!this.enabled) {
      return [];
    }

    const query = input.request.query?.trim() ?? "";

    if (query.length === 0) {
      return [];
    }

    const rows = this.#db.prepare<[string, number], HostMemoryFileSearchRow>(
      `SELECT
        ${HOST_MEMORY_FILE_FTS_TABLE}.path AS path,
        ${HOST_MEMORY_FILE_FTS_TABLE}.surface AS surface,
        ${HOST_MEMORY_FILE_FTS_TABLE}.title AS title,
        ${HOST_MEMORY_FILE_FTS_TABLE}.content AS content,
        ${HOST_MEMORY_FILE_ENTRIES_TABLE}.indexed_at AS indexed_at,
        bm25(${HOST_MEMORY_FILE_FTS_TABLE}) AS bm25_score
      FROM ${HOST_MEMORY_FILE_FTS_TABLE}
      JOIN ${HOST_MEMORY_FILE_ENTRIES_TABLE}
        ON ${HOST_MEMORY_FILE_ENTRIES_TABLE}.path = ${HOST_MEMORY_FILE_FTS_TABLE}.path
      WHERE ${HOST_MEMORY_FILE_FTS_TABLE} MATCH ?
      ORDER BY bm25_score ASC, ${HOST_MEMORY_FILE_FTS_TABLE}.path ASC
      LIMIT ?`
    ).all(query, Math.max(1, input.top_k));

    return rows.map((row): SourceRecord => ({
      id: `host-memory-file:${row.path}:0`,
      source_kind: "host_memory_file",
      content: truncateContent(row.content.trim()),
      provenance: {
        origin: row.path,
        retrieved_at: new Date(row.indexed_at).toISOString()
      },
      raw_score: toRawScore(row.bm25_score),
      metadata: {
        surface: row.surface,
        title: row.title ?? undefined
      }
    }));
  }

  refreshIndex(): void {
    if (!this.enabled || this.#refreshInFlight) {
      return;
    }

    this.#refreshInFlight = true;

    try {
      this.#db.transaction(() => {
        const existingEntries = this.#db
          .prepare<[], HostMemoryFileEntryRow>(
            `SELECT path, surface, mtime_ms, indexed_at FROM ${HOST_MEMORY_FILE_ENTRIES_TABLE}`
          )
          .all();
        const existingByPath = new Map(existingEntries.map((entry) => [entry.path, entry]));
        const discoveredPaths = enumeratePaths(this.#homeDir);
        const seenPaths = new Set<string>();

        for (const discovered of discoveredPaths) {
          seenPaths.add(discovered.path);
          let fileStats;

          try {
            fileStats = statSync(discovered.path);
          } catch (error) {
            this.#logger.warn("Host memory file stat failed during refresh; skipping file", {
              path: discovered.path,
              error: error instanceof Error ? error.message : String(error)
            });
            continue;
          }

          if (!fileStats.isFile()) {
            continue;
          }

          const mtimeMs = Math.floor(fileStats.mtimeMs);
          const existingEntry = existingByPath.get(discovered.path);

          if (existingEntry?.mtime_ms === mtimeMs) {
            continue;
          }

          try {
            const rawContent = readFileSync(discovered.path, "utf8");
            const parsed = parseContent(discovered.parser, rawContent);
            const indexedAt = Math.max(Date.now(), (existingEntry?.indexed_at ?? 0) + 1);

            this.#db.run(
              `INSERT INTO ${HOST_MEMORY_FILE_ENTRIES_TABLE} (
                path,
                surface,
                mtime_ms,
                indexed_at,
                file_size_bytes,
                content_sha256
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(path) DO UPDATE SET
                surface = excluded.surface,
                mtime_ms = excluded.mtime_ms,
                indexed_at = excluded.indexed_at,
                file_size_bytes = excluded.file_size_bytes,
                content_sha256 = excluded.content_sha256`,
              discovered.path,
              discovered.surface,
              mtimeMs,
              indexedAt,
              fileStats.size,
              toContentSha256(rawContent)
            );
            this.#db.run(`DELETE FROM ${HOST_MEMORY_FILE_FTS_TABLE} WHERE path = ?`, discovered.path);
            this.#db.run(
              `INSERT INTO ${HOST_MEMORY_FILE_FTS_TABLE} (path, surface, title, content) VALUES (?, ?, ?, ?)`,
              discovered.path,
              discovered.surface,
              parsed.title ?? null,
              parsed.body
            );
          } catch (error) {
            this.#logger.warn("Host memory file refresh failed; skipping file", {
              path: discovered.path,
              parser: discovered.parser,
              surface: discovered.surface,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }

        for (const entry of existingEntries) {
          if (seenPaths.has(entry.path)) {
            continue;
          }

          this.#db.run(`DELETE FROM ${HOST_MEMORY_FILE_FTS_TABLE} WHERE path = ?`, entry.path);
          this.#db.run(`DELETE FROM ${HOST_MEMORY_FILE_ENTRIES_TABLE} WHERE path = ?`, entry.path);
        }
      });
    } finally {
      this.#refreshInFlight = false;
    }
  }

  dispose(): void {
    if (this.#pollTimer === null) {
      return;
    }

    clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }
}

export function createHostMemoryFileSource(
  options?: HostMemoryFileAdapterOptions
): SourceAdapter {
  if (options === undefined) {
    return {
      kind: "host_memory_file",
      name: "host-memory-file",
      enabled: true,
      search() {
        return [];
      }
    };
  }

  return new HostMemoryFileAdapter(options);
}
