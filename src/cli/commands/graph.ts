import { basename } from "node:path";
import { Command, InvalidArgumentError } from "commander";

import { GraphReportService } from "../../core/graph-report.js";
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

const printJson = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2));
};

export function registerGraphCommand(
  program: Command,
  knowledgeGraphService: KnowledgeGraphService,
  graphReportService: GraphReportService
): void {
  const graphCommand = program
    .command("graph")
    .description("Query the memory knowledge graph or show graph stats");

  graphCommand
    .command("stats")
    .description("Show knowledge graph stats")
    .option("--project <project>", "limit stats to one project")
    .action((options: { project?: string }) => {
      printJson(knowledgeGraphService.graphStats(options.project));
    });

  graphCommand
    .command("report")
    .description("Generate a markdown graph report for one project")
    .argument("[project]", "project name")
    .option("--save", "save to data/{project}-graph-report.md")
    .action((project: string | undefined, options: { save?: boolean }) => {
      const resolvedProject = project?.trim() || basename(process.cwd()) || "global";

      if (options.save) {
        const saved = graphReportService.saveGraphReport(resolvedProject);

        console.log(saved.report);
        console.error(`Saved graph report to ${saved.path}`);
        return;
      }

      console.log(graphReportService.generateGraphReport(resolvedProject));
    });

  graphCommand
    .command("neighbors")
    .description("Show neighboring graph nodes for an entity")
    .argument("<entity>", "entity name")
    .option("--depth <depth>", "graph traversal depth", parseDepth, 1)
    .option(
      "--min-confidence <confidence>",
      "minimum relation confidence between 0 and 1",
      parseConfidence,
      0
    )
    .action((entity: string, options: { depth: number; minConfidence: number }) => {
      const result = knowledgeGraphService.getNeighbors(
        entity,
        options.depth,
        options.minConfidence
      );

      if (result.entity === null) {
        console.log("Entity not found.");
        return;
      }

      printJson(result);
    });

  graphCommand
    .command("path")
    .description("Find the shortest path between two entities")
    .argument("<from>", "source entity")
    .argument("<to>", "target entity")
    .option("--max-depth <depth>", "maximum search depth", parseDepth, 6)
    .action((from: string, to: string, options: { maxDepth: number }) => {
      printJson(knowledgeGraphService.shortestPath(from, to, options.maxDepth));
    });

  graphCommand
    .command("subgraph")
    .description("Fetch the merged subgraph around one or more entities")
    .argument("<entities...>", "seed entity names")
    .option("--depth <depth>", "graph traversal depth", parseDepth, 1)
    .action((entities: string[], options: { depth: number }) => {
      printJson(knowledgeGraphService.subgraph(entities, options.depth));
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

      printJson({
        entity: result.entity,
        relations: result.relations,
        memories: result.memories.map((memory) => ({
          id: memory.id,
          title: memory.title,
          type: memory.type,
          project: memory.project,
          tags: memory.tags
        }))
      });
    });
}
