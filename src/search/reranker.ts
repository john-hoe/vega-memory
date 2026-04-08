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
}

const DEFAULT_TOP_K = 10;

const tokenizeQuery = (query: string): string[] =>
  [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];

const scoreCandidate = (query: string, candidate: RerankerCandidate): number => {
  const queryTerms = tokenizeQuery(query);

  if (queryTerms.length === 0) {
    return 0;
  }

  const content = candidate.content.toLowerCase();
  const matchedTerms = queryTerms.filter((term) => content.includes(term)).length;

  return matchedTerms / queryTerms.length;
};

const toResults = (
  candidates: RerankerCandidate[],
  rerankerScoreForCandidate: (candidate: RerankerCandidate) => number
): RerankerResult[] =>
  candidates.map((candidate) => ({
    id: candidate.id,
    originalScore: candidate.originalScore,
    originalRank: candidate.originalRank,
    rerankerScore: rerankerScoreForCandidate(candidate),
    finalRank: 0
  }));

const assignFinalRanks = (results: RerankerResult[]): RerankerResult[] =>
  results.map((result, index) => ({
    ...result,
    finalRank: index + 1
  }));

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
      ).then((results) => results.slice(0, topK).map((result, index) => ({
        ...result,
        finalRank: index + 1
      })));
    }

    return assignFinalRanks(
      toResults(candidates, (candidate) => scoreCandidate(query, candidate))
        .sort((left, right) => {
          if (right.rerankerScore !== left.rerankerScore) {
            return right.rerankerScore - left.rerankerScore;
          }

          return left.originalRank - right.originalRank;
        })
        .slice(0, topK)
    );
  }

  async rerankWithModel(
    query: string,
    candidates: RerankerCandidate[],
    _model: string,
    _ollamaUrl: string
  ): Promise<RerankerResult[]> {
    console.log("Reranker model not connected");
    return assignFinalRanks(
      toResults(candidates, (candidate) => scoreCandidate(query, candidate)).sort((left, right) => {
        if (right.rerankerScore !== left.rerankerScore) {
          return right.rerankerScore - left.rerankerScore;
        }

        return left.originalRank - right.originalRank;
      })
    );
  }

  isAvailable(): boolean {
    return this.config.enabled;
  }
}
