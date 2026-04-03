import type { Memory, MemoryType, SearchResult } from "../core/types.js";

const VERIFIED_WEIGHTS = {
  verified: 1,
  unverified: 0.7,
  rejected: 0,
  conflict: 0.5
} as const;

const VECTOR_WEIGHT = 0.7;
const BM25_WEIGHT = 0.3;

export const computeRecency = (accessedAt: string, decayRate: number): number => {
  const daysSince = (Date.now() - Date.parse(accessedAt)) / 86_400_000;

  return 1 / (1 + daysSince * decayRate);
};

export const getDecayRate = (type: MemoryType): number => {
  switch (type) {
    case "preference":
      return 0;
    case "project_context":
      return 0.01;
    case "task_state":
      return 0.3;
    case "pitfall":
      return 0.02;
    case "decision":
      return 0.05;
    case "insight":
      return 0.03;
  }
};

export const computeFinalScore = (
  similarity: number,
  importance: number,
  recency: number,
  verified: Memory["verified"]
): number => {
  const base = similarity * 0.5 + importance * 0.3 + recency * 0.2;

  return base * VERIFIED_WEIGHTS[verified];
};

const reciprocalRank = (rank: number): number => 1 / rank;

export const hybridSearch = (
  vectorResults: SearchResult[],
  bm25Results: { memory: Memory; rank: number }[]
): SearchResult[] => {
  const fusedScores = new Map<string, number>();
  const memoryById = new Map<string, Memory>();
  const rankedVectorResults = [...vectorResults].sort((left, right) => right.similarity - left.similarity);
  const rankedBm25Results = [...bm25Results].sort((left, right) => left.rank - right.rank);

  rankedVectorResults.forEach((result, index) => {
    const reciprocalRankScore = reciprocalRank(index + 1) * VECTOR_WEIGHT;
    memoryById.set(result.memory.id, result.memory);
    fusedScores.set(result.memory.id, (fusedScores.get(result.memory.id) ?? 0) + reciprocalRankScore);
  });

  rankedBm25Results.forEach((result, index) => {
    const reciprocalRankScore = reciprocalRank(index + 1) * BM25_WEIGHT;
    memoryById.set(result.memory.id, result.memory);
    fusedScores.set(result.memory.id, (fusedScores.get(result.memory.id) ?? 0) + reciprocalRankScore);
  });

  return [...fusedScores.entries()]
    .map(([id, fusedScore]) => ({
      memory: memoryById.get(id) as Memory,
      similarity: fusedScore,
      finalScore: fusedScore
    }))
    .sort((left, right) => right.finalScore - left.finalScore);
};
