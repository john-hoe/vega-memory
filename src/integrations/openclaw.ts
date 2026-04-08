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
  fetchImpl?: typeof fetch;
}

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

export class OpenClawClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenClawConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async search(
    query: string,
    opts?: { limit?: number; type?: string }
  ): Promise<OpenClawResult[]> {
    if (!this.isConfigured()) {
      console.log("OpenClaw not connected");
      return [];
    }

    const response = await this.fetchImpl(`${normalizeBaseUrl(this.config.apiUrl!)}/search`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        query,
        ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
        ...(opts?.type === undefined ? {} : { type: opts.type })
      })
    });

    if (!response.ok) {
      return [];
    }

    const body = (await response.json()) as { results?: OpenClawResult[] };
    return body.results ?? [];
  }

  async getDocument(id: string): Promise<OpenClawDocument | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await this.fetchImpl(`${normalizeBaseUrl(this.config.apiUrl!)}/documents/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: this.buildHeaders()
    });

    if (!response.ok) {
      return null;
    }

    return ((await response.json()) as { document?: OpenClawDocument }).document ?? null;
  }

  async ingest(
    content: string,
    metadata: Record<string, string>
  ): Promise<{ id: string; status: string }> {
    if (!this.isConfigured()) {
      return {
        id: randomUUID(),
        status: "queued"
      };
    }

    const response = await this.fetchImpl(`${normalizeBaseUrl(this.config.apiUrl!)}/ingest`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        content,
        metadata
      })
    });

    if (!response.ok) {
      throw new Error(`OpenClaw ingest failed with status ${response.status}`);
    }

    const body = (await response.json()) as { id?: string; status?: string };
    return {
      id: body.id ?? randomUUID(),
      status: body.status ?? "queued"
    };
  }

  isConfigured(): boolean {
    return this.config.enabled && this.config.apiUrl !== undefined && this.config.apiKey !== undefined;
  }

  private buildHeaders(): HeadersInit {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.config.apiKey}`
    };
  }
}
