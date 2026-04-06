import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { Command } from "commander";

import { MemoryService } from "../../core/memory.js";
import type { AuditContext } from "../../core/types.js";

interface MarkdownSection {
  title: string;
  content: string;
}

const CONTENT_FACTORY_PROJECT = "content-factory";
const CLI_AUDIT_CONTEXT: AuditContext = { actor: "cli", ip: null };

const parseSections = (content: string): MarkdownSection[] => {
  const lines = content.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  let currentTitle: string | null = null;
  let currentContent: string[] = [];

  const pushSection = (): void => {
    if (currentTitle === null) {
      return;
    }

    sections.push({
      title: currentTitle,
      content: currentContent.join("\n").trim()
    });
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      pushSection();
      currentTitle = line.slice(3).trim();
      currentContent = [];
      continue;
    }

    if (currentTitle !== null) {
      currentContent.push(line);
    }
  }

  pushSection();

  if (sections.length === 0) {
    throw new Error("No markdown sections found. Expected headings starting with ## ");
  }

  return sections;
};

const inferProject = (title: string, filePath: string): string => {
  const normalizedTitle = title.toLowerCase();
  const normalizedFileName = basename(filePath).toLowerCase();

  if (normalizedTitle.includes(CONTENT_FACTORY_PROJECT)) {
    return CONTENT_FACTORY_PROJECT;
  }

  if (normalizedFileName.includes(CONTENT_FACTORY_PROJECT)) {
    return CONTENT_FACTORY_PROJECT;
  }

  return "global";
};

export function registerMigrateCommand(program: Command, memoryService: MemoryService): void {
  program
    .command("migrate")
    .description("Migrate markdown sections into memories")
    .argument("<file>", "markdown file to import")
    .action(async (file: string) => {
      const inputPath = resolve(file);
      const content = readFileSync(inputPath, "utf8");
      const sections = parseSections(content);

      for (const section of sections) {
        await memoryService.store({
          title: section.title,
          content: section.content,
          type: "pitfall",
          project: inferProject(section.title, inputPath),
          source: "explicit",
          auditContext: CLI_AUDIT_CONTEXT
        });
      }

      console.log(`imported ${sections.length} memories`);
    });
}
