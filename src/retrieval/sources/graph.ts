import { createLogger, type Logger } from "../../core/logging/index.js";
import { KnowledgeGraphService } from "../../core/knowledge-graph.js";

import type { SourceAdapter, SourceRecord, SourceSearchDepth, SourceSearchInput } from "./types.js";

interface GraphSourceOptions {
  logger?: Logger;
}

const now = (): string => new Date().toISOString();

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

      if (query.length === 0) {
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
