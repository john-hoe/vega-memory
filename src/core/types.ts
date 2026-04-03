export type MemoryType =
  | "task_state"
  | "preference"
  | "project_context"
  | "decision"
  | "pitfall"
  | "insight";

export type MemorySource = "auto" | "explicit";

export type MemoryStatus = "active" | "archived";

export type VerifiedStatus = "verified" | "unverified" | "rejected" | "conflict";

export type MemoryScope = "project" | "global";

export interface Memory {
  id: string;
  type: MemoryType;
  project: string;
  title: string;
  content: string;
  embedding: Buffer | null;
  importance: number;
  source: MemorySource;
  tags: string[];
  created_at: string;
  updated_at: string;
  accessed_at: string;
  access_count: number;
  status: MemoryStatus;
  verified: VerifiedStatus;
  scope: MemoryScope;
  accessed_projects: string[];
}

export interface MemoryVersion {
  id: string;
  memory_id: string;
  content: string;
  embedding: Buffer | null;
  importance: number;
  updated_at: string;
}

export interface Session {
  id: string;
  project: string;
  summary: string;
  started_at: string;
  ended_at: string;
  memories_created: string[];
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  memory_id: string | null;
  detail: string;
  ip: string | null;
}

export interface PerformanceLog {
  timestamp: string;
  operation: string;
  latency_ms: number;
  memory_count: number;
  result_count: number;
}

export interface SessionStartResult {
  project: string;
  active_tasks: Memory[];
  preferences: Memory[];
  context: Memory[];
  relevant: Memory[];
  recent_unverified: Memory[];
  conflicts: Memory[];
  proactive_warnings: string[];
  token_estimate: number;
}

export interface HealthReport {
  status: string;
  ollama: boolean;
  db_integrity: boolean;
  memories: number;
  latency_avg_ms: number;
  db_size_mb: number;
  last_backup: string | null;
  issues: string[];
  fix_suggestions: string[];
}

export interface SearchResult {
  memory: Memory;
  similarity: number;
  finalScore: number;
}

export interface SearchOptions {
  project?: string;
  type?: MemoryType;
  limit: number;
  minSimilarity: number;
}
