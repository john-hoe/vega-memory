import { v4 as uuidv4 } from "uuid";

import type { SourceKind } from "../core/contracts/enums.js";
import { createLogger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "./adapter.js";
import {
  applyCandidateMemoryMigration,
  CANDIDATE_MEMORIES_TABLE,
  DEFAULT_CANDIDATE_SOURCE_KIND,
  DEFAULT_CANDIDATE_STATE
} from "./candidate-memory-migration.js";

export type CandidateState = "pending" | "held" | "ready" | "discarded";

export interface CandidateMemoryRecord {
  id: string;
  content: string;
  type: string;
  project: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  extraction_source: string;
  extraction_confidence: number | null;
  promotion_score: number;
  visibility_gated: boolean;
  candidate_state: CandidateState;
  source_kind?: SourceKind | null;
  raw_dedup_key: string | null;
  semantic_fingerprint: string | null;
  created_at: number;
  updated_at: number;
}

export interface CandidateMemoryCreateInput {
  id?: string;
  content: string;
  type: string;
  project?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  extraction_source: string;
  extraction_confidence?: number | null;
  visibility_gated?: boolean;
  candidate_state?: CandidateState;
  source_kind?: SourceKind;
  raw_dedup_key?: string | null;
  semantic_fingerprint?: string | null;
}

export interface CandidateQuery {
  project?: string | null;
  type?: string;
  limit?: number;
  since?: number;
  visibility_gated?: boolean;    // When set, filter to rows matching this flag BEFORE LIMIT.
  state?: CandidateState;
  raw_dedup_key?: string | null;
  semantic_fingerprint?: string | null;
}

export interface CandidateRepository {
  create(input: CandidateMemoryCreateInput): CandidateMemoryRecord;
  findById(id: string): CandidateMemoryRecord | undefined;
  list(query?: CandidateQuery): CandidateMemoryRecord[];
  findByRawDedupKey(raw_dedup_key: string): CandidateMemoryRecord | undefined;
  findBySemanticFingerprint(semantic_fingerprint: string): CandidateMemoryRecord | undefined;
  delete(id: string): boolean;
  updateState(id: string, state: CandidateState): boolean;
  size(): number;
}

export interface CandidateRepositoryOptions {
  now?: () => number;
}

interface CandidateMemoryRow {
  id: string;
  content: string;
  type: string;
  project: string | null;
  tags: string | null;
  metadata: string | null;
  extraction_source: string;
  extraction_confidence: number | null;
  promotion_score: number;
  visibility_gated: number;
  candidate_state: CandidateState;
  source_kind: SourceKind | null;
  raw_dedup_key: string | null;
  semantic_fingerprint: string | null;
  created_at: number;
  updated_at: number;
}

const DEFAULT_LIST_LIMIT = 50;
const logger = createLogger({ name: "candidate-repository" });

function parseTags(value: string | null, id: string): string[] {
  if (value === null || value.length === 0) {
    return [];
  }

  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid tags payload for candidate ${id}`);
  }

  return parsed;
}

function parseMetadata(value: string | null, id: string): Record<string, unknown> {
  if (value === null || value.length === 0) {
    return {};
  }

  const parsed = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid metadata payload for candidate ${id}`);
  }

  return parsed as Record<string, unknown>;
}

function toRecord(row: CandidateMemoryRow): CandidateMemoryRecord | undefined {
  try {
    return {
      id: row.id,
      content: row.content,
      type: row.type,
      project: row.project,
      tags: parseTags(row.tags, row.id),
      metadata: parseMetadata(row.metadata, row.id),
      extraction_source: row.extraction_source,
      extraction_confidence: row.extraction_confidence,
      promotion_score: row.promotion_score ?? 0,
      visibility_gated: row.visibility_gated === 1,
      candidate_state: row.candidate_state ?? DEFAULT_CANDIDATE_STATE,
      source_kind: row.source_kind ?? DEFAULT_CANDIDATE_SOURCE_KIND,
      raw_dedup_key: row.raw_dedup_key ?? null,
      semantic_fingerprint: row.semantic_fingerprint ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  } catch (error) {
    logger.warn("Candidate repository row parse failed", {
      candidate_id: row.id,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

function resolveLimit(limit?: number): number {
  return Number.isInteger(limit) && limit !== undefined && limit > 0 ? limit : DEFAULT_LIST_LIMIT;
}

export function createCandidateRepository(
  db: DatabaseAdapter,
  options: CandidateRepositoryOptions = {}
): CandidateRepository {
  applyCandidateMemoryMigration(db);

  const now = options.now ?? (() => Date.now());

  const insertStatement = db.prepare<
    [string, string, string, string | null, string, string, string, number | null, number, number, CandidateState, SourceKind, string | null, string | null, number, number],
    never
  >(
    `INSERT INTO ${CANDIDATE_MEMORIES_TABLE} (
      id,
      content,
      type,
      project,
      tags,
      metadata,
      extraction_source,
      extraction_confidence,
      promotion_score,
      visibility_gated,
      candidate_state,
      source_kind,
      raw_dedup_key,
      semantic_fingerprint,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const findStatement = db.prepare<[string], CandidateMemoryRow>(
    `SELECT
      id,
      content,
      type,
      project,
      tags,
      metadata,
      extraction_source,
      extraction_confidence,
      promotion_score,
      visibility_gated,
      candidate_state,
      source_kind,
      raw_dedup_key,
      semantic_fingerprint,
      created_at,
      updated_at
    FROM ${CANDIDATE_MEMORIES_TABLE}
    WHERE id = ?`
  );
  const findByRawDedupKeyStatement = db.prepare<[string], CandidateMemoryRow>(
    `SELECT
      id,
      content,
      type,
      project,
      tags,
      metadata,
      extraction_source,
      extraction_confidence,
      promotion_score,
      visibility_gated,
      candidate_state,
      source_kind,
      raw_dedup_key,
      semantic_fingerprint,
      created_at,
      updated_at
    FROM ${CANDIDATE_MEMORIES_TABLE}
    WHERE raw_dedup_key = ?
    ORDER BY created_at DESC
    LIMIT 1`
  );
  const findBySemanticFingerprintStatement = db.prepare<[string], CandidateMemoryRow>(
    `SELECT
      id,
      content,
      type,
      project,
      tags,
      metadata,
      extraction_source,
      extraction_confidence,
      promotion_score,
      visibility_gated,
      candidate_state,
      source_kind,
      raw_dedup_key,
      semantic_fingerprint,
      created_at,
      updated_at
    FROM ${CANDIDATE_MEMORIES_TABLE}
    WHERE semantic_fingerprint = ?
    ORDER BY created_at DESC
    LIMIT 1`
  );
  const updateStateStatement = db.prepare<[CandidateState, number, string], never>(
    `UPDATE ${CANDIDATE_MEMORIES_TABLE}
    SET candidate_state = ?, updated_at = ?
    WHERE id = ?`
  );

  return {
    create(input): CandidateMemoryRecord {
      const id = input.id ?? uuidv4();
      const created_at = now();
      const record: CandidateMemoryRecord = {
        id,
        content: input.content,
        type: input.type,
        project: input.project ?? null,
        tags: input.tags ?? [],
        metadata: input.metadata ?? {},
        extraction_source: input.extraction_source,
        extraction_confidence: input.extraction_confidence ?? null,
        promotion_score: 0,
        visibility_gated: input.visibility_gated ?? true,
        candidate_state: input.candidate_state ?? DEFAULT_CANDIDATE_STATE,
        source_kind: input.source_kind ?? DEFAULT_CANDIDATE_SOURCE_KIND,
        raw_dedup_key: input.raw_dedup_key ?? null,
        semantic_fingerprint: input.semantic_fingerprint ?? null,
        created_at,
        updated_at: created_at
      };

      insertStatement.run(
        record.id,
        record.content,
        record.type,
        record.project,
        JSON.stringify(record.tags),
        JSON.stringify(record.metadata),
        record.extraction_source,
        record.extraction_confidence,
        record.promotion_score,
        record.visibility_gated ? 1 : 0,
        record.candidate_state,
        record.source_kind ?? DEFAULT_CANDIDATE_SOURCE_KIND,
        record.raw_dedup_key,
        record.semantic_fingerprint,
        record.created_at,
        record.updated_at
      );

      return record;
    },
    findById(id): CandidateMemoryRecord | undefined {
      const row = findStatement.get(id);
      return row === undefined ? undefined : toRecord(row);
    },
    list(query: CandidateQuery = {}): CandidateMemoryRecord[] {
      const clauses: string[] = [];
      const params: unknown[] = [];

      if (query.project !== undefined) {
        if (query.project === null) {
          clauses.push("project IS NULL");
        } else {
          clauses.push("project = ?");
          params.push(query.project);
        }
      }

      if (query.type !== undefined) {
        clauses.push("type = ?");
        params.push(query.type);
      }

      if (query.since !== undefined) {
        clauses.push("created_at >= ?");
        params.push(query.since);
      }

      if (query.visibility_gated !== undefined) {
        clauses.push("visibility_gated = ?");
        params.push(query.visibility_gated ? 1 : 0);
      }

      if (query.state !== undefined) {
        clauses.push("candidate_state = ?");
        params.push(query.state);
      }

      if (query.raw_dedup_key !== undefined) {
        if (query.raw_dedup_key === null) {
          clauses.push("raw_dedup_key IS NULL");
        } else {
          clauses.push("raw_dedup_key = ?");
          params.push(query.raw_dedup_key);
        }
      }

      if (query.semantic_fingerprint !== undefined) {
        if (query.semantic_fingerprint === null) {
          clauses.push("semantic_fingerprint IS NULL");
        } else {
          clauses.push("semantic_fingerprint = ?");
          params.push(query.semantic_fingerprint);
        }
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db.all<CandidateMemoryRow>(
        `SELECT
          id,
          content,
          type,
          project,
          tags,
          metadata,
          extraction_source,
          extraction_confidence,
          promotion_score,
          visibility_gated,
          candidate_state,
          source_kind,
          raw_dedup_key,
          semantic_fingerprint,
          created_at,
          updated_at
        FROM ${CANDIDATE_MEMORIES_TABLE}
        ${where}
        ORDER BY created_at DESC
        LIMIT ?`,
        ...params,
        resolveLimit(query.limit)
      );

      return rows.flatMap((row) => {
        const record = toRecord(row);
        return record === undefined ? [] : [record];
      });
    },
    findByRawDedupKey(raw_dedup_key): CandidateMemoryRecord | undefined {
      const row = findByRawDedupKeyStatement.get(raw_dedup_key);
      return row === undefined ? undefined : toRecord(row);
    },
    findBySemanticFingerprint(semantic_fingerprint): CandidateMemoryRecord | undefined {
      const row = findBySemanticFingerprintStatement.get(semantic_fingerprint);
      return row === undefined ? undefined : toRecord(row);
    },
    delete(id): boolean {
      const exists =
        (db.get<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${CANDIDATE_MEMORIES_TABLE} WHERE id = ?`,
          id
        )?.count ?? 0) > 0;

      if (!exists) {
        return false;
      }

      db.run(`DELETE FROM ${CANDIDATE_MEMORIES_TABLE} WHERE id = ?`, id);
      return true;
    },
    updateState(id, state): boolean {
      const existing = findStatement.get(id);

      if (existing === undefined) {
        return false;
      }

      updateStateStatement.run(state, now(), id);
      return true;
    },
    size(): number {
      return db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${CANDIDATE_MEMORIES_TABLE}`
      )?.count ?? 0;
    }
  };
}
