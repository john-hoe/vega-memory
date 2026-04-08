export interface ExpandedQuery {
  original: string;
  variants: string[];
  method: "heuristic" | "llm";
}

interface QueryExpanderConfig {
  enabled: boolean;
  maxVariants?: number;
  model?: string;
  fetchImpl?: typeof fetch;
}

type SearchResultSet = {
  query: string;
  results: Array<{
    id: string;
    score: number;
  }>;
};

const TOKEN_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ["auth", "authentication"],
  ["db", "database"],
  ["k8s", "kubernetes"],
  ["config", "configuration"],
  ["repo", "repository"],
  ["env", "environment"],
  ["msg", "message"],
  ["err", "error"],
  ["req", "request"],
  ["res", "response"]
]);

const COMPOUND_SPLITS: ReadonlyMap<string, string> = new Map([
  ["database", "data base"]
]);

const normalizeQuery = (query: string): string => query.trim().replace(/\s+/g, " ");

const replaceWholeWord = (query: string, replacements: ReadonlyMap<string, string>): string => {
  let expanded = query;

  for (const [term, replacement] of replacements) {
    expanded = expanded.replace(new RegExp(`\\b${term}\\b`, "gi"), replacement);
  }

  return normalizeQuery(expanded);
};

const expandQueryTerms = (query: string): string => {
  const tokens = query.split(/\s+/).filter((token) => token.length > 0);

  return normalizeQuery(
    tokens
      .flatMap((token) => {
        const normalizedToken = token.toLowerCase();
        const synonym = TOKEN_SYNONYMS.get(normalizedToken);
        const compound = COMPOUND_SPLITS.get(normalizedToken);

        if (synonym !== undefined) {
          return [token, synonym];
        }

        if (compound !== undefined) {
          return [token, compound];
        }

        return [token];
      })
      .join(" ")
  );
};

const logExpansionInfo = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

export class QueryExpander {
  private readonly enabled: boolean;
  private readonly maxVariants: number;
  private readonly model?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: QueryExpanderConfig) {
    this.enabled = config.enabled;
    this.maxVariants = Math.max(1, config.maxVariants ?? 3);
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async expand(query: string): Promise<ExpandedQuery> {
    const original = normalizeQuery(query);

    if (!this.enabled) {
      return {
        original,
        variants: [original],
        method: "heuristic"
      };
    }

    const variants = [
      original,
      replaceWholeWord(original, TOKEN_SYNONYMS),
      replaceWholeWord(original, COMPOUND_SPLITS),
      expandQueryTerms(original)
    ].filter((variant, index, allVariants) => variant.length > 0 && allVariants.indexOf(variant) === index);

    return {
      original,
      variants: variants.slice(0, this.maxVariants),
      method: "heuristic"
    };
  }

  async expandWithLLM(query: string, ollamaUrl: string): Promise<ExpandedQuery> {
    if (!this.model) {
      return this.expand(query);
    }

    try {
      const response = await this.fetchImpl(`${ollamaUrl.replace(/\/+$/, "")}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: "json",
          messages: [
            {
              role: "system",
              content: "Return strict JSON with a top-level array field `variants` containing up to 3 alternate search queries."
            },
            {
              role: "user",
              content: query
            }
          ]
        })
      });

      if (!response.ok) {
        throw new Error(`LLM expansion failed: ${response.status}`);
      }

      const body = (await response.json()) as { message?: { content?: string }; response?: string };
      const raw =
        typeof body.message?.content === "string"
          ? body.message.content
          : typeof body.response === "string"
            ? body.response
            : "{}";
      const parsed = JSON.parse(raw) as { variants?: string[] };
      const llmVariants = Array.isArray(parsed.variants)
        ? parsed.variants.map((variant) => normalizeQuery(String(variant))).filter((variant) => variant.length > 0)
        : [];
      const fallback = await this.expand(query);

      return {
        original: fallback.original,
        variants: [...new Set([fallback.original, ...llmVariants, ...fallback.variants])].slice(0, this.maxVariants),
        method: "llm"
      };
    } catch {
      logExpansionInfo("LLM expansion not connected");
      return this.expand(query);
    }
  }

  mergeResults(
    resultSets: SearchResultSet[],
    k = 60
  ): Array<{
    id: string;
    score: number;
  }> {
    const fusedScores = new Map<string, number>();

    resultSets.forEach((resultSet) => {
      void resultSet.query;
      const seenIds = new Set<string>();

      resultSet.results.forEach((result, index) => {
        if (seenIds.has(result.id)) {
          return;
        }

        seenIds.add(result.id);
        const rank = index + 1;
        const fusedScore = 1 / (k + rank);
        fusedScores.set(result.id, (fusedScores.get(result.id) ?? 0) + fusedScore);
      });
    });

    return [...fusedScores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((left, right) => right.score - left.score);
  }
}
