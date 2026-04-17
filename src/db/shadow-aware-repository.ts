import { validate as isUuid } from "uuid";

import { createLogger } from "../core/logging/index.js";
import { memoryToEnvelope } from "../ingestion/memory-to-envelope.js";
import type { createShadowWriter } from "../ingestion/shadow-writer.js";
import type { Repository } from "./repository.js";

type CreateMemoryInput = Parameters<Repository["createMemory"]>[0];
type CreateMemoryAuditContext = Parameters<Repository["createMemory"]>[1];

export function createShadowAwareRepository(
  inner: Repository,
  shadowWrite: ReturnType<typeof createShadowWriter>,
  options?: { default_surface?: string }
): Repository {
  const logger = createLogger({ name: "shadow-aware-repository" });
  const defaultSurface = options?.default_surface ?? "api";

  const writeShadowEnvelope = (memory: CreateMemoryInput): void => {
    try {
      const envelope = memoryToEnvelope(memory, {
        default_surface: defaultSurface,
        force_event_id: isUuid(memory.id) ? memory.id : undefined
      });
      const outcome = shadowWrite(envelope);

      if (outcome.executed && outcome.reason === "error") {
        logger.warn("Shadow write failed", {
          memory_id: memory.id,
          error: outcome.error ?? "unknown error"
        });
      }
    } catch (error) {
      logger.warn("Shadow write throw caught", {
        memory_id: memory.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "createMemory") {
        return function shadowingCreateMemory(
          memory: CreateMemoryInput,
          auditContext?: CreateMemoryAuditContext
        ) {
          const result = target.createMemory(memory, auditContext);
          writeShadowEnvelope(memory);
          return result;
        };
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as Repository;
}
