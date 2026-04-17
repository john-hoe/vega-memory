import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { MetricsExporter, MetricSample } from "./index.js";

export class FileMetricsExporter implements MetricsExporter {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  emit(sample: MetricSample): void {
    mkdirSync(dirname(this.#filePath), { recursive: true });
    appendFileSync(this.#filePath, `${JSON.stringify(sample)}\n`, "utf8");
  }
}
