import { randomUUID } from "node:crypto";

export interface OpenClawResult {
  id: string;
  title: string;
  snippet: string;
  score: number;
  source: string;
}

export interface OpenClawDocument {
  id: string;
  title: string;
  content: string;
  metadata: Record<string, string>;
  createdAt: string;
}

export interface OpenClawConfig {
  apiUrl?: string;
  apiKey?: string;
  enabled: boolean;
}

export class OpenClawClient {
  constructor(private readonly config: OpenClawConfig) {}

  async search(
    _query: string,
    _opts?: { limit?: number; type?: string }
  ): Promise<OpenClawResult[]> {
    console.log("OpenClaw not connected");
    return [];
  }

  async getDocument(_id: string): Promise<OpenClawDocument | null> {
    return null;
  }

  async ingest(
    _content: string,
    _metadata: Record<string, string>
  ): Promise<{ id: string; status: string }> {
    return {
      id: randomUUID(),
      status: "queued"
    };
  }

  isConfigured(): boolean {
    return this.config.enabled && this.config.apiUrl !== undefined && this.config.apiKey !== undefined;
  }
}
