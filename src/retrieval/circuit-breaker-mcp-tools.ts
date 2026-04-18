import { z } from "zod";

import { SURFACES, type Surface } from "../core/contracts/enums.js";

import type { CircuitBreaker, SurfaceBreakerStatus } from "./circuit-breaker.js";

interface CircuitBreakerMcpTool<TName extends string, TResponse> {
  name: TName;
  description: string;
  inputSchema: object;
  invoke(request: unknown): Promise<TResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeZodJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeZodJsonSchema(entry));
  }

  if (!isRecord(schema)) {
    return schema;
  }

  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === false) {
      continue;
    }

    normalized[key] = normalizeZodJsonSchema(value);
  }

  const properties = isRecord(normalized.properties) ? normalized.properties : undefined;

  if (Array.isArray(normalized.required) && properties !== undefined) {
    normalized.required = normalized.required.filter((entry) => {
      if (typeof entry !== "string") {
        return false;
      }

      const propertySchema = properties[entry];
      return !isRecord(propertySchema) || !("default" in propertySchema);
    });
  }

  return normalized;
}

function createInputSchema(schema: z.ZodType<unknown>): object {
  const generated = normalizeZodJsonSchema(z.toJSONSchema(schema));
  return isRecord(generated) ? generated : {};
}

const SURFACES_SCHEMA = z.enum(SURFACES);

export const CIRCUIT_BREAKER_STATUS_INPUT_SCHEMA = z.object({
  surface: SURFACES_SCHEMA.optional()
});

export const CIRCUIT_BREAKER_RESET_INPUT_SCHEMA = z.object({
  surface: SURFACES_SCHEMA,
  actor: z.string().trim().min(1)
});

export function createCircuitBreakerStatusMcpTool(
  circuitBreaker: CircuitBreaker | undefined
): CircuitBreakerMcpTool<
  "circuit_breaker_status",
  | { status: SurfaceBreakerStatus }
  | { statuses: SurfaceBreakerStatus[] }
  | { degraded: "circuit_breaker_unavailable" }
> {
  return {
    name: "circuit_breaker_status",
    description: "Inspect per-surface circuit breaker state and rolling-window diagnostics.",
    inputSchema: createInputSchema(CIRCUIT_BREAKER_STATUS_INPUT_SCHEMA),
    async invoke(request) {
      if (circuitBreaker === undefined) {
        return {
          degraded: "circuit_breaker_unavailable"
        };
      }

      const parsed = CIRCUIT_BREAKER_STATUS_INPUT_SCHEMA.parse(request);

      if (parsed.surface !== undefined) {
        return {
          status: circuitBreaker.getStatus(parsed.surface)
        };
      }

      return {
        statuses: circuitBreaker.listAllStatuses()
      };
    }
  };
}

export function createCircuitBreakerResetMcpTool(
  circuitBreaker: CircuitBreaker | undefined
): CircuitBreakerMcpTool<
  "circuit_breaker_reset",
  | { reset: true; surface: Surface; status: SurfaceBreakerStatus }
  | { degraded: "circuit_breaker_unavailable" }
> {
  return {
    name: "circuit_breaker_reset",
    description: "Reset one surface circuit breaker back to a closed state.",
    inputSchema: createInputSchema(CIRCUIT_BREAKER_RESET_INPUT_SCHEMA),
    async invoke(request) {
      if (circuitBreaker === undefined) {
        return {
          degraded: "circuit_breaker_unavailable"
        };
      }

      const parsed = CIRCUIT_BREAKER_RESET_INPUT_SCHEMA.parse(request);
      circuitBreaker.reset(parsed.surface);

      return {
        reset: true,
        surface: parsed.surface,
        status: circuitBreaker.getStatus(parsed.surface)
      };
    }
  };
}
