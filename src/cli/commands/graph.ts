import { Command, InvalidArgumentError } from "commander";

import { KnowledgeGraphService } from "../../core/knowledge-graph.js";

const parseDepth = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("depth must be a non-negative integer");
  }

  return parsed;
};

export function registerGraphCommand(
  program: Command,
  knowledgeGraphService: KnowledgeGraphService
): void {
  program
    .command("graph")
    .description("Query the memory knowledge graph")
    .argument("<entity>", "entity name")
    .option("--depth <depth>", "graph traversal depth", parseDepth, 1)
    .action((entity: string, options: { depth: number }) => {
      const result = knowledgeGraphService.query(entity, options.depth);

      if (result.entity === null) {
        console.log("Entity not found.");
        return;
      }

      console.log(
        JSON.stringify(
          {
            entity: result.entity,
            relations: result.relations,
            memories: result.memories.map((memory) => ({
              id: memory.id,
              title: memory.title,
              type: memory.type,
              project: memory.project,
              tags: memory.tags
            }))
          },
          null,
          2
        )
      );
    });
}
