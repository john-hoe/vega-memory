import { cosineSimilarity } from "../../embedding/ollama.js";
import type { ConsolidationDetector, DetectorContext } from "../consolidation-detector.js";
import type { ConsolidationCandidate, Memory } from "../types.js";

const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;
const TITLE_OVERLAP_THRESHOLD = 0.5;
const TITLE_OVERLAP_BOOST = 0.05;

interface DuplicatePair {
  memories: [Memory, Memory];
  cosine: number;
  score: number;
  titleOverlap: number;
}

const toFloat32Array = (embedding: Buffer): Float32Array =>
  new Float32Array(
    embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength)
  );

const normalizeTitleWords = (title: string): string[] =>
  title
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);

const calculateTitleOverlap = (left: string, right: string): number => {
  const leftWords = new Set(normalizeTitleWords(left));
  const rightWords = new Set(normalizeTitleWords(right));

  if (leftWords.size === 0 || rightWords.size === 0) {
    return 0;
  }

  let shared = 0;

  for (const word of leftWords) {
    if (rightWords.has(word)) {
      shared += 1;
    }
  }

  return shared / Math.min(leftWords.size, rightWords.size);
};

const toPercentage = (value: number): string => `${Math.round(value * 100)}%`;

const compareUpdatedAt = (left: Memory, right: Memory): number => {
  const leftTimestamp = Date.parse(left.updated_at);
  const rightTimestamp = Date.parse(right.updated_at);

  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }

  return left.id.localeCompare(right.id);
};

const toCandidate = (pair: DuplicatePair): ConsolidationCandidate => {
  const sortedMemories = [...pair.memories].sort(compareUpdatedAt) as [Memory, Memory];
  const [older, newer] = sortedMemories;
  const evidence = [
    `cosine similarity: ${pair.cosine.toFixed(3)}`,
    `same type: ${older.type}`
  ];

  if (pair.titleOverlap > TITLE_OVERLAP_THRESHOLD) {
    evidence.push(`title overlap: ${toPercentage(pair.titleOverlap)}`);
  }

  return {
    kind: "duplicate_merge",
    action: "merge",
    risk: pair.score > 0.95 ? "low" : "medium",
    memory_ids: [older.id, newer.id],
    fact_claim_ids: [],
    description: `Memories '${older.title}' and '${newer.title}' are ${toPercentage(pair.score)} similar`,
    evidence,
    score: Number(pair.score.toFixed(3))
  };
};

export class DuplicateDetector implements ConsolidationDetector {
  readonly kind = "duplicate_merge" as const;
  readonly label = "Duplicate Memory Candidates";

  detect(context: DetectorContext): ConsolidationCandidate[] {
    const memories = context.repository.listMemories({
      project: context.project,
      tenant_id: context.tenantId ?? undefined,
      status: "active",
      limit: 10_000
    });
    const groups = new Map<Memory["type"], Memory[]>();

    for (const memory of memories) {
      if (memory.embedding === null) {
        continue;
      }

      const current = groups.get(memory.type) ?? [];
      current.push(memory);
      groups.set(memory.type, current);
    }

    const pairs: DuplicatePair[] = [];

    for (const group of groups.values()) {
      for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
        const left = group[leftIndex];

        if (!left?.embedding) {
          continue;
        }

        for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
          const right = group[rightIndex];

          if (!right?.embedding) {
            continue;
          }

          const cosine = cosineSimilarity(
            toFloat32Array(left.embedding),
            toFloat32Array(right.embedding)
          );
          const titleOverlap = calculateTitleOverlap(left.title, right.title);
          const score = Math.min(
            1,
            cosine + (titleOverlap > TITLE_OVERLAP_THRESHOLD ? TITLE_OVERLAP_BOOST : 0)
          );

          if (score < DUPLICATE_SIMILARITY_THRESHOLD) {
            continue;
          }

          pairs.push({
            memories: [left, right],
            cosine,
            score,
            titleOverlap
          });
        }
      }
    }

    const selected = new Set<string>();
    const candidates: ConsolidationCandidate[] = [];

    pairs
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.memories[0].id.localeCompare(right.memories[0].id);
      })
      .forEach((pair) => {
        const [left, right] = pair.memories;

        if (selected.has(left.id) || selected.has(right.id)) {
          return;
        }

        selected.add(left.id);
        selected.add(right.id);
        candidates.push(toCandidate(pair));
      });

    return candidates;
  }
}
