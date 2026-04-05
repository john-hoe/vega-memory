import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

import type { CodeSymbol, Memory } from "./types.js";
import { MemoryService } from "./memory.js";
import { Repository } from "../db/repository.js";

const TS_EXPORT_PATTERN =
  /export\s+(?:default\s+)?(?:async\s+)?(class|function|const|interface|type)\s+(\w+)/g;
const PYTHON_PATTERN = /^\s*(?:async\s+)?(class|def)\s+(\w+)/g;
const INDEXED_MEMORY_IMPORTANCE = 0.95;
const SKIPPED_DIRECTORIES = new Set([".git", "dist", "node_modules"]);

const normalizeExtensions = (extensions: string[]): Set<string> =>
  new Set(
    extensions
      .map((extension) => extension.trim().toLowerCase())
      .filter((extension) => extension.length > 0)
      .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`))
  );

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

const findSymbols = (content: string, filePath: string): CodeSymbol[] => {
  const extension = extname(filePath).toLowerCase();
  const lines = content.split(/\r?\n/);
  const patterns =
    extension === ".py"
      ? [{ expression: PYTHON_PATTERN }]
      : [{ expression: TS_EXPORT_PATTERN }];
  const symbols: CodeSymbol[] = [];

  lines.forEach((lineContent, index) => {
    for (const { expression } of patterns) {
      expression.lastIndex = 0;

      for (const match of lineContent.matchAll(expression)) {
        symbols.push({
          name: match[2],
          kind: match[1],
          file: filePath,
          line: index + 1
        });
      }
    }
  });

  return symbols;
};

const buildMemoryContent = (relativeFilePath: string, symbols: CodeSymbol[]): string =>
  symbols.length === 0
    ? `File: ${relativeFilePath}\nNo exported symbols found.`
    : [
        `File: ${relativeFilePath}`,
        ...symbols.map((symbol) => `${symbol.kind} ${symbol.name} line ${symbol.line}`)
      ].join("\n");

export class CodeIndexService {
  constructor(
    private readonly repository: Repository,
    private readonly memoryService: MemoryService
  ) {}

  indexFile(filePath: string): CodeSymbol[] {
    const absolutePath = resolve(filePath);
    const content = readFileSync(absolutePath, "utf8");

    return findSymbols(content, absolutePath);
  }

  async indexDirectory(dirPath: string, extensions: string[]): Promise<number> {
    const absoluteDirectory = resolve(dirPath);
    const allowedExtensions = normalizeExtensions(extensions);
    const project = basename(absoluteDirectory);
    const existingByTitle = new Map(
      this.repository
        .listMemories({
          project,
          type: "project_context",
          limit: 10_000
        })
        .map((memory) => [memory.title, memory])
    );
    let indexedFiles = 0;

    for (const filePath of walkFiles(absoluteDirectory)) {
      if (!allowedExtensions.has(extname(filePath).toLowerCase())) {
        continue;
      }

      const relativeFilePath = relative(absoluteDirectory, filePath) || basename(filePath);
      const symbols = this.indexFile(filePath);
      const title = `Code Index: ${relativeFilePath}`;
      const content = buildMemoryContent(relativeFilePath, symbols);
      const tags = [basename(filePath), ...symbols.map((symbol) => symbol.name)];
      const existing = existingByTitle.get(title);

      if (existing) {
        await this.memoryService.update(existing.id, {
          content,
          tags,
          importance: INDEXED_MEMORY_IMPORTANCE
        });
        const refreshed = this.repository.getMemory(existing.id);
        if (refreshed) {
          existingByTitle.set(title, refreshed);
        }
      } else {
        const result = await this.memoryService.store({
          title,
          content,
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

      indexedFiles += 1;
    }

    return indexedFiles;
  }

  searchSymbol(name: string): Memory[] {
    const needle = name.trim().toLowerCase();

    return this.repository
      .listMemories({
        type: "project_context",
        limit: 10_000
      })
      .filter((memory) => {
        if (!memory.title.startsWith("Code Index: ")) {
          return false;
        }

        return (
          memory.title.toLowerCase().includes(needle) ||
          memory.content.toLowerCase().includes(needle) ||
          memory.tags.some((tag) => tag.toLowerCase().includes(needle))
        );
      });
  }
}
