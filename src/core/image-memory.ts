import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { Memory } from "./types.js";
import { MemoryService } from "./memory.js";
import { Repository } from "../db/repository.js";

const SCREENSHOT_HASH_PREFIX = "image-memory.hash.";

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
    const existingId = this.repository.getMetadata(`${SCREENSHOT_HASH_PREFIX}${hash}`);

    if (existingId) {
      const existingMemory = this.repository.getMemory(existingId);

      if (existingMemory) {
        return existingMemory.id;
      }
    }

    const result = await this.memoryService.store({
      content: `${description}\n[Image: ${absoluteImagePath}]`,
      title: `Screenshot: ${basename(absoluteImagePath)}`,
      type: "project_context",
      project,
      tags: [basename(absoluteImagePath), "screenshot", project],
      source: "explicit"
    });

    this.repository.setMetadata(`${SCREENSHOT_HASH_PREFIX}${hash}`, result.id);

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
