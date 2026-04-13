import type { VegaConfig } from "../config.js";
import { buildSourceContext } from "../core/device.js";
import type { StoreParams, StoreResult } from "../core/types.js";
import { PageManager } from "../wiki/page-manager.js";
import { SynthesisEngine } from "../wiki/synthesis.js";
import { ContentDistiller } from "./distiller.js";
import { ContentFetcher } from "./fetcher.js";

export interface IngestResult {
  source_id: string;
  memories_created: number;
  memory_ids: string[];
  synthesis_queued: boolean;
}

interface IngestParams {
  url?: string;
  content?: string;
  title?: string;
  filePath?: string;
  clipboard?: boolean;
  tags?: string[];
  project?: string;
}

type MemoryStoreService = {
  store(params: StoreParams): Promise<StoreResult>;
};

const normalizeTitle = (value: string): string => value.trim().replace(/\s+/g, " ");

const inferTitle = (content: string, fallback: string): string => {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return fallback;
  }

  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
};

export class IngestionService {
  constructor(
    private readonly fetcher: ContentFetcher,
    private readonly distiller: ContentDistiller,
    private readonly pageManager: PageManager,
    private readonly memoryService: MemoryStoreService,
    private readonly synthesisEngine: SynthesisEngine,
    private readonly config: VegaConfig
  ) {}

  async ingest(params: IngestParams): Promise<IngestResult> {
    const sourceCount = [
      params.url !== undefined,
      params.filePath !== undefined,
      params.content !== undefined,
      params.clipboard === true
    ].filter(Boolean).length;

    if (sourceCount !== 1) {
      throw new Error("Provide exactly one content input: url, filePath, content, or clipboard");
    }

    const resolvedProject = params.project ?? "global";
    const sourceTags = params.tags ?? [];
    let sourceType: "web_article" | "file" | "manual_note" = "manual_note";
    let sourceUrl: string | null = null;
    let title = params.title ? normalizeTitle(params.title) : "";
    let content = "";

    if (params.url) {
      const extracted = await this.fetcher.fetchUrl(params.url);
      sourceType = "web_article";
      sourceUrl = params.url;
      title = title || extracted.title;
      content = extracted.content;
    } else if (params.filePath) {
      const extracted = await this.fetcher.fetchFile(params.filePath);
      sourceType = "file";
      title = title || extracted.title;
      content = extracted.content;
    } else if (params.clipboard) {
      content = await this.fetcher.readClipboard();
      title = title || inferTitle(content, "Clipboard Note");
    } else {
      content = params.content as string;
      title = title || inferTitle(content, "Untitled Note");
    }

    const contentSource = this.pageManager.createContentSource({
      source_type: sourceType,
      url: sourceUrl,
      title,
      raw_content: content,
      project: params.project ?? null,
      tags: sourceTags
    });

    const distilled = await this.distiller.distill(content, title, params.project);
    const memoryIds = await this.distiller.storeDistilled(
      distilled,
      resolvedProject,
      this.memoryService,
      this.config
    );

    this.pageManager.markContentSourceProcessed(contentSource.id);

    const synthesisCandidates = await this.synthesisEngine.findSynthesisCandidates(params.project);
    const synthesisQueued = synthesisCandidates.some((candidate) =>
      candidate.memory_ids.some((memoryId) => memoryIds.includes(memoryId))
    );

    return {
      source_id: contentSource.id,
      memories_created: memoryIds.length,
      memory_ids: memoryIds,
      synthesis_queued: synthesisQueued
    };
  }

  async quickNote(
    content: string,
    topic: string,
    project?: string,
    tags?: string[]
  ): Promise<string> {
    const stored = await this.memoryService.store({
      content,
      type: "project_context",
      project: project ?? "global",
      title: normalizeTitle(topic),
      tags: [...new Set([topic, ...(tags ?? [])])],
      source: "explicit",
      sourceContext: buildSourceContext("user", "cli", {
        surface: "cli",
        integration: "vega-cli"
      })
    });

    return stored.id;
  }
}
