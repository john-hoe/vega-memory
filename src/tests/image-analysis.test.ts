import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ImageAnalyzer } from "../core/image-memory.js";

const createTempImage = (): { directory: string; imagePath: string } => {
  const directory = mkdtempSync(join(tmpdir(), "vega-image-analysis-"));
  const imagePath = join(directory, "fixture.png");

  writeFileSync(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxO8AAAAASUVORK5CYII=",
      "base64"
    )
  );

  return {
    directory,
    imagePath
  };
};

test("ImageAnalyzer.extractText returns OCR output", async () => {
  const { directory, imagePath } = createTempImage();
  const analyzer = new ImageAnalyzer({
    ocrEnabled: true,
    analysisEnabled: true,
    ocrExecutor: async () => ({
      text: "hello image",
      confidence: 0.91,
      language: "eng",
      regions: []
    })
  });

  try {
    const result = await analyzer.extractText(imagePath);

    assert.deepEqual(result, {
      text: "hello image",
      confidence: 0.91,
      language: "eng",
      regions: []
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ImageAnalyzer.analyzeImage returns structured analysis", async () => {
  const { directory, imagePath } = createTempImage();
  const analyzer = new ImageAnalyzer({
    ocrEnabled: true,
    analysisEnabled: true,
    analysisExecutor: async () => ({
      description: "A tiny pixel",
      tags: ["tiny"],
      objects: ["pixel"],
      colors: ["white"],
      dimensions: {
        width: 1,
        height: 1
      }
    })
  });

  try {
    const result = await analyzer.analyzeImage(imagePath);

    assert.deepEqual(result, {
      description: "A tiny pixel",
      tags: ["tiny"],
      objects: ["pixel"],
      colors: ["white"],
      dimensions: {
        width: 1,
        height: 1
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ImageAnalyzer.generateEmbeddingDescription combines OCR text and tags", async () => {
  const { directory, imagePath } = createTempImage();
  const analyzer = new ImageAnalyzer({
    ocrEnabled: true,
    analysisEnabled: true,
    ocrExecutor: async () => ({
      text: "room text",
      confidence: 0.9,
      language: "eng",
      regions: []
    }),
    analysisExecutor: async () => ({
      description: "Room",
      tags: ["indoors", "room"],
      objects: ["desk"],
      colors: ["white"],
      dimensions: {
        width: 1,
        height: 1
      }
    })
  });

  try {
    const result = await analyzer.generateEmbeddingDescription(imagePath);

    assert.equal(
      result,
      "Image fixture.png. OCR: room text. Tags: indoors, room."
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ImageAnalyzer.extractText rejects when the image file does not exist", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vega-image-analysis-missing-"));
  const analyzer = new ImageAnalyzer({
    ocrEnabled: true,
    analysisEnabled: true
  });

  try {
    await assert.rejects(() => analyzer.extractText(join(directory, "missing.png")), {
      code: "ENOENT"
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ImageAnalyzer reports disabled mode while keeping stub output stable", async () => {
  const { directory, imagePath } = createTempImage();
  const analyzer = new ImageAnalyzer({
    ocrEnabled: false,
    analysisEnabled: false
  });

  try {
    assert.equal(analyzer.isAvailable(), false);
    assert.equal(
      await analyzer.generateEmbeddingDescription(imagePath),
      "Image fixture.png. OCR: . Tags: none."
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
