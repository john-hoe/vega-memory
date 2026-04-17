import { createHash } from "node:crypto";

import type { IntentRequest } from "../core/contracts/intent.js";

import type { ContextResolveResponse } from "./orchestrator.js";

export interface ResolveCacheOptions {
  ttl_ms?: number;
  now?: () => number;
}

export interface ResolveCache {
  get(request: IntentRequest): ContextResolveResponse | undefined;
  set(request: IntentRequest, response: ContextResolveResponse): void;
  clear(): void;
  size(): number;
}

interface ResolveCacheEntry {
  expires_at: number;
  response: ContextResolveResponse;
}

const DEFAULT_TTL_MS = 60_000;

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function resolveMode(request: IntentRequest): IntentRequest["mode"] {
  return request.mode ?? "L1";
}

function createQueryHash(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

function canonicalize(value: unknown): CanonicalValue | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => canonicalize(entry))
      .filter((entry): entry is CanonicalValue => entry !== undefined);
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const canonical: Record<string, CanonicalValue> = {};

  for (const [key, entry] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    const normalized = canonicalize(entry);

    if (normalized !== undefined) {
      canonical[key] = normalized;
    }
  }

  return canonical;
}

export function cacheKey(request: IntentRequest): string {
  const canonical = canonicalize({
    budget_override: request.budget_override ?? null,
    cwd: request.cwd,
    intent: request.intent,
    mode: resolveMode(request),
    project: request.project,
    query_hash: createQueryHash(request.query),
    session_id: request.session_id,
    surface: request.surface
  });

  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16);
}

export function createResolveCache(options: ResolveCacheOptions = {}): ResolveCache {
  const ttl_ms = options.ttl_ms ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, ResolveCacheEntry>();

  function sweepExpired(): void {
    const currentTime = now();

    for (const [key, entry] of entries) {
      if (entry.expires_at <= currentTime) {
        entries.delete(key);
      }
    }
  }

  return {
    get(request: IntentRequest): ContextResolveResponse | undefined {
      sweepExpired();
      return entries.get(cacheKey(request))?.response;
    },
    set(request: IntentRequest, response: ContextResolveResponse): void {
      sweepExpired();
      entries.set(cacheKey(request), {
        expires_at: now() + ttl_ms,
        response
      });
    },
    clear(): void {
      entries.clear();
    },
    size(): number {
      sweepExpired();
      return entries.size;
    }
  };
}
