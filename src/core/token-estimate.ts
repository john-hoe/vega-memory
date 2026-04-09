import type { Memory, SearchResult, SessionStartWikiPage } from "./types.js";

export const estimateTextTokens = (value: string): number => value.length / 4;

export const estimateMemoryTokens = (
  memory: Pick<Memory, "summary" | "content">
): number => estimateTextTokens(memory.summary ?? memory.content);

export const estimateSearchResultTokens = (results: SearchResult[]): number =>
  results.reduce((total, result) => total + estimateMemoryTokens(result.memory), 0);

export const estimateWikiPageTokens = (
  page: Pick<SessionStartWikiPage, "title" | "summary">
): number => estimateTextTokens(`${page.title}\n${page.summary}`);
