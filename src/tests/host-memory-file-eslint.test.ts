import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

const HOST_MEMORY_FILE_SOURCES = [
  "src/retrieval/sources/host-memory-file.ts",
  "src/retrieval/sources/host-memory-file-fts.ts",
  "src/retrieval/sources/host-memory-file-paths.ts",
  "src/retrieval/sources/host-memory-file-parser.ts"
] as const;

test("ESLint validates the host-memory-file read-only override when eslint is installed", async () => {
  let eslintPath: string;

  try {
    eslintPath = require.resolve("eslint");
  } catch {
    console.warn("Skipping host-memory-file ESLint guard test because eslint is not installed.");
    return;
  }

  const eslintModule = require(eslintPath) as {
    ESLint: new (options?: { cwd?: string }) => {
      lintFiles(files: readonly string[]): Promise<
        Array<{
          errorCount: number;
          warningCount: number;
          fatalErrorCount?: number;
          messages: Array<{ severity: number; ruleId: string | null; message: string }>;
        }>
      >;
    };
  };
  const eslint = new eslintModule.ESLint({ cwd: process.cwd() });
  const results = await eslint.lintFiles([...HOST_MEMORY_FILE_SOURCES]);
  const errors = results.flatMap((result) =>
    result.messages.map((message) => ({
      ruleId: message.ruleId,
      message: message.message,
      severity: message.severity
    }))
  );

  assert.equal(
    results.every(
      (result) =>
        result.errorCount === 0 &&
        result.warningCount === 0 &&
        (result.fatalErrorCount ?? 0) === 0
    ),
    true,
    JSON.stringify(errors, null, 2)
  );
});
