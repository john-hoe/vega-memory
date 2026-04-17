import { ArchiveService } from "../core/archive-service.js";
import { FactClaimService } from "../core/fact-claim-service.js";
import { KnowledgeGraphService } from "../core/knowledge-graph.js";
import { createLogger } from "../core/logging/index.js";
import { Repository } from "../db/repository.js";
import type { SourceKind } from "../core/contracts/enums.js";

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
  repository?: Repository;
  fact_claim_service?: FactClaimService;
  knowledge_graph_service?: KnowledgeGraphService;
  archive_service?: ArchiveService;
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

  registry.register(
    resolveAdapter("vega_memory", "promoted-memory", deps.repository, createPromotedMemorySource)
  );
  registry.register(createCandidateMemorySource());
  registry.register(resolveAdapter("wiki", "wiki", deps.repository, createWikiSource));
  registry.register(
    resolveAdapter("fact_claim", "fact-claim", deps.fact_claim_service, createFactClaimSource)
  );
  registry.register(
    resolveAdapter("graph", "graph", deps.knowledge_graph_service, (knowledgeGraphService) =>
      createGraphSource(knowledgeGraphService)
    )
  );
  registry.register(
    resolveAdapter("archive", "archive", deps.archive_service, createArchiveSource)
  );
  registry.register(createHostMemoryFileSource());

  return registry;
}
