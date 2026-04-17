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

function resolveMode(request: IntentRequest): IntentRequest["mode"] {
  return request.mode ?? "L1";
}

function createQueryHash(query: string | undefined): string {
  return createHash("sha256").update(query ?? "").digest("hex");
}

export function cacheKey(request: IntentRequest): string {
  const canonical = JSON.stringify({
    intent: request.intent,
    surface: request.surface,
    session_id: request.session_id,
    query_hash: createQueryHash(request.query),
    mode: resolveMode(request)
  });

  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
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
