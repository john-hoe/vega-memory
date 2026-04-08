import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { Memory } from "./types.js";
import { MemoryService } from "./memory.js";
import { Repository } from "../db/repository.js";

const SCREENSHOT_HASH_PREFIX = "image-memory.hash.";
const SCREENSHOT_MEMORY_IMPORTANCE = 0.95;

const getMetadataKey = (project: string, hash: string): string =>
  `${SCREENSHOT_HASH_PREFIX}${project}.${hash}`;

export interface OcrResult {
  text: string;
  confidence: number;
  language: string;
  regions: Array<{
    text: string;
    bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
}

export interface ImageAnalysis {
  description: string;
  tags: string[];
  objects: string[];
  colors: string[];
  dimensions: {
    width: number;
    height: number;
  };
}

interface ImageAnalyzerConfig {
  ocrEnabled: boolean;
  analysisEnabled: boolean;
  ollamaModel?: string;
}

const createStubOcrResult = (): OcrResult => ({
  text: "OCR stub: text extraction pending",
  confidence: 0,
  language: "unknown",
  regions: []
});

const createStubImageAnalysis = (): ImageAnalysis => ({
  description: "Image analysis stub",
  tags: [],
  objects: [],
  colors: [],
  dimensions: {
    width: 0,
    height: 0
  }
});

export class ImageAnalyzer {
  constructor(private readonly config: ImageAnalyzerConfig) {}

  async extractText(imagePath: string): Promise<OcrResult> {
    await this.resolveExistingImagePath(imagePath);
    return createStubOcrResult();
  }

  async analyzeImage(imagePath: string): Promise<ImageAnalysis> {
    await this.resolveExistingImagePath(imagePath);
    return createStubImageAnalysis();
  }

  async generateEmbeddingDescription(imagePath: string): Promise<string> {
    const absoluteImagePath = await this.resolveExistingImagePath(imagePath);
    const [ocrResult, imageAnalysis] = await Promise.all([
      this.extractText(absoluteImagePath),
      this.analyzeImage(absoluteImagePath)
    ]);
    const tags = imageAnalysis.tags.length > 0 ? imageAnalysis.tags.join(", ") : "none";

    return `Image ${basename(absoluteImagePath)}. OCR: ${ocrResult.text}. Tags: ${tags}.`;
  }

  isAvailable(): boolean {
    return this.config.ocrEnabled || this.config.analysisEnabled;
  }

  private async resolveExistingImagePath(imagePath: string): Promise<string> {
    const absoluteImagePath = resolve(imagePath);
    await access(absoluteImagePath);
    return absoluteImagePath;
  }
}

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
