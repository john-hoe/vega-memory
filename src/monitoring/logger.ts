type LogLevel = "debug" | "info" | "warn" | "error";
type LogFormat = "json" | "text";
type LoggerMeta = Record<string, unknown>;

interface StructuredLoggerConfig {
  level: LogLevel;
  format: LogFormat;
  service?: string;
}

const levelWeights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const serializeMetaValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
};

export class StructuredLogger {
  constructor(
    private readonly config: StructuredLoggerConfig,
    private readonly boundMeta: LoggerMeta = {}
  ) {}

  debug(message: string, meta?: LoggerMeta): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: LoggerMeta): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: LoggerMeta): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: LoggerMeta): void {
    this.write("error", message, meta);
  }

  child(meta: LoggerMeta): StructuredLogger {
    return new StructuredLogger(this.config, {
      ...this.boundMeta,
      ...meta
    });
  }

  private write(level: LogLevel, message: string, meta?: LoggerMeta): void {
    if (levelWeights[level] < levelWeights[this.config.level]) {
      return;
    }

    const context = {
      ...(this.config.service === undefined ? {} : { service: this.config.service }),
      ...this.boundMeta,
      ...(meta ?? {})
    };
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context
    };

    if (this.config.format === "text") {
      const renderedMeta = Object.entries(context)
        .map(([key, value]) => `${key}=${serializeMetaValue(value)}`)
        .join(" ");

      process.stderr.write(
        `${entry.timestamp} ${entry.level} ${entry.message}${renderedMeta.length > 0 ? ` ${renderedMeta}` : ""}\n`
      );
      return;
    }

    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }
}
