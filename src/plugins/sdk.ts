import type { VegaConfig } from "../config.js";
import type { MemoryService } from "../core/memory.js";
import type { RecallService } from "../core/recall.js";
import type { Repository } from "../db/repository.js";

export type PluginToolHandler = (input: unknown) => unknown | Promise<unknown>;

export interface PluginTool {
  name: string;
  description: string;
  schema: object;
  handler: PluginToolHandler;
}

export interface PluginContext {
  repository: Repository;
  memoryService: MemoryService;
  recallService: RecallService;
  config: VegaConfig;
  registerTool(name: string, handler: PluginToolHandler): void;
}

export interface VegaPlugin {
  name: string;
  version: string;
  init(context: PluginContext): void | Promise<void>;
}
