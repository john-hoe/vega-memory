import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import type { GraphDirectoryStatus } from "./types.js";
import { GraphSidecarService } from "./graph-sidecar.js";
import { MemoryService } from "./memory.js";
import { extractStructuredDocGraphs } from "./doc-graph.js";
import { isCodeGraphEnabled, type VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";

interface DocumentSection {
  heading: string;
  content: string;
}

interface IndexedSectionResult {
  count: number;
  memoryIds: string[];
  memoryGraphs: ReturnType<typeof extractStructuredDocGraphs>;
}

interface DocIndexOptions {
  graph?: boolean;
  incremental?: boolean;
}

const INDEXED_MEMORY_IMPORTANCE = 0.95;

const normalizeGraphPath = (value: string): string => value.replaceAll("\\", "/");

const toWordLimit = (value: string, wordLimit: number): string => {
  const words = value.trim().split(/\s+/).filter(Boolean);

  if (words.length <= wordLimit) {
    return words.join(" ");
  }

  return `${words.slice(0, wordLimit).join(" ")}...`;
};

const extractHeadingKeywords = (heading: string): string[] =>
  [...new Set(heading.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(
    (keyword) => keyword.length > 2
  );

const splitSections = (content: string, fallbackHeading: string): DocumentSection[] => {
  const lines = content.split(/\r?\n/);
  const sections: DocumentSection[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  const pushSection = (): void => {
    if (currentHeading === null) {
      return;
    }

    const sectionContent = currentLines.join("\n").trim();

    if (sectionContent.length === 0) {
      return;
    }

    sections.push({
      heading: currentHeading,
      content: sectionContent
    });
  };

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      pushSection();
      currentHeading = line.replace(/^##\s+/, "").trim();
      currentLines = [];
      continue;
    }

    if (currentHeading !== null) {
      currentLines.push(line);
    }
  }

  pushSection();

  if (sections.length > 0) {
    return sections;
  }

  const fallbackContent = content.trim();

  return fallbackContent.length === 0
    ? []
    : [
        {
          heading: fallbackHeading,
          content: fallbackContent
        }
      ];
};

const buildTieredContent = (heading: string, content: string): string => {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const summary = paragraphs[0] ?? content.trim();

  return [
    `L0: ${toWordLimit(heading, 10)}`,
    `L1: ${toWordLimit(summary, 50)}`,
    "L2:",
    content.trim()
  ].join("\n");
};

export class DocIndexService {
  constructor(
    private readonly repository: Repository,
    private readonly memoryService: MemoryService,
    private readonly config?: Pick<VegaConfig, "features">,
    private readonly graphSidecar = new GraphSidecarService(repository)
  ) {}

  private async indexSections(
    absolutePath: string,
    sourceLabel: string,
    project: string,
    content = readFileSync(absolutePath, "utf8")
  ): Promise<IndexedSectionResult> {
    const fileName = basename(absolutePath);
    const sections = splitSections(content, fileName);
    const existingByTitle = new Map(
      this.repository
        .listMemories({
          project,
          type: "project_context",
          limit: 10_000
        })
        .map((memory) => [memory.title, memory])
    );
    const headingCounts = new Map<string, number>();
    const indexedSections: Parameters<typeof extractStructuredDocGraphs>[1] = [];
    let ordinal = 0;

    for (const section of sections) {
      ordinal += 1;

      const nextCount = (headingCounts.get(section.heading) ?? 0) + 1;
      headingCounts.set(section.heading, nextCount);

      const title =
        nextCount === 1
          ? `${sourceLabel}: ${section.heading}`
          : `${sourceLabel}: ${section.heading} (${nextCount})`;
      const indexedContent = buildTieredContent(section.heading, section.content);
      const tags = [fileName, ...extractHeadingKeywords(section.heading)];
      const existing = existingByTitle.get(title);
      let indexedMemoryId: string | null = existing?.id ?? null;

      if (existing) {
        await this.memoryService.update(existing.id, {
          content: indexedContent,
          tags,
          importance: INDEXED_MEMORY_IMPORTANCE
        });
      } else {
        const result = await this.memoryService.store({
          title,
          content: indexedContent,
          type: "project_context",
          project,
          tags,
          importance: INDEXED_MEMORY_IMPORTANCE,
          source: "explicit",
          skipSimilarityCheck: true
        });
        const created = this.repository.getMemory(result.id);

        if (created) {
          existingByTitle.set(title, created);
          indexedMemoryId = created.id;
        }
      }

      if (indexedMemoryId) {
        indexedSections.push({
          heading: section.heading,
          content: section.content,
          memoryId: indexedMemoryId,
          ordinal
        });
      }
    }

    return {
      count: sections.length,
      memoryIds: indexedSections.map((section) => section.memoryId),
      memoryGraphs: extractStructuredDocGraphs(sourceLabel, indexedSections)
    };
  }

  private syncStructuredGraph(
    relativePath: string,
    project: string,
    content: string,
    indexed: IndexedSectionResult,
    lastModifiedMs: number | null
  ): void {
    try {
      this.graphSidecar.syncFileGraph({
        kind: "doc",
        scopeKey: project,
        relativePath,
        hash: this.graphSidecar.hashContent(content),
        itemCount: indexed.count,
        memoryIds: indexed.memoryIds,
        lastModifiedMs,
        memoryGraphs: indexed.memoryGraphs
      });
    } catch (error) {
      this.repository.logAudit({
        timestamp: new Date().toISOString(),
        actor: "system",
        action: "doc_graph_sidecar_failed",
        memory_id: indexed.memoryGraphs[0]?.memoryId ?? null,
        detail: error instanceof Error ? error.message : String(error),
        ip: null,
        tenant_id: null
      });
    }
  }

  getDirectoryStatus(dirPath: string, extensions = ["md"]): GraphDirectoryStatus {
    const absoluteDirectory = resolve(dirPath);
    const allowedExtensions = new Set(
      extensions.map((extension) =>
        extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`
      )
    );

    return this.graphSidecar.scanDirectory(
      "doc",
      absoluteDirectory,
      absoluteDirectory,
      allowedExtensions
    ).status;
  }

  async indexMarkdown(
    filePath: string,
    project: string,
    options: DocIndexOptions = {}
  ): Promise<number> {
    const absolutePath = resolve(filePath);
    const sourceLabel = normalizeGraphPath(basename(absolutePath));
    const projectScope = dirname(absolutePath);
    const content = readFileSync(absolutePath, "utf8");
    const graphEnabled = options.graph === true || isCodeGraphEnabled(this.config);
    const cacheEnabled = graphEnabled || options.incremental === true;
    const contentHash = this.graphSidecar.hashContent(content);
    const lastModifiedMs = statSync(absolutePath).mtimeMs;

    if (
      cacheEnabled &&
      this.graphSidecar.isFileUnchanged("doc", projectScope, sourceLabel, contentHash)
    ) {
      return this.graphSidecar.getCacheRecord("doc", projectScope, sourceLabel)?.entity_count ?? 0;
    }

    const indexed = await this.indexSections(absolutePath, sourceLabel, project, content);

    if (graphEnabled) {
      this.syncStructuredGraph(sourceLabel, projectScope, content, indexed, lastModifiedMs);
    } else if (options.incremental === true) {
      this.graphSidecar.syncFileCache({
        kind: "doc",
        scopeKey: projectScope,
        relativePath: sourceLabel,
        hash: contentHash,
        itemCount: indexed.count,
        memoryIds: indexed.memoryIds,
        lastModifiedMs
      });
    }

    return indexed.count;
  }

  async indexDirectory(
    dirPath: string,
    project: string,
    extensions = ["md"],
    options: DocIndexOptions = {}
  ): Promise<number> {
    const absoluteDirectory = resolve(dirPath);
    const allowedExtensions = new Set(
      extensions.map((extension) =>
        extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`
      )
    );
    const graphEnabled = options.graph === true || isCodeGraphEnabled(this.config);
    const cacheEnabled = graphEnabled || options.incremental === true;
    const scan = this.graphSidecar.scanDirectory(
      "doc",
      absoluteDirectory,
      absoluteDirectory,
      allowedExtensions
    );
    const filesToProcess =
      cacheEnabled ? [...scan.new_files, ...scan.modified_files] : scan.current_files;
    let totalSections = cacheEnabled
      ? scan.unchanged_files.reduce(
          (count, file) =>
            count +
            (this.graphSidecar.getCacheRecord("doc", absoluteDirectory, file.file_path)?.entity_count ??
              0),
          0
        )
      : 0;

    for (const file of filesToProcess) {
      const content = readFileSync(file.absolute_path, "utf8");
      const indexed = await this.indexSections(file.absolute_path, file.file_path, project, content);
      totalSections += indexed.count;

      if (graphEnabled) {
        this.syncStructuredGraph(
          file.file_path,
          absoluteDirectory,
          content,
          indexed,
          file.last_modified_ms
        );
      } else if (options.incremental === true) {
        this.graphSidecar.syncFileCache({
          kind: "doc",
          scopeKey: absoluteDirectory,
          relativePath: file.file_path,
          hash: file.content_hash,
          itemCount: indexed.count,
          memoryIds: indexed.memoryIds,
          lastModifiedMs: file.last_modified_ms
        });
      }
    }

    if (cacheEnabled) {
      this.graphSidecar.cleanupDeletedFiles(scan.deleted_files);
    }

    return totalSections;
  }
}
