import { ArchiveService } from "../../core/archive-service.js";
import { Repository } from "../../db/repository.js";
import type { SourceAdapter, SourceRecord, SourceSearchInput } from "./types.js";

const now = (): string => new Date().toISOString();

const hasQuery = (input: SourceSearchInput): boolean =>
  typeof input.request.query === "string" && input.request.query.trim().length > 0;

interface RecentArchiveRow {
  id: string;
  archive_type: string;
  project: string;
  source_memory_id: string | null;
  source_uri: string | null;
  captured_at: string | null;
  title: string;
  content: string;
  created_at: string;
}

function getRepository(service: ArchiveService): Repository {
  const repository = Reflect.get(service as object, "repository");

  if (!(repository instanceof Repository)) {
    throw new Error("ArchiveService is missing a usable repository");
  }

  return repository;
}

function mapArchiveRow(archive: RecentArchiveRow): SourceRecord {
  return {
    id: archive.id,
    source_kind: "archive",
    content: [archive.title.trim(), archive.content.trim()]
      .filter((section) => section.length > 0)
      .join("\n\n"),
    created_at: archive.created_at,
    provenance: {
      origin: `archive:${archive.id}`,
      retrieved_at: now()
    },
    metadata: {
      archive_type: archive.archive_type,
      project: archive.project,
      source_memory_id: archive.source_memory_id,
      source_uri: archive.source_uri,
      captured_at: archive.captured_at,
      created_at: archive.created_at
    }
  };
}

function listRecent(service: ArchiveService, input: SourceSearchInput): SourceRecord[] {
  const repository = getRepository(service);
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (input.request.project) {
    clauses.push("project = ?");
    params.push(input.request.project);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = repository.db
    .prepare<unknown[], RecentArchiveRow>(
      `SELECT
         id,
         archive_type,
         project,
         source_memory_id,
         source_uri,
         captured_at,
         title,
         content,
         created_at
       FROM raw_archives
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(...params, input.top_k);

  return rows.map(mapArchiveRow);
}

export function createArchiveSource(service: ArchiveService): SourceAdapter {
  return {
    kind: "archive",
    name: "archive",
    enabled: true,
    search(input) {
      const profile = input.request.intent;

      if (!hasQuery(input)) {
        if (profile === "bootstrap") {
          return listRecent(service, input);
        }

        return [];
      }

      return service
        .search(input.request.query!.trim(), input.request.project ?? undefined, input.top_k)
        .map(
          ({ archive, rank }): SourceRecord => ({
            id: archive.id,
            source_kind: "archive",
            content: [archive.title.trim(), archive.content.trim()]
              .filter((section) => section.length > 0)
              .join("\n\n"),
            created_at: archive.created_at,
            provenance: {
              origin: `archive:${archive.id}`,
              retrieved_at: now()
            },
            raw_score: rank,
            metadata: {
              archive_type: archive.archive_type,
              project: archive.project,
              source_memory_id: archive.source_memory_id,
              source_uri: archive.source_uri,
              captured_at: archive.captured_at,
              created_at: archive.created_at
            }
          })
        );
    }
  };
}
