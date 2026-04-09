import { Command, InvalidArgumentError } from "commander";

import { KnowledgeGraphService } from "../../core/knowledge-graph.js";

const parseDepth = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("depth must be a non-negative integer");
  }

  return parsed;
};

const parseConfidence = (value: string): number => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError("min-confidence must be a number between 0 and 1");
  }

  return parsed;
};

export function registerGraphCommand(
  program: Command,
  knowledgeGraphService: KnowledgeGraphService
): void {
  const graphCommand = program
    .command("graph")
    .description("Query the memory knowledge graph or show graph stats");

  graphCommand
    .command("stats")
    .description("Show knowledge graph stats")
    .action(() => {
      console.log(JSON.stringify(knowledgeGraphService.getStats(), null, 2));
    });

  graphCommand
    .argument("[entity]", "entity name")
    .option("--depth <depth>", "graph traversal depth", parseDepth, 1)
    .option(
      "--min-confidence <confidence>",
      "minimum relation confidence between 0 and 1",
      parseConfidence,
      0
    )
    .action((entity: string | undefined, options: { depth: number; minConfidence: number }) => {
      if (!entity) {
        console.log("Provide an entity name or run `vega graph stats`.");
        return;
      }

      const result = knowledgeGraphService.query(entity, options.depth, options.minConfidence);

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
