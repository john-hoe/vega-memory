import { v4 as uuidv4 } from "uuid";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  level: LogLevel;
  message: string;
  trace_id?: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  withTraceId(traceId: string): Logger;
}

interface LoggerOptions {
  name?: string;
  minLevel?: LogLevel;
  output?: (record: LogRecord) => void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export function createTraceId(): string {
  return uuidv4();
}

class StructuredLogger implements Logger {
  readonly #name?: string;
  readonly #minLevel: LogLevel;
  readonly #output: (record: LogRecord) => void;
  readonly #traceId?: string;

  constructor(options: LoggerOptions = {}, traceId?: string) {
    this.#name = options.name;
    this.#minLevel = options.minLevel ?? "debug";
    this.#output =
      options.output ??
      ((record) => {
        console.log(JSON.stringify(record));
      });
    this.#traceId = traceId;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.#log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.#log("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.#log("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.#log("error", message, context);
  }

  withTraceId(traceId: string): Logger {
    return new StructuredLogger(
      {
        name: this.#name,
        minLevel: this.#minLevel,
        output: this.#output
      },
      traceId
    );
  }

  #log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.#minLevel]) {
      return;
    }

    const record: LogRecord = {
      level,
      message,
      timestamp: new Date().toISOString()
    };
    const recordContext =
      this.#name === undefined ? context : { logger: this.#name, ...(context ?? {}) };

    if (recordContext !== undefined) {
      record.context = recordContext;
    }

    if (this.#traceId !== undefined) {
      record.trace_id = this.#traceId;
    }

    this.#output(record);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(options);
}
