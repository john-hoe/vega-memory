import { createLogger, type Logger } from "../../core/logging/index.js";
import { KnowledgeGraphService } from "../../core/knowledge-graph.js";
import { Repository } from "../../db/repository.js";

import type { SourceAdapter, SourceRecord, SourceSearchDepth, SourceSearchInput } from "./types.js";

interface GraphSourceOptions {
  logger?: Logger;
}

const now = (): string => new Date().toISOString();

interface GraphRecentRow {
  id: string;
  title: string;
  content: string;
  project: string;
  created_at: string;
  relation_count: number;
}

const toDepth = (depth: SourceSearchDepth): number => {
  switch (depth) {
    case "minimal":
      return 1;
    case "standard":
      return 1;
    case "extended":
      return 2;
    case "evidence":
      return 3;
  }
};

function getRepository(knowledgeGraphService: KnowledgeGraphService): Repository {
  const repository = Reflect.get(knowledgeGraphService as object, "repository");

  if (!(repository instanceof Repository)) {
    throw new Error("KnowledgeGraphService is missing a usable repository");
  }

  return repository;
}

function listRecent(
  knowledgeGraphService: KnowledgeGraphService,
  input: SourceSearchInput
): SourceRecord[] {
  const repository = getRepository(knowledgeGraphService);
  const clauses = ["EXISTS (SELECT 1 FROM relations WHERE relations.memory_id = memories.id)"];
  const params: unknown[] = [];

  if (input.request.project) {
    clauses.push("memories.project = ?");
    params.push(input.request.project);
  }

  const rows = repository.db
    .prepare<unknown[], GraphRecentRow>(
      `SELECT
         memories.id AS id,
         memories.title AS title,
         memories.content AS content,
         memories.project AS project,
         memories.created_at AS created_at,
         COUNT(relations.id) AS relation_count
       FROM memories
       JOIN relations ON relations.memory_id = memories.id
       WHERE ${clauses.join(" AND ")}
       GROUP BY memories.id
       ORDER BY memories.created_at DESC
       LIMIT ?`
    )
    .all(...params, input.top_k);

  return rows.map(
    (memory): SourceRecord => ({
      id: memory.id,
      source_kind: "graph",
      content: [memory.title.trim(), memory.content.trim()]
        .filter((section) => section.length > 0)
        .join("\n\n"),
      created_at: memory.created_at,
      provenance: {
        origin: `graph:${memory.id}`,
        retrieved_at: now()
      },
      metadata: {
        relation_count: memory.relation_count,
        memory_project: memory.project
      }
    })
  );
}

export function createGraphSource(
  knowledgeGraphService: KnowledgeGraphService,
  options: GraphSourceOptions = {}
): SourceAdapter {
  const logger = options.logger ?? createLogger({ name: "retrieval-source-graph" });

  return {
    kind: "graph",
    name: "graph",
    enabled: true,
    search(input) {
      const query = input.request.query?.trim() ?? "";
      const profile = input.request.intent;

      if (query.length === 0) {
        if (profile === "bootstrap") {
          return listRecent(knowledgeGraphService, input);
        }

        logger.warn("Graph source skipped because query is empty", {
          intent: input.request.intent
        });
        return [];
      }

      const result = knowledgeGraphService.getNeighbors(query, toDepth(input.depth));

      if (result.entity === null) {
        logger.warn("Graph source returned no entity match for query", {
          query
        });
        return [];
      }

      const entity = result.entity;

      return result.memories.slice(0, input.top_k).map(
        (memory): SourceRecord => ({
          id: memory.id,
          source_kind: "graph",
          content: [memory.title.trim(), memory.content.trim()]
            .filter((section) => section.length > 0)
            .join("\n\n"),
          created_at: memory.created_at,
          provenance: {
            origin: `graph:${entity.id}`,
            retrieved_at: now()
          },
          metadata: {
            entity_id: entity.id,
            entity_name: entity.name,
            relation_count: result.relations.length,
            neighbor_count: result.neighbors.length,
            memory_project: memory.project
          }
        })
      );
    }
  };
}
