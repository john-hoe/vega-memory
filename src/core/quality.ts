import type { VegaConfig } from "../config.js";
import type { Memory, QualityScore } from "./types.js";
import { Repository } from "../db/repository.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

const now = (): string => new Date().toISOString();

const getAccuracy = (memory: Memory): number => {
  switch (memory.verified) {
    case "verified":
      return 1;
    case "unverified":
      return 0.5;
    case "conflict":
      return 0.3;
    case "rejected":
      return 0;
  }
};

export class QualityService {
  constructor(
    private readonly repository: Repository,
    private readonly _config: VegaConfig
  ) {}

  scoreMemory(memory: Memory): QualityScore {
    const daysSinceUpdate = Math.max(0, (Date.now() - Date.parse(memory.updated_at)) / DAY_MS);
    const accuracy = getAccuracy(memory);
    const freshness = clamp(1 / (1 + daysSinceUpdate * 0.01));
    const usefulness = clamp(memory.access_count / 10);
    const completeness = clamp(memory.content.length / 200);
    const overall =
      accuracy * 0.4 + freshness * 0.2 + usefulness * 0.2 + completeness * 0.2;

    return {
      accuracy,
      freshness,
      usefulness,
      completeness,
      overall
    };
  }

  async scoreBatch(
    project?: string
  ): Promise<{ total: number; avg_score: number; low_quality: Memory[] }> {
    const memories = this.repository.listMemories({
      project,
      status: "active",
      limit: 1_000_000
    });
    const scored = memories.map((memory) => ({
      memory,
      score: this.scoreMemory(memory)
    }));
    const total = scored.length;
    const avg_score =
      total === 0
        ? 0
        : scored.reduce((sum, entry) => sum + entry.score.overall, 0) / total;
    const low_quality = scored
      .filter((entry) => entry.score.overall < 0.3)
      .sort((left, right) => left.score.overall - right.score.overall)
      .map((entry) => entry.memory);

    return {
      total,
      avg_score,
      low_quality
    };
  }

  async degradeLowQuality(project?: string, threshold = 0.3): Promise<number> {
    const memories = this.repository.listMemories({
      project,
      status: "active",
      limit: 1_000_000
    });
    const updated_at = now();
    let degraded = 0;

    for (const memory of memories) {
      if (this.scoreMemory(memory).overall >= threshold) {
        continue;
      }

      const nextImportance = Math.max(0, memory.importance - 0.1);
      if (nextImportance === memory.importance) {
        continue;
      }

      this.repository.updateMemory(memory.id, {
        importance: nextImportance,
        updated_at
      });
      degraded += 1;
    }

    return degraded;
  }
}
