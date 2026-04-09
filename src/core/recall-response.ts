import type { Memory, SearchResult } from "./types.js";

export interface RecallResponseItem {
  id: string;
  type: Memory["type"];
  project: string;
  title: string;
  content: string;
  importance: number;
  source: Memory["source"];
  tags: string[];
  created_at: string;
  updated_at: string;
  accessed_at: string;
  access_count: number;
  status: Memory["status"];
  verified: Memory["verified"];
  scope: Memory["scope"];
  accessed_projects: string[];
  similarity: number;
  finalScore: number;
}

export const serializeRecallResult = (result: SearchResult): RecallResponseItem => ({
  id: result.memory.id,
  type: result.memory.type,
  project: result.memory.project,
  title: result.memory.title,
  content: result.memory.content,
  importance: result.memory.importance,
  source: result.memory.source,
  tags: result.memory.tags,
  created_at: result.memory.created_at,
  updated_at: result.memory.updated_at,
  accessed_at: result.memory.accessed_at,
  access_count: result.memory.access_count,
  status: result.memory.status,
  verified: result.memory.verified,
  scope: result.memory.scope,
  accessed_projects: result.memory.accessed_projects,
  similarity: result.similarity,
  finalScore: result.finalScore
});
