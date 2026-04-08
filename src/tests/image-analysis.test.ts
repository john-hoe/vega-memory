import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ImageAnalyzer } from "../core/image-memory.js";

const createTempImage = (): { directory: string; imagePath: string } => {
  const directory = mkdtempSync(join(tmpdir(), "vega-image-analysis-"));
  const imagePath = join(directory, "fixture.png");

  writeFileSync(imagePath, Buffer.from("image-bytes"));

  return {
    directory,
    imagePath
  };
};

test("ImageAnalyzer.extractText returns the OCR stub result", async () => {
  const { directory, imagePath } = createTempImage();
  const analyzer = new ImageAnalyzer({
    ocrEnabled: true,
    analysisEnabled: true
  });

  try {
    const result = await analyzer.extractText(imagePath);

    assert.deepEqual(result, {
      text: "OCR stub: text extraction pending",
      confidence: 0,
      language: "unknown",
      regions: []
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ImageAnalyzer.analyzeImage returns structured stub analysis", async () => {
  const { directory, imagePath } = createTempImage();
  const analyzer = new ImageAnalyzer({
    ocrEnabled: true,
    analysisEnabled: true
  });

  try {
    const result = await analyzer.analyzeImage(imagePath);

    assert.deepEqual(result, {
      description: "Image analysis stub",
      tags: [],
      objects: [],
      colors: [],
      dimensions: {
        width: 0,
        height: 0
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
    analysisEnabled: true
  });

  try {
    const result = await analyzer.generateEmbeddingDescription(imagePath);

    assert.equal(
      result,
      "Image fixture.png. OCR: OCR stub: text extraction pending. Tags: none."
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
      "Image fixture.png. OCR: OCR stub: text extraction pending. Tags: none."
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
