import type { Memory } from "../core/types.js";

export class OpenClawAdapter {
  constructor(
    private readonly _vegaApiUrl: string,
    private readonly _openclawApiUrl: string
  ) {}

  async syncToOpenClaw(_memories: Memory[]): Promise<number> {
    console.log("OpenClaw sync not yet implemented");
    return 0;
  }

  async syncFromOpenClaw(): Promise<Memory[]> {
    return [];
  }
}
