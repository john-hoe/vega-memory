import type { ZodType } from "zod";

import { BUNDLE_SCHEMA } from "./bundle.js";
import { HOST_EVENT_ENVELOPE_TRANSPORT_V1 } from "./envelope.js";

export interface VersionedValidator<T> {
  version: string;
  schema: ZodType<T>;
}

export class VersionedDispatcher<T = unknown> {
  readonly #validators = new Map<string, ZodType<T>>();

  register<U>(entry: VersionedValidator<U>): void {
    this.#validators.set(entry.version, entry.schema as unknown as ZodType<T>);
  }

  dispatch(input: unknown): { version: string; data: unknown } {
    const version = this.#readVersion(input);
    const validator = this.#validators.get(version);

    if (validator === undefined) {
      throw new Error(`Unsupported schema_version: ${version}`);
    }

    return {
      version,
      data: validator.parse(input)
    };
  }

  safeDispatch(
    input: unknown
  ): { success: true; version: string; data: unknown } | { success: false; error: string } {
    try {
      const result = this.dispatch(input);
      return {
        success: true,
        version: result.version,
        data: result.data
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  #readVersion(input: unknown): string {
    if (typeof input !== "object" || input === null || !("schema_version" in input)) {
      throw new Error("Missing schema_version");
    }

    const version = (input as { schema_version: unknown }).schema_version;
    if (typeof version !== "string" || version.length === 0) {
      throw new Error("Invalid schema_version");
    }

    return version;
  }
}

export function createDefaultEnvelopeDispatcher(): VersionedDispatcher {
  const dispatcher = new VersionedDispatcher();
  dispatcher.register({
    version: "1.0",
    schema: HOST_EVENT_ENVELOPE_TRANSPORT_V1
  });
  return dispatcher;
}

export function createDefaultBundleDispatcher(): VersionedDispatcher {
  const dispatcher = new VersionedDispatcher();
  dispatcher.register({
    version: "1.0",
    schema: BUNDLE_SCHEMA
  });
  return dispatcher;
}
