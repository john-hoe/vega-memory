import type { SourceAdapter } from "./types.js";

export function createCandidateMemorySource(): SourceAdapter {
  return {
    kind: "candidate",
    name: "candidate-memory (pending Wave 4)",
    enabled: false,
    search() {
      return [];
    }
  };
}
