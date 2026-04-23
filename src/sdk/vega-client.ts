import type { HostEventEnvelopeTransportV1 } from "../core/contracts/envelope.js";
import type { IntentRequest } from "../core/contracts/intent.js";
import type { UsageAck } from "../core/contracts/usage-ack.js";
import type { UsageCheckpoint } from "../core/contracts/usage-checkpoint.js";
import type { UsageFallbackRequest, UsageFallbackResponse } from "../core/contracts/usage-fallback.js";
import type { FeedbackUsageAck, FeedbackUsageAckResponse } from "../feedback/usage-ack-handler.js";
import type { IngestEventResponse } from "../ingestion/ingest-event-handler.js";
import type { ContextResolveResponse } from "../retrieval/orchestrator.js";
import type { UsageAckResponse } from "../usage/usage-ack-handler.js";
import type { UsageCheckpointResponse } from "../usage/usage-checkpoint-handler.js";

export type IngestEventRequest = HostEventEnvelopeTransportV1;
export type ContextResolveRequest = IntentRequest;
export type UsageAckRequest = UsageAck | FeedbackUsageAck;
export type UsageAckResult = UsageAckResponse | FeedbackUsageAckResponse;
export type UsageCheckpointRequest = UsageCheckpoint;
export type UsageFallbackRequestType = UsageFallbackRequest;
export type UsageFallbackResponseType = UsageFallbackResponse;

export interface VegaClientOptions {
  baseUrl: string;
  apiKey?: string;
}

export class VegaClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly detail?: string,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "VegaClientError";
  }
}

export class VegaClient {
  readonly #baseUrl: string;
  readonly #apiKey?: string;

  constructor(options: VegaClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
  }

  ingestEvent(payload: IngestEventRequest): Promise<IngestEventResponse> {
    return this.#request("ingest_event", payload);
  }

  contextResolve(payload: ContextResolveRequest): Promise<ContextResolveResponse> {
    return this.#request("context_resolve", payload);
  }

  usageAck(payload: UsageAckRequest): Promise<UsageAckResult> {
    return this.#request("usage_ack", payload);
  }

  usageCheckpoint(payload: UsageCheckpointRequest): Promise<UsageCheckpointResponse> {
    return this.#request("usage_checkpoint", payload);
  }

  usageFallback(payload: UsageFallbackRequestType): Promise<UsageFallbackResponseType> {
    return this.#request("usage_fallback", payload);
  }

  async #request<T>(path: string, payload: unknown): Promise<T> {
    let lastError: VegaClientError | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await globalThis.fetch(`${this.#baseUrl}/${path}`, {
          method: "POST",
          headers: this.#headers(),
          body: JSON.stringify(payload)
        });
        const body = await this.#readBody(response);
        if (response.ok) {
          return body as T;
        }
        const error = this.#httpError(response, body);
        if (response.status < 500) {
          throw error;
        }
        lastError = error;
      } catch (error) {
        if (error instanceof VegaClientError) {
          if (error.status !== undefined && error.status < 500) {
            throw error;
          }
          lastError = error;
        } else {
          lastError = new VegaClientError(
            error instanceof Error ? error.message : "Network request failed"
          );
        }
      }
    }
    throw lastError ?? new VegaClientError("Request failed");
  }

  #headers(): Headers {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.#apiKey) {
      headers.set("authorization", `Bearer ${this.#apiKey}`);
    }
    return headers;
  }

  async #readBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("application/json") ? response.json() : response.text();
  }

  #httpError(response: Response, body: unknown): VegaClientError {
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const code = typeof record.error === "string" ? record.error : undefined;
    const detail = typeof record.detail === "string" ? record.detail : undefined;
    const message = detail ?? code ?? response.statusText ?? `HTTP ${response.status}`;
    return new VegaClientError(`Vega request failed (${response.status}): ${message}`, response.status, code, detail, body);
  }
}
