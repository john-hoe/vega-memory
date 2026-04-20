import { createLogger, type Logger } from "../../core/logging/index.js";
import type { SourceKind } from "../../core/contracts/enums.js";

import type { SourceAdapter, SourceRecord, SourceSearchInput } from "./types.js";

interface SourceRegistryOptions {
  logger?: Logger;
}

export class SourceRegistry {
  readonly #adapters = new Map<SourceKind, SourceAdapter>();
  readonly #logger: Logger;

  constructor(options: SourceRegistryOptions = {}) {
    this.#logger = options.logger ?? createLogger({ name: "retrieval-source-registry" });
  }

  register(adapter: SourceAdapter): void {
    if (this.#adapters.has(adapter.kind)) {
      throw new Error(`Source adapter already registered for kind: ${adapter.kind}`);
    }

    this.#adapters.set(adapter.kind, adapter);
  }

  get(kind: SourceKind): SourceAdapter {
    const adapter = this.#adapters.get(kind);

    if (adapter === undefined) {
      throw new Error(`Source adapter not registered for kind: ${kind}`);
    }

    return adapter;
  }

  list(): SourceAdapter[] {
    return [...this.#adapters.values()];
  }

  searchMany(kinds: SourceKind[], input: SourceSearchInput): SourceRecord[] {
    const results: SourceRecord[] = [];

    for (const kind of kinds) {
      let adapter: SourceAdapter;

      try {
        adapter = this.get(kind);
      } catch (error) {
        if (kind !== "host_memory_file") {
          throw error;
        }

        this.#logger.warn("Source adapter missing during search; skipping source kind", {
          source_kind: kind,
          intent: input.request.intent,
          query: input.request.query ?? "",
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      if (!adapter.enabled) {
        continue;
      }

      try {
        results.push(...adapter.search(input));
      } catch (error) {
        this.#logger.warn("Source adapter search failed", {
          source_kind: kind,
          adapter_name: adapter.name,
          intent: input.request.intent,
          query: input.request.query ?? "",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return results;
  }
}
