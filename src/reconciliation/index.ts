import { z } from "zod";

import {
  DEFAULT_RECONCILIATION_DIMENSIONS,
  RECONCILIATION_DIMENSIONS,
  type ReconciliationDimension,
  type ReconciliationReport
} from "./report.js";
import { ReconciliationOrchestrator } from "./orchestrator.js";

// Known limitations (必须在 commit body 里复述)
//
// 1. **仅 Count dimension 实现**；Shape / Semantic / Ordering 留 `not_implemented` stub，由 11b 填。Derived 延 Wave 6
// 2. **仅 CLI/MCP 按需触发**，未接 scheduler（GitHub #43）
// 3. **未接 NotificationManager**（GitHub #44）
// 4. **SQLite-only**；Postgres path 返回 `degraded: "sqlite_only"`
// 5. **Backup / restore 路径未审视**：当前不知道 restore 是否走 shadow-aware 层；reconciliation 可能把 restore 场景误判为 mismatch。未来需单独审 + 加 restore 通道标记
// 6. **Shadow dual-write 非事务性**：shadow 失败时 main 仍 commit。Count 的 forward miss 正是用来度量这个比率 —— 这不是 bug 而是 by-design；运维需理解 "mismatch > 0" 不一定是 reconciliation 自身的错
// 7. **Event type filter 硬编码为 `decision` / `state_change`**：若未来 shadow-aware-repository 扩展拦截范围，需同步更新 Count dimension 的 event_type filter

interface ReconciliationRunMcpTool {
  name: "reconciliation.run";
  description: string;
  inputSchema: typeof RECONCILIATION_RUN_INPUT_SCHEMA.shape;
  invoke(request: unknown): Promise<ReconciliationReport | { schema_version: "1.0"; degraded: "sqlite_only" }>;
}

const WINDOW_MS = 86_400_000;

const RECONCILIATION_RUN_INPUT_SCHEMA = z.object({
  window_start: z.number().int().optional(),
  window_end: z.number().int().optional(),
  dimensions: z.array(z.enum(RECONCILIATION_DIMENSIONS)).min(1).optional()
});

export function createReconciliationRunMcpTool(
  orchestrator: ReconciliationOrchestrator | undefined,
  options: {
    now?: () => number;
  } = {}
): ReconciliationRunMcpTool {
  const now = options.now ?? Date.now;

  return {
    name: "reconciliation.run",
    description: "Run the SQLite reconciliation pipeline and return a structured reconciliation report.",
    inputSchema: RECONCILIATION_RUN_INPUT_SCHEMA.shape,
    async invoke(request: unknown) {
      const parsed = RECONCILIATION_RUN_INPUT_SCHEMA.parse(request ?? {});
      const windowEnd = parsed.window_end ?? now();
      const windowStart = parsed.window_start ?? (windowEnd - WINDOW_MS);

      if (windowStart >= windowEnd) {
        throw new z.ZodError([
          {
            code: "custom",
            input: request,
            path: ["window_start"],
            message: "window_start must be less than window_end"
          }
        ]);
      }

      if (orchestrator === undefined) {
        return {
          schema_version: "1.0",
          degraded: "sqlite_only"
        };
      }

      return orchestrator.run({
        window_start: windowStart,
        window_end: windowEnd,
        dimensions: parsed.dimensions ?? [...DEFAULT_RECONCILIATION_DIMENSIONS] as ReconciliationDimension[]
      });
    }
  };
}

export * from "./count-dimension.js";
export * from "./findings-store.js";
export * from "./orchestrator.js";
export * from "./report.js";
export * from "./retention.js";
