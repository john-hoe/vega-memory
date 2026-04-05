import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { Memory } from "./types.js";
import { MemoryService } from "./memory.js";
import { Repository } from "../db/repository.js";

const SCREENSHOT_HASH_PREFIX = "image-memory.hash.";
const SCREENSHOT_MEMORY_IMPORTANCE = 0.95;

const getMetadataKey = (project: string, hash: string): string =>
  `${SCREENSHOT_HASH_PREFIX}${project}.${hash}`;

export class ImageMemoryService {
  constructor(
    private readonly repository: Repository,
    private readonly memoryService: MemoryService
  ) {}

  async storeScreenshot(
    imagePath: string,
    description: string,
    project: string
  ): Promise<string> {
    const absoluteImagePath = resolve(imagePath);
    const image = readFileSync(absoluteImagePath);
    const hash = createHash("sha256").update(image).digest("hex");
    const metadataKey = getMetadataKey(project, hash);
    const title = `Screenshot: ${basename(absoluteImagePath)}`;
    const content = `${description}\n[Image: ${absoluteImagePath}]`;
    const tags = [basename(absoluteImagePath), "screenshot", project];
    const existingId = this.repository.getMetadata(metadataKey);

    if (existingId) {
      const existingMemory = this.repository.getMemory(existingId);

      if (existingMemory) {
        await this.memoryService.update(existingMemory.id, {
          title,
          content,
          tags,
          importance: SCREENSHOT_MEMORY_IMPORTANCE
        });
        return existingMemory.id;
      }

      this.repository.deleteMetadata(metadataKey);
    }

    const result = await this.memoryService.store({
      content,
      title,
      type: "project_context",
      project,
      tags,
      importance: SCREENSHOT_MEMORY_IMPORTANCE,
      source: "explicit",
      skipSimilarityCheck: true
    });

    this.repository.setMetadata(metadataKey, result.id);

    return result.id;
  }

  listScreenshots(project?: string): Memory[] {
    return this.repository
      .listMemories({
        project,
        type: "project_context",
        limit: 10_000
      })
      .filter((memory) => memory.tags.includes("screenshot"));
  }
}
