export type MemoryType =
  | "task_state"
  | "preference"
  | "project_context"
  | "decision"
  | "pitfall"
  | "insight";

export type EntityType =
  | "person"
  | "project"
  | "tool"
  | "concept"
  | "file"
  | "module"
  | "function"
  | "class"
  | "document"
  | "heading"
  | "term";

export type RelationType =
  | "uses"
  | "depends_on"
  | "related_to"
  | "part_of"
  | "caused_by"
  | "imports"
  | "declares"
  | "contains"
  | "exports"
  | "defines"
  | "references";

export const SEMANTIC_RELATION_TYPES = [
  "uses",
  "depends_on",
  "related_to",
  "part_of",
  "caused_by"
] as const satisfies RelationType[];

export const STRUCTURAL_RELATION_TYPES = [
  "imports",
  "declares",
  "contains",
  "exports",
  "defines",
  "references"
] as const satisfies RelationType[];

export type ExtractionMethod = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

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

export const INTEGRATION_SURFACES = [
  "cursor",
  "codex",
  "claude",
  "api",
  "cli"
] as const;
export type IntegrationSurface = (typeof INTEGRATION_SURFACES)[number];

export type ManagedSetupStatus = "configured" | "partial" | "missing";
export type ObservedActivityStatus = "active" | "inactive" | "unknown";
export type RuntimeHealthStatus = "ok" | "warn" | "fail";

export interface ObservedActivityWindowStatus {
  window_days: number;
  status: ObservedActivityStatus;
  observed_count: number;
  last_observed_at: string | null;
}

export interface IntegrationSurfaceStatus {
  surface: IntegrationSurface;
  managed_setup_status: ManagedSetupStatus;
  observed_activity_status: ObservedActivityStatus;
  observed_activity_windows: {
    window_7d: ObservedActivityWindowStatus;
    window_30d: ObservedActivityWindowStatus;
  };
  runtime_health_status: RuntimeHealthStatus;
  managed_setup_details: string[];
  observed_activity_details: string[];
  runtime_health_details: string[];
  next_action?: string;
}

export interface MemorySourceContext {
  actor: string;
  channel: string;
  device_id: string;
  device_name: string;
  platform: string;
  session_id?: string;
  client_info?: string;
  surface?: IntegrationSurface;
  integration?: string;
}

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
  source_context?: MemorySourceContext | null;
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

export interface ArchiveStats {
  total_count: number;
  total_size_bytes: number;
  total_size_mb: number;
  with_embedding_count: number;
  without_embedding_count: number;
  missing_hash_count: number;
}

export interface ArchiveHashRepairDuplicate {
  id: string;
  duplicate_of: string;
  tenant_id: string | null;
  project: string;
  content_hash: string;
}

export interface ArchiveHashRepairResult {
  scanned: number;
  updated: number;
  duplicates: ArchiveHashRepairDuplicate[];
}

export interface ArchiveEmbeddingBuildResult {
  requested: number;
  processed: number;
  embedded: number;
  skipped: number;
  remaining_without_embedding: number;
  hash_repair: ArchiveHashRepairResult;
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
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  metadata?: Record<string, unknown>;
}

export interface EntityRelation {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: RelationType;
  memory_id: string;
  confidence: number;
  extraction_method: ExtractionMethod;
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

export interface GraphNeighborsResult {
  entity: Entity | null;
  neighbors: Entity[];
  relations: EntityRelation[];
  memories: Memory[];
}

export interface GraphPathTraversal {
  entity_ids: string[];
  relation_ids: string[];
}

export interface GraphPathResult {
  from: Entity | null;
  to: Entity | null;
  entities: Entity[];
  relations: EntityRelation[];
  memories: Memory[];
  found: boolean;
}

export interface GraphSubgraphResult {
  seed_entities: Entity[];
  missing_entities: string[];
  entities: Entity[];
  relations: EntityRelation[];
  memories: Memory[];
}

export interface StructuredRelation {
  source: string;
  target: string;
  relation_type: RelationType;
  confidence?: number;
  extraction_method?: ExtractionMethod;
}

export interface StructuredGraph {
  entities: ExtractedEntity[];
  relations: StructuredRelation[];
}

export interface GraphStats {
  project?: string;
  total_entities: number;
  total_relations: number;
  entity_types: Record<string, number>;
  relation_types: Record<string, number>;
  average_confidence: number | null;
  tracked_code_files: number;
  tracked_doc_files: number;
}

export type GraphContentCacheKind = "code" | "doc";

export interface GraphContentCacheRecord {
  kind: GraphContentCacheKind;
  scope_key: string;
  file_path: string;
  content_hash: string;
  last_indexed_at: string;
  entity_count: number;
  memory_ids: string[];
  last_modified_ms: number | null;
}

export interface GraphDirectoryStatus {
  indexed_files: number;
  pending_files: number;
  new_files: number;
  modified_files: number;
  deleted_files: number;
  unchanged_files: number;
}

export interface GraphDirectoryScanFile {
  absolute_path: string;
  file_path: string;
  status: "new" | "modified" | "unchanged";
  content_hash: string;
  last_modified_ms: number | null;
}

export interface GraphDirectoryScanResult {
  current_files: GraphDirectoryScanFile[];
  new_files: GraphDirectoryScanFile[];
  modified_files: GraphDirectoryScanFile[];
  unchanged_files: GraphDirectoryScanFile[];
  deleted_files: GraphContentCacheRecord[];
  status: GraphDirectoryStatus;
}

export interface MetadataEntry {
  key: string;
  value: string;
  updated_at: string;
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
  detail?: string | null;
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

export const SESSION_START_CANONICAL_MODES = ["L0", "L1", "L2", "L3"] as const;
export type SessionStartCanonicalMode = (typeof SESSION_START_CANONICAL_MODES)[number];

export const SESSION_START_MODE_VALUES = [
  ...SESSION_START_CANONICAL_MODES,
  "light",
  "standard"
] as const;
export type SessionStartMode = (typeof SESSION_START_MODE_VALUES)[number];

export const normalizeSessionStartMode = (
  mode: SessionStartMode = "standard"
): SessionStartCanonicalMode => {
  switch (mode) {
    case "light":
      return "L1";
    case "standard":
      return "L2";
    default:
      return mode;
  }
};

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
  graph_report?: string;
  deep_recall?: DeepRecallResponse;
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
  preserve_raw?: boolean;
  skipSimilarityCheck?: boolean;
  auditContext?: AuditContext;
  sourceContext?: MemorySourceContext | null;
}

export interface StoreResult {
  id: string;
  action: "created" | "updated" | "conflict" | "queued" | "excluded";
  title: string;
}

export interface TopicAssignmentRequest {
  memory_id: string;
  project: string;
  topic_key: string;
  source: MemorySource;
  confidence?: number | null;
}

export interface TopicRecallOptions {
  topic_key: string;
  include_rooms?: boolean;
  fallback_to_tags?: boolean;
}

export interface CrossProjectTopicMemory {
  topic: Topic;
  memory: Memory;
}

export interface TunnelSharedMemorySummary {
  title: string;
  normalized_title: string;
  projects: string[];
  memory_ids: string[];
  occurrences: number;
}

export interface TunnelProjectView {
  project: string;
  topic: Topic;
  memory_count: number;
  memories_by_type: Partial<Record<MemoryType, Memory[]>>;
}

export interface TunnelView {
  topic_key: string;
  project_count: number;
  total_memory_count: number;
  projects: TunnelProjectView[];
  common_pitfalls: TunnelSharedMemorySummary[];
  common_decisions: TunnelSharedMemorySummary[];
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
  fallback?: boolean;
}

export interface SearchOptions {
  project?: string;
  type?: MemoryType;
  tenant_id?: string | null;
  topic?: string | TopicRecallOptions;
  source_surface?: IntegrationSurface;
  source_integration?: string;
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
  warning?: string;
  content?: string;
  contains_raw: boolean;
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
  warnings?: string[];
}

export type RecallProtocolErrorCode =
  | "INVALID_RECALL_MODE"
  | "INVALID_RECALL_REQUEST"
  | "DEEP_RECALL_DISABLED"
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
  verified?: VerifiedStatus;
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

export interface ImpactMemorySummary {
  id: string;
  title: string;
  project: string;
  type: MemoryType;
  access_count: number;
  updated_at: string;
  explanation?: string;
}

export interface RecommendedAction {
  area: "setup" | "runtime" | "capture" | "reuse" | "adoption";
  title: string;
  reason: string;
}

export interface RuntimeReadinessDetail {
  status: "pass" | "warn" | "fail";
  summary: string;
  reasons: string[];
  suggestions: string[];
}

export interface ImpactConclusion {
  status: "good" | "needs_attention" | "blocked";
  headline: string;
  detail: string;
}

export interface WeeklyOverview {
  headline: string;
  detail: string;
}

export interface ImpactReport {
  generated_at: string;
  window_days: number;
  usage: UsageStats;
  growth_trend: GrowthPoint[];
  new_memories_this_week: number;
  top_reused_memories_basis: "lifetime_access_count";
  top_reused_memories: ImpactMemorySummary[];
  memory_mix: Partial<Record<MemoryType, number>>;
  runtime_readiness?: "pass" | "warn" | "fail";
  runtime_readiness_detail?: RuntimeReadinessDetail;
  setup_surface_coverage?: Record<string, "configured" | "partial" | "missing">;
  conclusion?: ImpactConclusion;
  recommended_actions: RecommendedAction[];
}

export interface WeeklySummary {
  generated_at: string;
  window_days: number;
  new_memories_this_week: number;
  active_projects: number;
  api_calls_total: number;
  avg_latency_ms: number;
  peak_hour: string | null;
  top_reused_memories_basis: "lifetime_access_count";
  top_reused_memories: ImpactMemorySummary[];
  memory_mix: Partial<Record<MemoryType, number>>;
  result_type_hits: Partial<Record<MemoryType, number>>;
  top_search_queries: Array<{
    query: string;
    count: number;
  }>;
  overview: WeeklyOverview;
  key_signals: string[];
  recommended_actions: RecommendedAction[];
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

export type ConsolidationCandidateKind =
  | "duplicate_merge"
  | "expired_fact"
  | "global_promotion"
  | "wiki_synthesis"
  | "conflict_aggregation";

export const CONSOLIDATION_CANDIDATE_KINDS = [
  "duplicate_merge",
  "expired_fact",
  "global_promotion",
  "wiki_synthesis",
  "conflict_aggregation"
] as const satisfies readonly ConsolidationCandidateKind[];

export type ConsolidationCandidateAction =
  | "merge"
  | "archive"
  | "mark_expired"
  | "promote_global"
  | "synthesize_wiki"
  | "review_conflict";

export const LOW_RISK_CONSOLIDATION_AUTO_ACTIONS = [
  "archive",
  "mark_expired",
  "synthesize_wiki"
] as const satisfies readonly ConsolidationCandidateAction[];

export type ConsolidationCandidateRisk = "low" | "medium" | "high";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "approved_pending_execution"
  | "execution_failed"
  | "rejected"
  | "expired";

export type ConsolidationTrigger =
  | "manual"
  | "nightly"
  | "after_writes"
  | "after_session_end";

export type ConsolidationPolicyMode = "dry_run" | "auto_low_risk";

export interface ConsolidationPolicy {
  trigger: ConsolidationTrigger;
  mode: ConsolidationPolicyMode;
  min_writes_threshold: number;
  enabled_detectors: ConsolidationCandidateKind[];
  auto_actions: ConsolidationCandidateAction[];
}

export interface ConsolidationRunRecord {
  run_id: string;
  project: string;
  tenant_id: string | null;
  trigger: ConsolidationTrigger;
  mode: ConsolidationPolicyMode;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  total_candidates: number;
  actions_executed: number;
  actions_skipped: number;
  errors: string[];
}

export interface ConsolidationCandidate {
  kind: ConsolidationCandidateKind;
  action: ConsolidationCandidateAction;
  risk: ConsolidationCandidateRisk;
  memory_ids: string[];
  fact_claim_ids: string[];
  description: string;
  evidence: string[];
  score: number;
}

export interface ApprovalItem {
  id: string;
  run_id: string;
  project: string;
  tenant_id: string | null;
  candidate_kind: ConsolidationCandidateKind;
  candidate_action: ConsolidationCandidateAction;
  candidate_risk: ConsolidationCandidateRisk;
  memory_ids: string[];
  fact_claim_ids: string[];
  description: string;
  evidence: string[];
  score: number;
  status: ApprovalStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalDecision {
  item_id: string;
  status: "approved" | "rejected";
  reviewed_by: string;
  comment?: string;
}

export interface ConsolidationReportSection {
  kind: ConsolidationCandidateKind;
  label: string;
  candidates: ConsolidationCandidate[];
}

export interface ConsolidationReportExecutionLog {
  run_id: string;
  project: string;
  tenant_id: string | null;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  total_candidates: number;
  candidates_by_kind: Partial<Record<ConsolidationCandidateKind, number>>;
  errors: string[];
  mode: ConsolidationPolicyMode;
}

export interface ConsolidationReport {
  version: 1;
  execution: ConsolidationReportExecutionLog;
  sections: ConsolidationReportSection[];
  summary: {
    total_candidates: number;
    low_risk: number;
    medium_risk: number;
    high_risk: number;
  };
}

export interface ConsolidationDashboardMetrics {
  project: string;
  generated_at: string;
  memory_stats: {
    total_active: number;
    total_archived: number;
    by_type: Partial<Record<MemoryType, number>>;
    by_scope: { project: number; global: number };
    conflict_count: number;
  };
  fact_claim_stats: {
    total_active: number;
    expired: number;
    suspected_expired: number;
    conflict: number;
  };
  topic_stats: {
    total_topics: number;
    topics_with_memories: number;
    avg_memories_per_topic: number;
  };
  consolidation_history: {
    last_report_at: string | null;
    total_reports_generated: number;
    total_candidates_found: number;
    total_candidates_resolved: number;
  };
  approval_stats: {
    pending: number;
    approved_total: number;
    rejected_total: number;
  };
  approved_pending_action: number;
  health_indicators: {
    duplicate_density: number;
    stale_fact_ratio: number;
    conflict_backlog: number;
    global_promotion_pending: number;
  };
}

export interface ConsolidationActionResult {
  candidate_index: number;
  action: ConsolidationCandidateAction;
  success: boolean;
  error?: string;
  details?: string;
}

export interface ConsolidationExecutionResult {
  executed: ConsolidationActionResult[];
  skipped_high_risk: number;
  skipped_no_approval: number;
}
