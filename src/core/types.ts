export type MemoryType =
  | "task_state"
  | "preference"
  | "project_context"
  | "decision"
  | "pitfall"
  | "insight";

export type EntityType = "person" | "project" | "tool" | "concept" | "file";

export type RelationType =
  | "uses"
  | "depends_on"
  | "related_to"
  | "part_of"
  | "caused_by";

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

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  created_at: string;
}

export interface ExtractedEntity {
  name: string;
  type: EntityType;
}

export interface EntityRelation {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: RelationType;
  memory_id: string;
  created_at: string;
  source_entity_name: string;
  source_entity_type: EntityType;
  target_entity_name: string;
  target_entity_type: EntityType;
}

export interface GraphTraversal {
  entities: Entity[];
  relations: EntityRelation[];
}

export interface GraphQueryResult {
  entity: Entity | null;
  relations: EntityRelation[];
  memories: Memory[];
}

export interface CodeSymbol {
  name: string;
  kind: string;
  file: string;
  line: number;
}

export interface GracefulDeletionStatus {
  pending: Memory[];
  daysUntilDeletion: number;
  userAcknowledged: boolean;
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
  status: "healthy" | "degraded" | "unhealthy";
  ollama: boolean;
  db_integrity: boolean;
  memories: number;
  latency_avg_ms: number;
  db_size_mb: number;
  last_backup: string | null;
  issues: string[];
  fix_suggestions: string[];
}

export interface DiagnoseReport {
  report_path: string;
  summary: string;
  suggested_fixes: string[];
  issues_found: string[];
  handoff_prompt: string;
  can_auto_fix: boolean;
}

export interface ExtractionCandidate {
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
}

export interface StoreParams {
  content: string;
  type: MemoryType;
  project: string;
  title?: string;
  tags?: string[];
  importance?: number;
  source?: MemorySource;
  skipSimilarityCheck?: boolean;
}

export interface StoreResult {
  id: string;
  action: "created" | "updated" | "conflict" | "queued" | "excluded";
  title: string;
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

export interface MergeResult {
  merged: Memory[];
  kept: number;
  added: number;
  updated: number;
  conflicts: Memory[];
}

export interface MemoryListFilters {
  project?: string;
  type?: MemoryType;
  status?: MemoryStatus;
  scope?: MemoryScope;
  limit?: number;
  sort?: string;
}

export interface MemoryUpdateParams {
  title?: string;
  content?: string;
  importance?: number;
  tags?: string[];
}

export type HealthInfo = HealthReport | { status: "offline" };

export interface CompactResult {
  merged: number;
  archived: number;
}

export interface QualityScore {
  accuracy: number;
  freshness: number;
  usefulness: number;
  completeness: number;
  overall: number;
}
