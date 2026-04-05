import type { SearchQualityReport } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { DEFAULT_BM25_WEIGHT, DEFAULT_VECTOR_WEIGHT } from "./ranking.js";

const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

const round = (value: number): number => Number(value.toFixed(3));

export class RelevanceTuner {
  constructor(private readonly repository: Repository) {}

  analyzeSearchQuality(): SearchQualityReport {
    const recallLogs = this.repository.getRecentPerformanceLogs(100, ["recall", "recall_stream"]);

    if (recallLogs.length === 0) {
      return {
        avg_latency_ms: 0,
        avg_results: 0,
        zero_result_pct: 0,
        type_distribution: {},
        recommendations: ["Run more recall operations to collect search quality data."]
      };
    }

    const totalLatency = recallLogs.reduce((sum, entry) => sum + entry.latency_ms, 0);
    const totalResults = recallLogs.reduce((sum, entry) => sum + entry.result_count, 0);
    const zeroResultCount = recallLogs.filter((entry) => entry.result_count === 0).length;
    const similarityLogs = recallLogs.filter(
      (entry): entry is typeof entry & { avg_similarity: number } => typeof entry.avg_similarity === "number"
    );
    const avgSimilarity =
      similarityLogs.length === 0
        ? 0
        : similarityLogs.reduce((sum, entry) => sum + entry.avg_similarity, 0) / similarityLogs.length;
    const typeDistribution = recallLogs.reduce<SearchQualityReport["type_distribution"]>(
      (distribution, entry) => {
        for (const type of entry.result_types ?? []) {
          distribution[type] = (distribution[type] ?? 0) + 1;
        }

        return distribution;
      },
      {}
    );

    const recommendations: string[] = [];
    if (zeroResultCount / recallLogs.length >= 0.25) {
      recommendations.push("Zero-result recalls are high. Lower the similarity threshold.");
    }
    if (similarityLogs.length > 0 && avgSimilarity < 0.35) {
      recommendations.push("Average recall similarity is low. Increase BM25 influence or improve embeddings.");
    }
    if (Object.keys(typeDistribution).length <= 1) {
      recommendations.push("Search results are concentrated in one memory type. Review weighting balance.");
    }
    if (recommendations.length === 0) {
      recommendations.push("Search quality looks stable. Keep current weights and monitor recall trends.");
    }

    return {
      avg_latency_ms: round(totalLatency / recallLogs.length),
      avg_results: round(totalResults / recallLogs.length),
      zero_result_pct: round((zeroResultCount / recallLogs.length) * 100),
      type_distribution: typeDistribution,
      recommendations
    };
  }

  suggestWeightAdjustments(): {
    vectorWeight: number;
    bm25Weight: number;
    similarityThreshold: number;
  } {
    const recallLogs = this.repository.getRecentPerformanceLogs(100, ["recall", "recall_stream"]);
    if (recallLogs.length === 0) {
      return {
        vectorWeight: DEFAULT_VECTOR_WEIGHT,
        bm25Weight: DEFAULT_BM25_WEIGHT,
        similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD
      };
    }

    const zeroResultPct =
      recallLogs.filter((entry) => entry.result_count === 0).length / recallLogs.length;
    const avgBm25Results =
      recallLogs.reduce((sum, entry) => sum + (entry.bm25_result_count ?? 0), 0) / recallLogs.length;
    const similarityThreshold =
      zeroResultPct >= 0.25 ? round(Math.max(0.5, DEFAULT_SIMILARITY_THRESHOLD - 0.1)) : DEFAULT_SIMILARITY_THRESHOLD;

    if (avgBm25Results < 0.5) {
      return {
        vectorWeight: round(0.6),
        bm25Weight: round(0.4),
        similarityThreshold
      };
    }

    return {
      vectorWeight: DEFAULT_VECTOR_WEIGHT,
      bm25Weight: DEFAULT_BM25_WEIGHT,
      similarityThreshold
    };
  }
}
