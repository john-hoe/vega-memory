import { basename, resolve } from "node:path";

import { Repository } from "../db/repository.js";
import type {
  CompactResult,
  HealthInfo,
  Memory,
  MemoryListFilters,
  MemoryUpdateParams,
  SearchOptions,
  SearchResult,
  SessionStartResult,
  StoreParams,
  StoreResult
} from "../core/types.js";
import type { PendingOperation } from "./queue.js";
import { PendingQueue } from "./queue.js";

interface RemoteMemory {
  id: string;
  type: Memory["type"];
  project: string;
  title: string;
  content: string;
  importance?: number;
  source?: Memory["source"];
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  accessed_at?: string;
  access_count?: number;
  status?: Memory["status"];
  verified?: Memory["verified"];
  scope?: Memory["scope"];
  accessed_projects?: string[];
}

interface RemoteRecallResult {
  id: string;
  type: Memory["type"];
  project: string;
  title: string;
  content: string;
  similarity: number;
}

interface HealthPayload {
  memory_count: number;
  db_size_bytes: number;
  ollama_available: boolean;
}

class HttpResponseError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const REACHABILITY_TIMEOUT_MS = 3_000;

const now = (): string => new Date().toISOString();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNetworkError = (error: unknown): boolean =>
  error instanceof TypeError || (error instanceof Error && error.name === "AbortError");

const buildPendingTitle = (params: StoreParams): string => {
  const title = params.title?.trim();
  if (title) {
    return title;
  }

  const firstLine = params.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return "Untitled Memory";
  }

  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
};

const emptySessionResult = (workingDirectory: string): SessionStartResult => {
  const project = basename(resolve(workingDirectory));

  return {
    project,
    active_tasks: [],
    preferences: [],
    context: [],
    relevant: [],
    recent_unverified: [],
    conflicts: [],
    proactive_warnings: [],
    token_estimate: 0
  };
};

const memoriesEqual = (left: Memory, right: Memory): boolean =>
  left.id === right.id &&
  left.type === right.type &&
  left.project === right.project &&
  left.title === right.title &&
  left.content === right.content &&
  left.importance === right.importance &&
  left.source === right.source &&
  left.created_at === right.created_at &&
  left.updated_at === right.updated_at &&
  left.accessed_at === right.accessed_at &&
  left.access_count === right.access_count &&
  left.status === right.status &&
  left.verified === right.verified &&
  left.scope === right.scope &&
  JSON.stringify(left.tags) === JSON.stringify(right.tags) &&
  JSON.stringify(left.accessed_projects) === JSON.stringify(right.accessed_projects);

const toQueryString = (filters: MemoryListFilters): string => {
  const params = new URLSearchParams();

  if (filters.project) {
    params.set("project", filters.project);
  }
  if (filters.type) {
    params.set("type", filters.type);
  }
  if (filters.limit !== undefined) {
    params.set("limit", String(filters.limit));
  }
  if (filters.sort) {
    params.set("sort", filters.sort);
  }

  const query = params.toString();

  return query.length > 0 ? `?${query}` : "";
};

export class VegaSyncClient {
  private readonly serverUrl: string;
  private readonly apiKey: string | undefined;
  private pendingQueue: PendingQueue | undefined;
  private cacheRepo: Repository | undefined;

  constructor(serverUrl: string, apiKey: string | undefined) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  setPendingQueue(queue: PendingQueue): void {
    this.pendingQueue = queue;
  }

  setCacheRepository(cacheRepo: Repository): void {
    this.cacheRepo = cacheRepo;
  }

  async store(params: StoreParams): Promise<StoreResult> {
    try {
      const result = await this.storeRemote(params);
      await this.refreshLocalCache();
      return result;
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }

      this.enqueue({
        type: "store",
        params,
        timestamp: now()
      });

      return {
        id: `pending:${Date.now()}`,
        action: "queued",
        title: buildPendingTitle(params)
      };
    }
  }

  async recall(query: string, options: SearchOptions): Promise<SearchResult[]> {
    try {
      const results = await this.requestJson<RemoteRecallResult[]>(
        "/api/recall",
        {
          method: "POST",
          body: JSON.stringify({
            query,
            project: options.project,
            type: options.type,
            limit: options.limit,
            min_similarity: options.minSimilarity
          })
        },
        DEFAULT_REQUEST_TIMEOUT_MS
      );

      return results.map((entry) => ({
        memory: this.toMemory(entry),
        similarity: entry.similarity,
        finalScore: entry.similarity
      }));
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }

      return this.searchLocalCache(query, options);
    }
  }

  async list(filters: MemoryListFilters): Promise<Memory[]> {
    try {
      const memories = await this.fetchRemoteMemories(filters);
      this.upsertCache(memories);
      return memories;
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }

      return this.cacheRepo?.listMemories(filters) ?? [];
    }
  }

  async sessionStart(workingDirectory: string, taskHint?: string): Promise<SessionStartResult> {
    try {
      const result = await this.requestJson<SessionStartResult>(
        "/api/session/start",
        {
          method: "POST",
          body: JSON.stringify({
            working_directory: workingDirectory,
            task_hint: taskHint
          })
        },
        DEFAULT_REQUEST_TIMEOUT_MS
      );

      this.upsertCache([
        ...result.active_tasks.map((memory) => this.toMemory(memory)),
        ...result.preferences.map((memory) => this.toMemory(memory)),
        ...result.context.map((memory) => this.toMemory(memory)),
        ...result.relevant.map((memory) => this.toMemory(memory)),
        ...result.recent_unverified.map((memory) => this.toMemory(memory)),
        ...result.conflicts.map((memory) => this.toMemory(memory))
      ]);

      return {
        ...result,
        active_tasks: result.active_tasks.map((memory) => this.toMemory(memory)),
        preferences: result.preferences.map((memory) => this.toMemory(memory)),
        context: result.context.map((memory) => this.toMemory(memory)),
        relevant: result.relevant.map((memory) => this.toMemory(memory)),
        recent_unverified: result.recent_unverified.map((memory) => this.toMemory(memory)),
        conflicts: result.conflicts.map((memory) => this.toMemory(memory))
      };
    } catch {
      return emptySessionResult(workingDirectory);
    }
  }

  async sessionEnd(project: string, summary: string, completedTasks?: string[]): Promise<void> {
    try {
      await this.sessionEndRemote(project, summary, completedTasks);
      await this.refreshLocalCache();
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }

      this.enqueue({
        type: "session_end",
        params: {
          project,
          summary,
          completed_tasks: completedTasks
        },
        timestamp: now()
      });
    }
  }

  async update(id: string, updates: MemoryUpdateParams): Promise<void> {
    try {
      await this.updateRemote(id, updates);
      await this.refreshLocalCache();
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }

      this.enqueue({
        type: "update",
        params: {
          id,
          ...updates
        },
        timestamp: now()
      });
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.deleteRemote(id);
      this.removeFromCache(id);
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }

      this.enqueue({
        type: "delete",
        params: {
          id
        },
        timestamp: now()
      });
    }
  }

  async compact(project?: string): Promise<CompactResult> {
    try {
      const result = await this.compactRemote(project);
      await this.refreshLocalCache();
      return result;
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }

      this.enqueue({
        type: "compact",
        params: project ? { project } : {},
        timestamp: now()
      });

      return {
        merged: 0,
        archived: 0
      };
    }
  }

  async health(): Promise<HealthInfo> {
    try {
      const result = await this.requestJson<HealthPayload>(
        "/api/health",
        {
          method: "GET"
        },
        DEFAULT_REQUEST_TIMEOUT_MS
      );

      return {
        status: "online",
        ...result
      };
    } catch {
      return {
        status: "offline"
      };
    }
  }

  async isServerReachable(): Promise<boolean> {
    try {
      await this.requestJson<HealthPayload>(
        "/api/health",
        {
          method: "GET"
        },
        REACHABILITY_TIMEOUT_MS
      );

      return true;
    } catch {
      return false;
    }
  }

  async replay(operation: PendingOperation): Promise<void> {
    switch (operation.type) {
      case "store":
        await this.storeRemote(operation.params as StoreParams);
        return;
      case "session_end": {
        const params = operation.params as {
          project: string;
          summary: string;
          completed_tasks?: string[];
        };
        await this.sessionEndRemote(params.project, params.summary, params.completed_tasks);
        return;
      }
      case "update": {
        const params = operation.params as MemoryUpdateParams & {
          id: string;
        };
        await this.updateRemote(params.id, {
          content: params.content,
          importance: params.importance,
          tags: params.tags
        });
        return;
      }
      case "delete": {
        const params = operation.params as {
          id: string;
        };
        await this.deleteRemote(params.id);
        return;
      }
      case "compact": {
        const params = operation.params as {
          project?: string;
        };
        await this.compactRemote(params.project);
        return;
      }
    }
  }

  async fetchRemoteMemories(filters: MemoryListFilters = {}): Promise<Memory[]> {
    const memories = await this.requestJson<RemoteMemory[]>(
      `/api/list${toQueryString({
        ...filters,
        limit: filters.limit ?? 1_000_000
      })}`,
      {
        method: "GET"
      },
      DEFAULT_REQUEST_TIMEOUT_MS
    );

    return memories.map((memory) => this.toMemory(memory));
  }

  private async storeRemote(params: StoreParams): Promise<StoreResult> {
    return this.requestJson<StoreResult>(
      "/api/store",
      {
        method: "POST",
        body: JSON.stringify(params)
      },
      DEFAULT_REQUEST_TIMEOUT_MS
    );
  }

  private async sessionEndRemote(
    project: string,
    summary: string,
    completedTasks?: string[]
  ): Promise<void> {
    await this.requestVoid(
      "/api/session/end",
      {
        method: "POST",
        body: JSON.stringify({
          project,
          summary,
          completed_tasks: completedTasks
        })
      },
      DEFAULT_REQUEST_TIMEOUT_MS
    );
  }

  private async updateRemote(id: string, updates: MemoryUpdateParams): Promise<void> {
    await this.requestVoid(
      `/api/memory/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates)
      },
      DEFAULT_REQUEST_TIMEOUT_MS
    );
  }

  private async deleteRemote(id: string): Promise<void> {
    await this.requestVoid(
      `/api/memory/${encodeURIComponent(id)}`,
      {
        method: "DELETE"
      },
      DEFAULT_REQUEST_TIMEOUT_MS
    );
  }

  private async compactRemote(project?: string): Promise<CompactResult> {
    return this.requestJson<CompactResult>(
      "/api/compact",
      {
        method: "POST",
        body: JSON.stringify(project ? { project } : {})
      },
      DEFAULT_REQUEST_TIMEOUT_MS
    );
  }

  private async refreshLocalCache(): Promise<void> {
    if (!this.cacheRepo) {
      return;
    }

    const memories = await this.fetchRemoteMemories();
    this.upsertCache(memories);
  }

  private enqueue(operation: PendingOperation): void {
    if (!this.pendingQueue) {
      throw new Error("Pending queue is not configured");
    }

    this.pendingQueue.enqueue(operation);
  }

  private upsertCache(memories: Memory[]): void {
    if (!this.cacheRepo) {
      return;
    }

    for (const memory of memories) {
      const existing = this.cacheRepo.getMemory(memory.id);
      const nextMemory: Memory = {
        ...memory,
        embedding: existing?.embedding ?? memory.embedding ?? null
      };

      if (!existing) {
        const { access_count: _accessCount, ...createdMemory } = nextMemory;
        this.cacheRepo.createMemory(createdMemory);
        continue;
      }

      if (memoriesEqual(existing, nextMemory)) {
        continue;
      }

      this.cacheRepo.updateMemory(
        nextMemory.id,
        {
          ...nextMemory
        },
        {
          skipVersion: true
        }
      );
    }
  }

  private removeFromCache(id: string): void {
    if (!this.cacheRepo) {
      return;
    }

    if (this.cacheRepo.getMemory(id) !== null) {
      this.cacheRepo.deleteMemory(id);
    }
  }

  private searchLocalCache(query: string, options: SearchOptions): SearchResult[] {
    if (!this.cacheRepo) {
      return [];
    }

    try {
      return this.cacheRepo
        .searchFTS(query, options.project, options.type)
        .slice(0, options.limit)
        .map((entry) => {
          const score = 1 / (1 + Math.abs(entry.rank));

          return {
            memory: entry.memory,
            similarity: score,
            finalScore: score
          };
        });
    } catch {
      return [];
    }
  }

  private toMemory(remote: RemoteMemory): Memory {
    const existing = this.cacheRepo?.getMemory(remote.id);
    const timestamp = now();

    return {
      id: remote.id,
      type: remote.type,
      project: remote.project,
      title: remote.title,
      content: remote.content,
      embedding: existing?.embedding ?? null,
      importance: remote.importance ?? existing?.importance ?? 0,
      source: remote.source ?? existing?.source ?? "auto",
      tags: remote.tags ?? existing?.tags ?? [],
      created_at: remote.created_at ?? existing?.created_at ?? timestamp,
      updated_at: remote.updated_at ?? existing?.updated_at ?? timestamp,
      accessed_at: remote.accessed_at ?? existing?.accessed_at ?? timestamp,
      access_count: remote.access_count ?? existing?.access_count ?? 0,
      status: remote.status ?? existing?.status ?? "active",
      verified:
        remote.verified ?? existing?.verified ?? "unverified",
      scope:
        remote.scope ??
        existing?.scope ??
        (remote.type === "preference" ? "global" : "project"),
      accessed_projects:
        remote.accessed_projects ?? existing?.accessed_projects ?? [remote.project]
    };
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<T> {
    const response = await this.request(path, init, timeoutMs);

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async requestVoid(path: string, init: RequestInit, timeoutMs: number): Promise<void> {
    await this.request(path, init, timeoutMs);
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const headers = new Headers(init.headers);

    if (!headers.has("content-type") && init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (this.apiKey) {
      headers.set("authorization", `Bearer ${this.apiKey}`);
    }

    const response = await fetch(`${this.serverUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (response.ok) {
      return response;
    }

    const message = await this.readErrorMessage(response);
    throw new HttpResponseError(response.status, message);
  }

  private async readErrorMessage(response: Response): Promise<string> {
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      const body = (await response.json()) as unknown;

      if (isRecord(body) && typeof body.error === "string") {
        return body.error;
      }
    }

    const text = await response.text();
    return text || `HTTP ${response.status}`;
  }
}
