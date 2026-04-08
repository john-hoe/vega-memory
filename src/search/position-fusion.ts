export interface FusionInput {
  id: string;
  retrievalScore: number;
  retrievalRank: number;
  rerankerScore: number;
  rerankerRank: number;
}

export interface FusionResult {
  id: string;
  finalScore: number;
  finalRank: number;
  retrievalWeight: number;
  rerankerWeight: number;
}

interface PositionAwareFusionConfig {
  enabled: boolean;
  topTrustRetrieval?: number;
  bottomTrustReranker?: number;
}

const TOP_RETRIEVAL_WEIGHT = 0.7;
const TOP_RERANKER_WEIGHT = 0.3;
const BOTTOM_RETRIEVAL_WEIGHT = 0.3;
const BOTTOM_RERANKER_WEIGHT = 0.7;
const DEFAULT_TOP_TRUST_RETRIEVAL = 3;
const DEFAULT_BOTTOM_TRUST_RERANKER = 10;

export class PositionAwareFusion {
  private readonly enabled: boolean;
  private readonly topTrustRetrieval: number;
  private readonly bottomTrustReranker: number;

  constructor(config: PositionAwareFusionConfig) {
    this.enabled = config.enabled;
    this.topTrustRetrieval = Math.max(1, Math.trunc(config.topTrustRetrieval ?? DEFAULT_TOP_TRUST_RETRIEVAL));
    this.bottomTrustReranker = Math.max(
      this.topTrustRetrieval + 1,
      Math.trunc(config.bottomTrustReranker ?? DEFAULT_BOTTOM_TRUST_RERANKER)
    );
  }

  fuse(results: FusionInput[]): FusionResult[] {
    const retrievalOrderedResults = [...results].sort((left, right) => {
      if (left.retrievalRank !== right.retrievalRank) {
        return left.retrievalRank - right.retrievalRank;
      }

      if (left.rerankerRank !== right.rerankerRank) {
        return left.rerankerRank - right.rerankerRank;
      }

      return left.id.localeCompare(right.id);
    });

    if (!this.enabled) {
      return retrievalOrderedResults.map((result, index) => ({
        id: result.id,
        finalScore: result.retrievalScore,
        finalRank: index + 1,
        retrievalWeight: 1,
        rerankerWeight: 0
      }));
    }

    return retrievalOrderedResults
      .map((result) => {
        const { retrievalWeight, rerankerWeight } = this.getWeights(result.retrievalRank);

        return {
          id: result.id,
          finalScore: result.retrievalScore * retrievalWeight + result.rerankerScore * rerankerWeight,
          retrievalWeight,
          rerankerWeight,
          retrievalRank: result.retrievalRank,
          rerankerRank: result.rerankerRank
        };
      })
      .sort((left, right) => {
        if (left.finalScore !== right.finalScore) {
          return right.finalScore - left.finalScore;
        }

        if (left.retrievalRank !== right.retrievalRank) {
          return left.retrievalRank - right.retrievalRank;
        }

        if (left.rerankerRank !== right.rerankerRank) {
          return left.rerankerRank - right.rerankerRank;
        }

        return left.id.localeCompare(right.id);
      })
      .map(({ id, finalScore, retrievalWeight, rerankerWeight }, index) => ({
        id,
        finalScore,
        finalRank: index + 1,
        retrievalWeight,
        rerankerWeight
      }));
  }

  private getWeights(position: number): Pick<FusionResult, "retrievalWeight" | "rerankerWeight"> {
    if (position <= this.topTrustRetrieval) {
      return {
        retrievalWeight: TOP_RETRIEVAL_WEIGHT,
        rerankerWeight: TOP_RERANKER_WEIGHT
      };
    }

    if (position > this.bottomTrustReranker) {
      return {
        retrievalWeight: BOTTOM_RETRIEVAL_WEIGHT,
        rerankerWeight: BOTTOM_RERANKER_WEIGHT
      };
    }

    const interpolationStart = this.topTrustRetrieval + 1;
    const interpolationSpan = this.bottomTrustReranker - interpolationStart;
    const progress = interpolationSpan === 0 ? 1 : (position - interpolationStart) / interpolationSpan;
    const retrievalWeight =
      TOP_RETRIEVAL_WEIGHT + (BOTTOM_RETRIEVAL_WEIGHT - TOP_RETRIEVAL_WEIGHT) * progress;
    const rerankerWeight =
      TOP_RERANKER_WEIGHT + (BOTTOM_RERANKER_WEIGHT - TOP_RERANKER_WEIGHT) * progress;

    return {
      retrievalWeight,
      rerankerWeight
    };
  }
}
