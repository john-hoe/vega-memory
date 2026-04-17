import { ArchiveService } from "../core/archive-service.js";
import { FactClaimService } from "../core/fact-claim-service.js";
import { GraphReportService } from "../core/graph-report.js";
import { createLogger } from "../core/logging/index.js";
import { Repository } from "../db/repository.js";
import type { SourceKind } from "../core/contracts/enums.js";
import { searchWikiPages } from "../wiki/search.js";

import {
  createArchiveSource,
  createCandidateMemorySource,
  createFactClaimSource,
  createGraphSource,
  createHostMemoryFileSource,
  createPromotedMemorySource,
  createWikiSource
} from "./sources/index.js";
import { SourceRegistry } from "./sources/registry.js";
import type { SourceAdapter } from "./sources/types.js";

export interface DefaultRegistryDependencies {
  repository: Repository | undefined;
  wikiSearch: typeof searchWikiPages | undefined;
  factClaimService: FactClaimService | undefined;
  graphReportService: GraphReportService | undefined;
  archiveService: ArchiveService | undefined;
}

const logger = createLogger({ name: "retrieval-orchestrator-config" });

function createDisabledAdapter(kind: SourceKind, name: string): SourceAdapter {
  return {
    kind,
    name,
    enabled: false,
    search() {
      return [];
    }
  };
}

function resolveAdapter<Dependency>(
  kind: SourceKind,
  name: string,
  dependency: Dependency | undefined,
  factory: (dependency: Dependency) => SourceAdapter
): SourceAdapter {
  if (dependency === undefined) {
    logger.warn("Retrieval source dependency missing; using disabled stub", {
      source_kind: kind,
      adapter_name: name
    });
    return createDisabledAdapter(kind, `${name}-stub`);
  }

  try {
    return factory(dependency);
  } catch (error) {
    logger.warn("Retrieval source initialization failed; using disabled stub", {
      source_kind: kind,
      adapter_name: name,
      error: error instanceof Error ? error.message : String(error)
    });
    return createDisabledAdapter(kind, `${name}-stub`);
  }
}

export function createDefaultRegistry(deps: DefaultRegistryDependencies): SourceRegistry {
  const registry = new SourceRegistry();
  const wikiSourceDependency =
    deps.repository === undefined || deps.wikiSearch === undefined
      ? undefined
      : {
          repository: deps.repository,
          wikiSearch: deps.wikiSearch
        };

  registry.register(
    resolveAdapter("vega_memory", "promoted-memory", deps.repository, createPromotedMemorySource)
  );
  registry.register(createCandidateMemorySource());
  registry.register(
    resolveAdapter("wiki", "wiki", wikiSourceDependency, ({ repository }) => {
      return createWikiSource(repository);
    })
  );
  registry.register(
    resolveAdapter("fact_claim", "fact-claim", deps.factClaimService, createFactClaimSource)
  );
  registry.register(
    resolveAdapter("graph", "graph", deps.graphReportService, (graphReportService) =>
      createGraphSource(resolveGraphSourceDependency(graphReportService))
    )
  );
  registry.register(
    resolveAdapter("archive", "archive", deps.archiveService, createArchiveSource)
  );
  registry.register(createHostMemoryFileSource());

  return registry;
}

function resolveGraphSourceDependency(
  graphReportService: GraphReportService
): Parameters<typeof createGraphSource>[0] {
  const knowledgeGraphService = Reflect.get(
    graphReportService as object,
    "knowledgeGraphService"
  );

  if (
    typeof knowledgeGraphService !== "object" ||
    knowledgeGraphService === null ||
    typeof Reflect.get(knowledgeGraphService as object, "getNeighbors") !== "function"
  ) {
    throw new Error("GraphReportService is missing a usable knowledge graph service");
  }

  return knowledgeGraphService as Parameters<typeof createGraphSource>[0];
}
