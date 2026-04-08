export interface RerankerCandidate {
  id: string;
  content: string;
  title?: string;
  originalScore: number;
  originalRank: number;
}

export interface RerankerResult {
  id: string;
  originalScore: number;
  originalRank: number;
  rerankerScore: number;
  finalRank: number;
}

interface RerankerConfig {
  enabled: boolean;
  model?: string;
  topK?: number;
  ollamaUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_TOP_K = 10;
const DEFAULT_TIMEOUT_MS = 15_000;

function tokenizeQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
}

function buildCandidateText(candidate: RerankerCandidate): string {
  return [candidate.title, candidate.content]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function scoreCandidate(query: string, candidate: RerankerCandidate): number {
  const queryTerms = tokenizeQuery(query);

  if (queryTerms.length === 0) {
    return 0;
  }

  const content = buildCandidateText(candidate).toLowerCase();
  const matchedTerms = queryTerms.filter((term) => content.includes(term)).length;

  return matchedTerms / queryTerms.length;
}

function toResults(
  candidates: RerankerCandidate[],
  rerankerScoreForCandidate: (candidate: RerankerCandidate) => number
): RerankerResult[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    originalScore: candidate.originalScore,
    originalRank: candidate.originalRank,
    rerankerScore: rerankerScoreForCandidate(candidate),
    finalRank: 0
  }));
}

function assignFinalRanks(results: RerankerResult[]): RerankerResult[] {
  return results.map((result, index) => ({
    ...result,
    finalRank: index + 1
  }));
}

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\n([\s\S]*?)\n```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function compareResults(left: RerankerResult, right: RerankerResult): number {
  if (right.rerankerScore !== left.rerankerScore) {
    return right.rerankerScore - left.rerankerScore;
  }

  return left.originalRank - right.originalRank;
}

function sortResults(results: RerankerResult[]): RerankerResult[] {
  return [...results].sort(compareResults);
}

function rankTopResults(results: RerankerResult[], topK?: number): RerankerResult[] {
  const sortedResults = sortResults(results);
  const limitedResults = topK === undefined ? sortedResults : sortedResults.slice(0, topK);

  return assignFinalRanks(limitedResults);
}

function getModelResponseContent(body: {
  message?: { content?: unknown };
  response?: unknown;
}): string {
  if (typeof body.message?.content === "string") {
    return body.message.content;
  }

  if (typeof body.response === "string") {
    return body.response;
  }

  return "";
}

const normalizeScores = (
  scores: number[],
  fallbackScores: number[]
): number[] => {
  if (scores.length !== fallbackScores.length || scores.some((score) => !Number.isFinite(score))) {
    return fallbackScores;
  }

  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);

  if (maxScore === minScore) {
    return scores.map(() => 1);
  }

  return scores.map((score) => (score - minScore) / (maxScore - minScore));
};

const fetchWithTimeout = async (
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
};

export class Reranker {
  constructor(private readonly config: RerankerConfig) {}

  async rerank(
    query: string,
    candidates: RerankerCandidate[],
    topK = this.config.topK ?? DEFAULT_TOP_K
  ): Promise<RerankerResult[]> {
    if (!this.config.enabled) {
      return assignFinalRanks(
        toResults(candidates.slice(0, topK), (candidate) => candidate.originalScore)
      );
    }

    if (this.config.model !== undefined) {
      return this.rerankWithModel(
        query,
        candidates,
        this.config.model,
        this.config.ollamaUrl ?? "http://localhost:11434"
      ).then((results) => assignFinalRanks(results.slice(0, topK)));
    }

    return rankTopResults(
      toResults(candidates, (candidate) => scoreCandidate(query, candidate)),
      topK
    );
  }

  async rerankWithModel(
    query: string,
    candidates: RerankerCandidate[],
    model: string,
    ollamaUrl: string
  ): Promise<RerankerResult[]> {
    const fallbackScores = candidates.map((candidate) => scoreCandidate(query, candidate));

    try {
      const response = await fetchWithTimeout(
        `${ollamaUrl.replace(/\/+$/, "")}/api/chat`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model,
            stream: false,
            format: "json",
            messages: [
              {
                role: "system",
                content:
                  "You are a reranker. Return strict JSON with a top-level `scores` array of numbers between 0 and 1, aligned to the candidate order."
              },
              {
                role: "user",
                content: JSON.stringify({
                  query,
                  candidates: candidates.map((candidate) => ({
                    id: candidate.id,
                    text: buildCandidateText(candidate)
                  }))
                })
              }
            ]
          })
        },
        this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
      );

      if (!response.ok) {
        throw new Error(`Reranker request failed with status ${response.status}`);
      }

      const body = (await response.json()) as {
        message?: { content?: unknown };
        response?: unknown;
      };
      const rawContent = getModelResponseContent(body);
      const parsed = JSON.parse(stripMarkdownFence(rawContent)) as { scores?: unknown };
      const scores = Array.isArray(parsed.scores)
        ? parsed.scores.map((score) => (typeof score === "number" ? score : Number.NaN))
        : fallbackScores;
      const normalizedScores = normalizeScores(scores, fallbackScores);

      return rankTopResults(
        candidates.map((candidate, index) => ({
          id: candidate.id,
          originalScore: candidate.originalScore,
          originalRank: candidate.originalRank,
          rerankerScore: normalizedScores[index] ?? fallbackScores[index] ?? 0,
          finalRank: 0
        }))
      );
    } catch {
      return rankTopResults(
        candidates.map((candidate, index) => ({
          id: candidate.id,
          originalScore: candidate.originalScore,
          originalRank: candidate.originalRank,
          rerankerScore: fallbackScores[index] ?? 0,
          finalRank: 0
        }))
      );
    }
  }

  isAvailable(): boolean {
    return this.config.enabled;
  }
}
