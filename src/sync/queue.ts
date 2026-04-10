import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type PendingOperationType = "store" | "session_end" | "update" | "delete" | "compact";

export interface PendingOperation {
  type: PendingOperationType;
  params: unknown;
  timestamp: string;
  batchFile?: string;
}

const DEFAULT_PENDING_DIR = join(homedir(), ".vega", "pending");

const expandHomePath = (value: string): string => {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }

  return value;
};

const parsePendingOperation = (value: string, batchFile: string): PendingOperation => {
  const parsed = JSON.parse(value) as PendingOperation;

  return {
    ...parsed,
    batchFile
  };
};

export class PendingQueue {
  readonly pendingDir: string;

  constructor(pendingDir = DEFAULT_PENDING_DIR) {
    this.pendingDir = expandHomePath(pendingDir);
    mkdirSync(this.pendingDir, { recursive: true });
  }

  enqueue(operation: PendingOperation): void {
    mkdirSync(this.pendingDir, { recursive: true });

    const fileName = `${operation.timestamp.replace(/[:.]/g, "-")}-${randomUUID()}.jsonl`;
    const filePath = join(this.pendingDir, fileName);

    writeFileSync(filePath, `${JSON.stringify(operation)}\n`, "utf8");
  }

  dequeue(): PendingOperation[] {
    const operations = readdirSync(this.pendingDir)
      .filter((entry) => entry.endsWith(".jsonl"))
      .flatMap((entry) => {
        const batchFile = join(this.pendingDir, entry);
        const content = readFileSync(batchFile, "utf8");

        return content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [parsePendingOperation(line, batchFile)];
            } catch {
              console.warn(
                `[pending-queue] skipping malformed entry: ${line.slice(0, 100)}`
              );
              return [];
            }
          });
      });

    return operations.sort((left, right) => {
      const timestampOrder = Date.parse(left.timestamp) - Date.parse(right.timestamp);

      if (timestampOrder !== 0) {
        return timestampOrder;
      }

      return (left.batchFile ?? "").localeCompare(right.batchFile ?? "");
    });
  }

  clear(): void {
    for (const entry of readdirSync(this.pendingDir)) {
      if (!entry.endsWith(".jsonl")) {
        continue;
      }

      rmSync(join(this.pendingDir, entry), { force: true });
    }
  }

  count(): number {
    return this.dequeue().length;
  }
}
