import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

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
  memoryGraphs: ReturnType<typeof extractStructuredDocGraphs>;
}

interface DocIndexOptions {
  graph?: boolean;
}

const INDEXED_MEMORY_IMPORTANCE = 0.95;
const SKIPPED_DIRECTORIES = new Set([".git", "dist", "node_modules"]);

const normalizeGraphPath = (value: string): string => value.replaceAll("\\", "/");

const toWordLimit = (value: string, wordLimit: number): string => {
  const words = value.trim().split(/\s+/).filter(Boolean);

  if (words.length <= wordLimit) {
    return words.join(" ");
  }

  return `${words.slice(0, wordLimit).join(" ")}...`;
};

const walkFiles = (directoryPath: string): string[] => {
  const entries = readdirSync(directoryPath).sort((left, right) => left.localeCompare(right));
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(directoryPath, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry)) {
        continue;
      }

      files.push(...walkFiles(fullPath));
      continue;
    }

    if (stats.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
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
      memoryGraphs: extractStructuredDocGraphs(sourceLabel, indexedSections)
    };
  }

  private syncStructuredGraph(
    relativePath: string,
    project: string,
    content: string,
    indexed: IndexedSectionResult
  ): void {
    try {
      this.graphSidecar.syncFileGraph({
        kind: "doc",
        scopeKey: project,
        relativePath,
        hash: this.graphSidecar.hashContent(content),
        itemCount: indexed.count,
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

    if (
      graphEnabled &&
      this.graphSidecar.isFileUnchanged(
        "doc",
        projectScope,
        sourceLabel,
        this.graphSidecar.hashContent(content)
      )
    ) {
      return this.graphSidecar.getCacheRecord("doc", projectScope, sourceLabel)?.itemCount ?? 0;
    }

    const indexed = await this.indexSections(absolutePath, sourceLabel, project, content);

    if (graphEnabled) {
      this.syncStructuredGraph(sourceLabel, projectScope, content, indexed);
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
    let totalSections = 0;
    const currentRelativePaths = new Set<string>();

    for (const filePath of walkFiles(absoluteDirectory)) {
      if (!allowedExtensions.has(extname(filePath).toLowerCase())) {
        continue;
      }

      const relativePath = normalizeGraphPath(
        relative(absoluteDirectory, filePath) || basename(filePath)
      );
      const content = readFileSync(filePath, "utf8");

      currentRelativePaths.add(relativePath);

      if (
        graphEnabled &&
        this.graphSidecar.isFileUnchanged(
          "doc",
          absoluteDirectory,
          relativePath,
          this.graphSidecar.hashContent(content)
        )
      ) {
        totalSections +=
          this.graphSidecar.getCacheRecord("doc", absoluteDirectory, relativePath)?.itemCount ?? 0;
        continue;
      }

      const indexed = await this.indexSections(filePath, relativePath, project, content);
      totalSections += indexed.count;

      if (graphEnabled) {
        this.syncStructuredGraph(relativePath, absoluteDirectory, content, indexed);
      }
    }

    if (graphEnabled) {
      this.graphSidecar.cleanupMissingFiles("doc", absoluteDirectory, currentRelativePaths);
    }

    return totalSections;
  }
}
