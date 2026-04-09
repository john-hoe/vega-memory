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

export type FactClaimStatus = "active" | "expired" | "suspected_expired" | "conflict";

export type FactClaimSource = "hot_memory" | "raw_archive" | "manual" | "mixed";

export type TemporalPrecision =
  | "exact"
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "unknown";

export type FactClaimTransition =
  | { from: "active"; to: "expired"; actor: "system" | "user" }
  | { from: "active"; to: "suspected_expired"; actor: "system" | "user" }
  | { from: "active"; to: "conflict"; actor: "system" | "user" }
  | { from: "suspected_expired"; to: "active"; actor: "user" }
  | { from: "suspected_expired"; to: "expired"; actor: "user" }
  | { from: "conflict"; to: "active"; actor: "user" }
  | { from: "conflict"; to: "expired"; actor: "user" };

export type RawArchiveType =
  | "transcript"
  | "discussion"
  | "design_debate"
  | "chat_export"
  | "tool_log"
  | "document";

export type TopicKind = "topic" | "room";

export type TopicState = "active" | "superseded";

export interface Memory {
  id: string;
  tenant_id?: string | null;
  type: MemoryType;
  project: string;
  title: string;
  content: string;
  summary: string | null;
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

export interface FactClaim {
  id: string;
  tenant_id?: string | null;
  project: string;
  source_memory_id: string | null;
  evidence_archive_id: string | null;
  canonical_key: string;
  subject: string;
  predicate: string;
  claim_value: string;
  claim_text: string;
  source: FactClaimSource;
  status: FactClaimStatus;
  confidence: number;
  valid_from: string;
  valid_to: string | null;
  temporal_precision: TemporalPrecision;
  invalidation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AsOfQueryOptions {
  as_of: string;
  project?: string;
  include_suspected_expired?: boolean;
  include_conflicts?: boolean;
}

export interface RawArchive {
  id: string;
  tenant_id?: string | null;
  project: string;
  source_memory_id: string | null;
  archive_type: RawArchiveType;
  title: string;
  source_uri: string | null;
  content: string;
  content_hash: string;
  metadata: Record<string, unknown>;
  captured_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Topic {
  id: string;
  tenant_id?: string | null;
  project: string;
  topic_key: string;
  version: number;
  label: string;
  kind: TopicKind;
  description: string | null;
  source: MemorySource;
  state: TopicState;
  supersedes_topic_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryTopic {
  memory_id: string;
  topic_id: string;
  source: MemorySource;
  confidence: number | null;
  status: TopicState;
  created_at: string;
  updated_at: string;
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
  tenant_id?: string | null;
}

export interface AuditQueryFilters {
  actor?: string;
  action?: string;
  memoryId?: string;
  since?: string;
  until?: string;
  tenantId?: string | null;
  limit?: number;
  offset?: number;
}

export interface PerformanceLog {
  timestamp: string;
  tenant_id?: string | null;
  operation: string;
  latency_ms: number;
  memory_count: number;
  result_count: number;
  avg_similarity?: number | null;
  result_types?: MemoryType[];
  bm25_result_count?: number;
  mode?: SessionStartMode | null;
  token_estimate?: number | null;
  token_budget?: number | null;
  token_budget_utilization?: number | null;
  top_k_inflation_ratio?: number | null;
  embedding_latency_ms?: number | null;
}

export interface SessionStartWikiPage {
  slug: string;
  title: string;
  summary: string;
  page_type: string;
}

export type SessionStartMode = "light" | "standard";

export interface SessionStartRequest {
  working_directory: string;
  task_hint?: string;
  mode?: SessionStartMode;
}

export interface SessionStartResult {
  project: string;
  active_tasks: Memory[];
  preferences: Memory[];
  context: Memory[];
  relevant: Memory[];
  relevant_wiki_pages: SessionStartWikiPage[];
  wiki_drafts_pending: number;
  recent_unverified: Memory[];
  conflicts: Memory[];
  proactive_warnings: string[];
  token_estimate: number;
}

export interface RegressionGuardThresholds {
  max_session_start_token: number;
  max_recall_latency_ms: number;
  min_recall_avg_similarity: number;
  max_top_k_inflation_ratio: number;
}

export interface RegressionGuardViolation {
  metric:
    | "max_session_start_token"
    | "max_recall_latency_ms"
    | "min_recall_avg_similarity"
    | "max_top_k_inflation_ratio";
  operation: "session_start" | "recall" | "recall_stream";
  actual: number;
  threshold: number;
  message: string;
}

export interface RegressionMetricSummary {
  count: number;
  latest: number | null;
  average: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface RegressionGuardReport {
  status: "ok" | "warning";
  thresholds: RegressionGuardThresholds;
  violations: RegressionGuardViolation[];
  token: {
    session_start_token_estimate: RegressionMetricSummary;
    session_start_token_by_mode: Record<SessionStartMode, RegressionMetricSummary>;
    recall_result_token_estimate: RegressionMetricSummary;
    token_budget_utilization: {
      session_start: RegressionMetricSummary;
      recall: RegressionMetricSummary;
    };
  };
  latency: {
    session_start_latency_ms: RegressionMetricSummary;
    recall_latency_ms: RegressionMetricSummary;
    embedding_latency_ms: RegressionMetricSummary;
  };
  recall_quality: {
    recall_result_count: RegressionMetricSummary;
    recall_avg_similarity: RegressionMetricSummary;
    recall_top_k_inflation: RegressionMetricSummary;
    evidence_pull_rate: number;
  };
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
  regression_guard: RegressionGuardReport;
}

export interface DiagnoseReport {
  report_path: string;
  summary: string;
  suggested_fixes: string[];
  issues_found: string[];
  handoff_prompt: string;
  can_auto_fix: boolean;
}

export type ExtractableMemoryType = Exclude<MemoryType, "insight">;

export interface ExtractionCandidate {
  type: ExtractableMemoryType;
  title: string;
  content: string;
  tags: string[];
}

export interface StoreParams {
  content: string;
  type: MemoryType;
  project: string;
  tenant_id?: string | null;
  title?: string;
  tags?: string[];
  importance?: number;
  source?: MemorySource;
  skipSimilarityCheck?: boolean;
  auditContext?: AuditContext;
}

export interface StoreResult {
  id: string;
  action: "created" | "updated" | "conflict" | "queued" | "excluded";
  title: string;
}

export interface RedactionPattern {
  name: string;
  pattern: string;
  replacement?: string;
  enabled?: boolean;
}

export interface SearchResult {
  memory: Memory;
  similarity: number;
  finalScore: number;
}

export interface SearchOptions {
  project?: string;
  type?: MemoryType;
  tenant_id?: string | null;
  limit: number;
  minSimilarity: number;
}

export interface DeepRecallRequest {
  query: string;
  project?: string;
  limit?: number;
  evidence_limit?: number;
  include_content?: boolean;
  include_metadata?: boolean;
  inject_into_session?: boolean;
}

export interface DeepRecallResult {
  archive_id: string;
  memory_id: string | null;
  project: string;
  type: MemoryType | null;
  archive_type: RawArchiveType;
  title: string;
  content?: string;
  summary?: string | null;
  verified?: VerifiedStatus | null;
  metadata?: Record<string, unknown>;
  source_uri?: string | null;
  captured_at?: string | null;
  created_at?: string;
  updated_at?: string;
  evidence_score?: number;
}

export interface DeepRecallResponse {
  results: DeepRecallResult[];
  next_cursor: string | null;
  injected_into_session: boolean;
}

export type RecallProtocolErrorCode =
  | "INVALID_RECALL_MODE"
  | "INVALID_RECALL_REQUEST"
  | "DEEP_RECALL_NOT_IMPLEMENTED"
  | "TOKEN_BUDGET_EXCEEDED";

export interface RecallProtocolError {
  status: 400 | 422 | 429 | 501;
  code: RecallProtocolErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
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
  tenant_id?: string | null;
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

export interface AuditContext {
  actor: string;
  ip: string | null;
  tenant_id?: string | null;
}

export type HealthInfo = HealthReport | { status: "offline" | "unauthorized" };

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

export interface SearchQualityReport {
  avg_latency_ms: number;
  avg_results: number;
  zero_result_pct: number;
  type_distribution: Partial<Record<MemoryType, number>>;
  recommendations: string[];
}

export type TenantPlan = "free" | "pro" | "enterprise";

export interface Tenant {
  id: string;
  name: string;
  plan: TenantPlan;
  api_key: string;
  active: boolean;
  created_at: string;
  memory_limit: number;
  updated_at: string;
}

export interface SSOUser {
  id: string;
  email: string;
  name: string;
  provider: string;
}

export interface UsageStats {
  api_calls_total: number;
  api_calls_by_operation: Record<string, number>;
  memories_total: number;
  memories_by_type: Partial<Record<MemoryType, number>>;
  memories_by_project: Record<string, number>;
  storage_bytes: number;
  avg_latency_ms: number;
  active_projects: number;
  peak_hour: string | null;
}

export interface GrowthPoint {
  date: string;
  count: number;
}

export interface BillingUsage {
  tenant_id: string;
  month: string;
  memory_count: number;
  api_calls: number;
  storage_bytes: number;
}

export interface QuotaStatus {
  plan: TenantPlan;
  memory_usage: number;
  memory_limit: number;
  api_usage: number;
  api_limit: number;
  over_quota: boolean;
}

export interface WhiteLabelSettings {
  brandName: string;
  logoUrl: string | null;
  primaryColor: string;
  dashboardTitle: string;
  footerText: string;
  customCss: string | null;
}
