import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { v4 as uuidv4 } from "uuid";

import { MemoryService } from "./memory.js";
import { Repository } from "../db/repository.js";

interface DocumentSection {
  heading: string;
  content: string;
}

const now = (): string => new Date().toISOString();

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
    private readonly _memoryService: MemoryService
  ) {}

  async indexMarkdown(filePath: string, project: string): Promise<number> {
    const absolutePath = resolve(filePath);
    const fileName = basename(absolutePath);
    const content = readFileSync(absolutePath, "utf8");
    const sections = splitSections(content, fileName);
    const timestamp = now();

    for (const section of sections) {
      const title = `${fileName}: ${section.heading}`;
      const indexedContent = buildTieredContent(section.heading, section.content);
      const tags = [fileName, ...extractHeadingKeywords(section.heading)];
      const existing = this.repository
        .listMemories({
          project,
          type: "project_context",
          limit: 10_000
        })
        .find((memory) => memory.title === title);

      if (existing) {
        this.repository.updateMemory(existing.id, {
          content: indexedContent,
          tags,
          updated_at: timestamp,
          accessed_at: timestamp
        });
        continue;
      }

      this.repository.createMemory({
        id: uuidv4(),
        title,
        content: indexedContent,
        type: "project_context",
        project,
        embedding: null,
        importance: 0.7,
        source: "explicit",
        tags,
        created_at: timestamp,
        updated_at: timestamp,
        accessed_at: timestamp,
        status: "active",
        verified: "verified",
        scope: "project",
        accessed_projects: [project]
      });
    }

    return sections.length;
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

      totalSections += await this.indexMarkdown(filePath, project);
    }

    return totalSections;
  }
}
