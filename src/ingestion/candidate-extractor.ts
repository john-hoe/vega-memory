import { createHash } from "node:crypto";

export interface ExtractedCandidateContent {
  content: string;
  type: string;
  project: string | null;
  raw_dedup_key: string;
  semantic_fingerprint: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  return String(value).trim();
}

function normalizeProject(value: unknown): string | null {
  const text = normalizeText(value);

  return text.length > 0 ? text : null;
}

function buildDedupKey(parts: string[]): string {
  const joined = parts.join("\n");

  return sha256(joined);
}

function normalizeForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

function buildSemanticFingerprint(parts: string[]): string {
  const joined = parts.map(normalizeForFingerprint).join("\n");

  return sha256(joined);
}

export function extractFromMessagePayload(
  payload: Record<string, unknown>
): ExtractedCandidateContent {
  const text = normalizeText(payload.text ?? payload.content ?? payload.message ?? "");

  return {
    content: text,
    type: "observation",
    project: normalizeProject(payload.project),
    raw_dedup_key: buildDedupKey(["message", text]),
    semantic_fingerprint: buildSemanticFingerprint(["message", text])
  };
}

export function extractFromToolResultPayload(
  payload: Record<string, unknown>
): ExtractedCandidateContent {
  const text = normalizeText(payload.result ?? payload.output ?? payload.content ?? "");
  const toolName = normalizeText(payload.tool_name ?? payload.tool ?? "");

  return {
    content: text,
    type: "insight",
    project: normalizeProject(payload.project),
    raw_dedup_key: buildDedupKey(["tool_result", toolName, text]),
    semantic_fingerprint: buildSemanticFingerprint(["tool_result", toolName, text])
  };
}

export function extractFromDecisionPayload(
  payload: Record<string, unknown>
): ExtractedCandidateContent {
  const text = normalizeText(payload.decision ?? payload.rationale ?? payload.content ?? "");

  return {
    content: text,
    type: "decision",
    project: normalizeProject(payload.project),
    raw_dedup_key: buildDedupKey(["decision", text]),
    semantic_fingerprint: buildSemanticFingerprint(["decision", text])
  };
}

export function extractFromStateChangePayload(
  payload: Record<string, unknown>
): ExtractedCandidateContent {
  const text = normalizeText(payload.description ?? payload.change ?? payload.content ?? "");

  return {
    content: text,
    type: "project_context",
    project: normalizeProject(payload.project),
    raw_dedup_key: buildDedupKey(["state_change", text]),
    semantic_fingerprint: buildSemanticFingerprint(["state_change", text])
  };
}

export function extractFromToolCallPayload(
  payload: Record<string, unknown>
): ExtractedCandidateContent {
  const text = normalizeText(payload.arguments ?? payload.args ?? payload.content ?? "");
  const toolName = normalizeText(payload.tool_name ?? payload.tool ?? "");

  return {
    content: text,
    type: "insight",
    project: normalizeProject(payload.project),
    raw_dedup_key: buildDedupKey(["tool_call", toolName, text]),
    semantic_fingerprint: buildSemanticFingerprint(["tool_call", toolName, text])
  };
}
