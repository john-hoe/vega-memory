import type { VegaConfig } from "../config.js";
import type { Memory, MemoryListFilters, SearchOptions, SearchResult } from "./types.js";
import { Repository } from "../db/repository.js";
import { generateEmbedding } from "../embedding/ollama.js";
import { SearchEngine } from "../search/engine.js";

const now = (): string => new Date().toISOString();

const unique = (values: string[]): string[] => [...new Set(values)];

export class RecallService {
  constructor(
    private readonly repository: Repository,
    private readonly searchEngine: SearchEngine,
    private readonly config: VegaConfig
  ) {}

  async recall(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const embedding = await generateEmbedding(query, this.config);
    const results = this.searchEngine.search(query, embedding, options);
    const accessedAt = now();

    for (const result of results) {
      const accessedProjects = unique([
        ...result.memory.accessed_projects,
        options.project ?? result.memory.project
      ]);
      const shouldPromote =
        result.memory.scope === "project" && accessedProjects.length >= 2;

      this.repository.updateMemory(
        result.memory.id,
        {
          accessed_at: accessedAt,
          access_count: result.memory.access_count + 1,
          accessed_projects: accessedProjects,
          ...(shouldPromote ? { scope: "global" as const } : {})
        },
        {
          skipVersion: true
        }
      );

      if (shouldPromote) {
        console.log(
          `Memory ${result.memory.id} promoted to global scope (accessed by ${accessedProjects.length} projects)`
        );
      }
    }

    return results;
  }

  listMemories(filters: MemoryListFilters): Memory[] {
    return this.repository.listMemories(filters);
  }
}
