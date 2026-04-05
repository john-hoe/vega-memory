import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

import { MemoryService } from "./memory.js";
import { Repository } from "../db/repository.js";

interface DocumentSection {
  heading: string;
  content: string;
}

const INDEXED_MEMORY_IMPORTANCE = 0.95;
const SKIPPED_DIRECTORIES = new Set([".git", "dist", "node_modules"]);

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
    private readonly memoryService: MemoryService
  ) {}

  private async indexSections(
    absolutePath: string,
    sourceLabel: string,
    project: string
  ): Promise<number> {
    const fileName = basename(absolutePath);
    const content = readFileSync(absolutePath, "utf8");
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

    for (const section of sections) {
      const nextCount = (headingCounts.get(section.heading) ?? 0) + 1;
      headingCounts.set(section.heading, nextCount);

      const title =
        nextCount === 1
          ? `${sourceLabel}: ${section.heading}`
          : `${sourceLabel}: ${section.heading} (${nextCount})`;
      const indexedContent = buildTieredContent(section.heading, section.content);
      const tags = [fileName, ...extractHeadingKeywords(section.heading)];
      const existing = existingByTitle.get(title);

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
        }
      }
    }

    return sections.length;
  }

  async indexMarkdown(filePath: string, project: string): Promise<number> {
    const absolutePath = resolve(filePath);
    return this.indexSections(absolutePath, basename(absolutePath), project);
  }

  async indexDirectory(
    dirPath: string,
    project: string,
    extensions = ["md"]
  ): Promise<number> {
    const absoluteDirectory = resolve(dirPath);
    const allowedExtensions = new Set(
      extensions.map((extension) =>
        extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`
      )
    );
    let totalSections = 0;

    for (const filePath of walkFiles(absoluteDirectory)) {
      if (!allowedExtensions.has(extname(filePath).toLowerCase())) {
        continue;
      }

      totalSections += await this.indexSections(
        filePath,
        relative(absoluteDirectory, filePath) || basename(filePath),
        project
      );
    }

    return totalSections;
  }
}
