import { v4 as uuidv4 } from "uuid";

import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { chatWithOllama } from "../embedding/ollama.js";
import { PageManager } from "./page-manager.js";
import type { WikiPage } from "./types.js";

interface WikiContradictionRow {
  id: string;
  page_a_id: string;
  page_a_title: string;
  page_a_slug: string;
  page_b_id: string;
  page_b_title: string;
  page_b_slug: string;
  statement_a: string;
  statement_b: string;
  detected_at: string;
  resolved: number;
}

interface ExistingContradictionRow {
  id: string;
  resolved: number;
}

interface CountRow {
  total: number;
}

interface ClaimComparisonCandidate {
  statement_a: string;
  statement_b: string;
  score: number;
}

export interface WikiContradiction {
  id: string;
  page_a_id: string;
  page_a_title: string;
  page_a_slug: string;
  page_b_id: string;
  page_b_title: string;
  page_b_slug: string;
  statement_a: string;
  statement_b: string;
  detected_at: string;
  resolved: boolean;
}

const MAX_PAGE_SCAN = 10_000;
const MAX_KEY_CLAIMS = 20;
const MAX_COMPARISONS_PER_PAIR = 10;
const CONTRADICTION_CACHE_PREFIX = "wiki-contradiction-cache:";
const NEGATION_PATTERN = /\b(?:no|not|never|cannot|can't|dont|don't|avoid|disable|disabled|without)\b/i;
const STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "from",
  "have",
  "into",
  "that",
  "their",
  "there",
  "these",
  "this",
  "those",
  "with",
  "will",
  "should",
  "must",
  "page",
  "wiki"
]);
const TECHNICAL_CLAIM_PATTERNS = [
  /`[^`\n]+`/,
  /\b(?:use|prefer|avoid|do not use|don't use|always use|never use|must|should|decided|choose|chose|selected)\b/i,
  /(?:^|[\s(])(?:\.{0,2}\/)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+(?:\.[a-z0-9_-]+)?\b/i,
  /\bv?\d+\.\d+(?:\.\d+)?\b/i,
  /\b\d+\s*(?:ms|s|sec|seconds|minutes|min|hours|hrs|gb|mb|kb|%|x)\b/i,
  /\b(?:npm|pnpm|yarn|node|npx|git|vega|tsc|ollama|sqlite|better-sqlite3|commander(?:\.js)?)\b/i
] as const;

const now = (): string => new Date().toISOString();

const normalizeWhitespace = (value: string): string => value.trim().replace(/\s+/g, " ");

const mapWikiContradiction = (row: WikiContradictionRow): WikiContradiction => ({
  id: row.id,
  page_a_id: row.page_a_id,
  page_a_title: row.page_a_title,
  page_a_slug: row.page_a_slug,
  page_b_id: row.page_b_id,
  page_b_title: row.page_b_title,
  page_b_slug: row.page_b_slug,
  statement_a: row.statement_a,
  statement_b: row.statement_b,
  detected_at: row.detected_at,
  resolved: row.resolved === 1
});

const tokenizeClaim = (value: string): Set<string> =>
  new Set(
    normalizeWhitespace(value)
      .toLowerCase()
      .split(/[^a-z0-9_./:\-]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
  );

const extractNumbers = (value: string): string[] =>
  value.match(/\bv?\d+(?:\.\d+){0,2}\b/gi) ?? [];

const extractAnchors = (value: string): Set<string> =>
  new Set(
    (value.match(/`[^`\n]+`|(?:\.{0,2}\/)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+(?:\.[a-z0-9_-]+)?|\bv?\d+\.\d+(?:\.\d+)?\b/gi) ??
      [])
      .map((item) => item.replace(/^`|`$/g, "").toLowerCase())
  );

const sentencesFromContent = (content: string): string[] =>
  content
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n+/u)
    .flatMap((line) => line.split(/(?<=[.!?。！？])\s+/u))
    .map((sentence) =>
      normalizeWhitespace(sentence.replace(/^[-*#>\s]+/, "").replace(/\[\[|\]\]/g, ""))
    )
    .filter((sentence) => sentence.length > 0);

const sharesTag = (left: WikiPage, right: WikiPage): boolean => {
  const tags = new Set(left.tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0));

  return right.tags.some((tag) => tags.has(tag.trim().toLowerCase()));
};

const orderPages = (left: WikiPage, right: WikiPage): [WikiPage, WikiPage] =>
  left.id.localeCompare(right.id) <= 0 ? [left, right] : [right, left];

export class ContradictionDetector {
  constructor(
    private readonly pageManager: PageManager,
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {}

  extractKeyClaims(content: string): string[] {
    const claims: string[] = [];
    const seen = new Set<string>();

    for (const sentence of sentencesFromContent(content)) {
      if (!TECHNICAL_CLAIM_PATTERNS.some((pattern) => pattern.test(sentence))) {
        continue;
      }

      const normalized = sentence.toLowerCase();
      if (seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      claims.push(sentence);

      if (claims.length >= MAX_KEY_CLAIMS) {
        break;
      }
    }

    return claims;
  }

  getContradictions(project?: string): WikiContradiction[] {
    const clauses = ["wiki_contradictions.resolved = 0"];
    const params: unknown[] = [];

    if (project) {
      clauses.push("(page_a.project = ? OR page_b.project = ?)");
      params.push(project, project);
    }

    const rows = this.repository.db
      .prepare<unknown[], WikiContradictionRow>(
        `SELECT
           wiki_contradictions.id AS id,
           wiki_contradictions.page_a_id AS page_a_id,
           page_a.title AS page_a_title,
           page_a.slug AS page_a_slug,
           wiki_contradictions.page_b_id AS page_b_id,
           page_b.title AS page_b_title,
           page_b.slug AS page_b_slug,
           wiki_contradictions.statement_a AS statement_a,
           wiki_contradictions.statement_b AS statement_b,
           wiki_contradictions.detected_at AS detected_at,
           wiki_contradictions.resolved AS resolved
         FROM wiki_contradictions
         JOIN wiki_pages AS page_a ON page_a.id = wiki_contradictions.page_a_id
         JOIN wiki_pages AS page_b ON page_b.id = wiki_contradictions.page_b_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY wiki_contradictions.detected_at DESC`
      )
      .all(...params);

    return rows.map(mapWikiContradiction);
  }

  resolveContradiction(id: string): void {
    this.repository.db
      .prepare<[string]>("UPDATE wiki_contradictions SET resolved = 1 WHERE id = ?")
      .run(id);
  }

  async detectContradictions(project?: string): Promise<WikiContradiction[]> {
    const pages = this.pageManager
      .listPages({
        ...(project ? { project } : {}),
        status: "published",
        limit: MAX_PAGE_SCAN,
        sort: "id ASC"
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    const contradictions = new Map<string, WikiContradiction>();

    for (let index = 0; index < pages.length; index += 1) {
      const current = pages[index];
      if (current.tags.length === 0) {
        continue;
      }

      for (let candidateIndex = index + 1; candidateIndex < pages.length; candidateIndex += 1) {
        const candidate = pages[candidateIndex];
        if (!sharesTag(current, candidate)) {
          continue;
        }

        const [pageA, pageB] = orderPages(current, candidate);
        if (this.isPairCached(pageA, pageB)) {
          for (const contradiction of this.getPairContradictions(pageA.id, pageB.id)) {
            contradictions.set(contradiction.id, contradiction);
          }
          continue;
        }

        const claimsA = this.extractKeyClaims(pageA.content);
        const claimsB = this.extractKeyClaims(pageB.content);

        if (claimsA.length === 0 || claimsB.length === 0) {
          this.markPairCached(pageA, pageB);
          continue;
        }

        const candidatesToCompare = this.buildClaimCandidates(claimsA, claimsB);
        let fullyCompared = true;

        for (const claimPair of candidatesToCompare) {
          const verdict = await this.compareClaims(pageA, pageB, claimPair.statement_a, claimPair.statement_b);

          if (verdict === null) {
            fullyCompared = false;
            break;
          }

          if (!verdict.toUpperCase().startsWith("CONTRADICTION")) {
            continue;
          }

          const contradiction = this.createOrReuseContradiction(
            pageA,
            pageB,
            claimPair.statement_a,
            claimPair.statement_b
          );
          contradictions.set(contradiction.id, contradiction);
        }

        if (fullyCompared) {
          this.markPairCached(pageA, pageB);
        }

        for (const contradiction of this.getPairContradictions(pageA.id, pageB.id)) {
          contradictions.set(contradiction.id, contradiction);
        }
      }
    }

    return [...contradictions.values()].sort(
      (left, right) => Date.parse(right.detected_at) - Date.parse(left.detected_at)
    );
  }

  private getPairCacheKey(pageA: WikiPage, pageB: WikiPage): string {
    return `${CONTRADICTION_CACHE_PREFIX}${pageA.id}:${pageA.version}:${pageB.id}:${pageB.version}`;
  }

  private isPairCached(pageA: WikiPage, pageB: WikiPage): boolean {
    return this.repository.getMetadata(this.getPairCacheKey(pageA, pageB)) !== null;
  }

  private markPairCached(pageA: WikiPage, pageB: WikiPage): void {
    this.repository.setMetadata(this.getPairCacheKey(pageA, pageB), now());
  }

  private getPairContradictions(pageAId: string, pageBId: string): WikiContradiction[] {
    const rows = this.repository.db
      .prepare<[string, string], WikiContradictionRow>(
        `SELECT
           wiki_contradictions.id AS id,
           wiki_contradictions.page_a_id AS page_a_id,
           page_a.title AS page_a_title,
           page_a.slug AS page_a_slug,
           wiki_contradictions.page_b_id AS page_b_id,
           page_b.title AS page_b_title,
           page_b.slug AS page_b_slug,
           wiki_contradictions.statement_a AS statement_a,
           wiki_contradictions.statement_b AS statement_b,
           wiki_contradictions.detected_at AS detected_at,
           wiki_contradictions.resolved AS resolved
         FROM wiki_contradictions
         JOIN wiki_pages AS page_a ON page_a.id = wiki_contradictions.page_a_id
         JOIN wiki_pages AS page_b ON page_b.id = wiki_contradictions.page_b_id
         WHERE wiki_contradictions.page_a_id = ?
           AND wiki_contradictions.page_b_id = ?
           AND wiki_contradictions.resolved = 0
         ORDER BY wiki_contradictions.detected_at DESC`
      )
      .all(pageAId, pageBId);

    return rows.map(mapWikiContradiction);
  }

  private buildClaimCandidates(
    claimsA: string[],
    claimsB: string[]
  ): ClaimComparisonCandidate[] {
    const candidates: ClaimComparisonCandidate[] = [];

    for (const statementA of claimsA) {
      const tokensA = tokenizeClaim(statementA);
      const anchorsA = extractAnchors(statementA);
      const numbersA = extractNumbers(statementA);
      const negatedA = NEGATION_PATTERN.test(statementA);

      for (const statementB of claimsB) {
        if (statementA.toLowerCase() === statementB.toLowerCase()) {
          continue;
        }

        const tokensB = tokenizeClaim(statementB);
        const overlap = [...tokensA].filter((token) => tokensB.has(token));
        const anchorsB = extractAnchors(statementB);
        const sharedAnchors = [...anchorsA].filter((anchor) => anchorsB.has(anchor));
        const numbersB = extractNumbers(statementB);
        const differentNumbers =
          numbersA.length > 0 &&
          numbersB.length > 0 &&
          numbersA.join("|").toLowerCase() !== numbersB.join("|").toLowerCase();
        const negationMismatch = negatedA !== NEGATION_PATTERN.test(statementB);

        if (overlap.length === 0 && sharedAnchors.length === 0) {
          continue;
        }

        candidates.push({
          statement_a: statementA,
          statement_b: statementB,
          score:
            overlap.length +
            sharedAnchors.length * 2 +
            (differentNumbers ? 2 : 0) +
            (negationMismatch ? 3 : 0)
        });
      }
    }

    return candidates
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_COMPARISONS_PER_PAIR);
  }

  private async compareClaims(
    pageA: WikiPage,
    pageB: WikiPage,
    statementA: string,
    statementB: string
  ): Promise<string | null> {
    return await chatWithOllama(
      [
        {
          role: "system",
          content:
            'You are a fact-checker. Compare these two statements from different documents and determine if they contradict each other. Reply ONLY with "CONTRADICTION" or "CONSISTENT" followed by a brief explanation.'
        },
        {
          role: "user",
          content: `Statement A (from "${pageA.title}"): ${statementA}\nStatement B (from "${pageB.title}"): ${statementB}`
        }
      ],
      this.config
    );
  }

  private createOrReuseContradiction(
    pageA: WikiPage,
    pageB: WikiPage,
    statementA: string,
    statementB: string
  ): WikiContradiction {
    const existing = this.repository.db
      .prepare<[string, string, string, string], ExistingContradictionRow>(
        `SELECT id, resolved
         FROM wiki_contradictions
         WHERE page_a_id = ?
           AND page_b_id = ?
           AND statement_a = ?
           AND statement_b = ?
         ORDER BY detected_at DESC
         LIMIT 1`
      )
      .get(pageA.id, pageB.id, statementA, statementB);

    if (existing && existing.resolved === 0) {
      return this.getPairContradictions(pageA.id, pageB.id).find(
        (contradiction) =>
          contradiction.id === existing.id &&
          contradiction.statement_a === statementA &&
          contradiction.statement_b === statementB
      ) as WikiContradiction;
    }

    const detectedAt = now();
    const id = uuidv4();

    this.repository.db
      .prepare<[string, string, string, string, string, string, number]>(
        `INSERT INTO wiki_contradictions (
           id, page_a_id, page_b_id, statement_a, statement_b, detected_at, resolved
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, pageA.id, pageB.id, statementA, statementB, detectedAt, 0);

    return {
      id,
      page_a_id: pageA.id,
      page_a_title: pageA.title,
      page_a_slug: pageA.slug,
      page_b_id: pageB.id,
      page_b_title: pageB.title,
      page_b_slug: pageB.slug,
      statement_a: statementA,
      statement_b: statementB,
      detected_at: detectedAt,
      resolved: false
    };
  }
}
