import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { imageSize } from "image-size";
import { createWorker } from "tesseract.js";

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
  ollamaBaseUrl?: string;
  fetchImpl?: typeof fetch;
  ocrExecutor?: (imagePath: string) => Promise<OcrResult>;
  analysisExecutor?: (imagePath: string) => Promise<ImageAnalysis>;
}

export class ImageAnalyzer {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ImageAnalyzerConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async extractText(imagePath: string): Promise<OcrResult> {
    const absoluteImagePath = await this.resolveExistingImagePath(imagePath);

    if (!this.config.ocrEnabled) {
      return {
        text: "",
        confidence: 0,
        language: "disabled",
        regions: []
      };
    }

    if (this.config.ocrExecutor) {
      return this.config.ocrExecutor(absoluteImagePath);
    }

    const worker = await createWorker("eng");
    try {
      const result = await worker.recognize(absoluteImagePath);
      return {
        text: result.data.text.trim(),
        confidence: result.data.confidence / 100,
        language: "eng",
        regions: []
      };
    } finally {
      await worker.terminate();
    }
  }

  async analyzeImage(imagePath: string): Promise<ImageAnalysis> {
    const absoluteImagePath = await this.resolveExistingImagePath(imagePath);
    const dimensions = imageSize(readFileSync(absoluteImagePath));

    if (!this.config.analysisEnabled) {
      return {
        description: "",
        tags: [],
        objects: [],
        colors: [],
        dimensions: {
          width: dimensions.width ?? 0,
          height: dimensions.height ?? 0
        }
      };
    }

    if (this.config.analysisExecutor) {
      return this.config.analysisExecutor(absoluteImagePath);
    }

    if (!this.config.ollamaModel || !this.config.ollamaBaseUrl) {
      return {
        description: `Image ${basename(absoluteImagePath)}`,
        tags: [],
        objects: [],
        colors: [],
        dimensions: {
          width: dimensions.width ?? 0,
          height: dimensions.height ?? 0
        }
      };
    }

    const response = await this.fetchImpl(
      `${this.config.ollamaBaseUrl.replace(/\/+$/, "")}/api/chat`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.config.ollamaModel,
          stream: false,
          messages: [
            {
              role: "system",
              content:
                "Return strict JSON with description, tags, objects, colors arrays for the provided image."
            },
            {
              role: "user",
              content: `Analyze this image file: ${absoluteImagePath}`
            }
          ]
        })
      }
    ).catch(() => null);

    if (response === null || !response.ok) {
      return {
        description: `Image ${basename(absoluteImagePath)}`,
        tags: [],
        objects: [],
        colors: [],
        dimensions: {
          width: dimensions.width ?? 0,
          height: dimensions.height ?? 0
        }
      };
    }

    const payload = (await response.json()) as { message?: { content?: string }; response?: string };
    const raw =
      typeof payload.message?.content === "string"
        ? payload.message.content
        : typeof payload.response === "string"
          ? payload.response
          : "{}";
    const parsed = JSON.parse(raw) as Partial<ImageAnalysis>;

    return {
      description: parsed.description ?? `Image ${basename(absoluteImagePath)}`,
      tags: parsed.tags ?? [],
      objects: parsed.objects ?? [],
      colors: parsed.colors ?? [],
      dimensions: {
        width: dimensions.width ?? 0,
        height: dimensions.height ?? 0
      }
    };
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
    private readonly memoryService: MemoryService,
    private readonly analyzer?: ImageAnalyzer
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
    const generatedDescription =
      description.trim().length > 0
        ? description
        : this.analyzer
          ? await this.analyzer.generateEmbeddingDescription(absoluteImagePath)
          : "";
    const content = `${generatedDescription}\n[Image: ${absoluteImagePath}]`;
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
