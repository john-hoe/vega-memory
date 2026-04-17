import assert from "node:assert";
import { describe, it } from "node:test";

import { validate as isUuid, version as uuidVersion } from "uuid";

import { createLogger, createTraceId, type LogRecord } from "../core/logging/index.js";

describe("core logging", () => {
  it("createLogger defaults to JSON line output", () => {
    const lines: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (message?: unknown, ...optionalParams: unknown[]) => {
      lines.push([message, ...optionalParams].map((value) => String(value)).join(" "));
    };

    try {
      const logger = createLogger();
      logger.info("hello");
    } finally {
      console.log = originalConsoleLog;
    }

    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0] ?? "{}") as LogRecord;
    assert.equal(record.level, "info");
    assert.equal(record.message, "hello");
    assert.equal(typeof record.timestamp, "string");
  });

  it("withTraceId returns a new logger and only child logs carry the trace id", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      output: (record) => {
        records.push(record);
      }
    });
    const tracedLogger = logger.withTraceId("trace-123");

    tracedLogger.info("child log");
    logger.info("parent log");

    assert.equal(records.length, 2);
    assert.equal(records[0]?.trace_id, "trace-123");
    assert.equal(records[1]?.trace_id, undefined);
  });

  it("minLevel warn drops debug and info records", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      minLevel: "warn",
      output: (record) => {
        records.push(record);
      }
    });

    logger.debug("ignored debug");
    logger.info("ignored info");
    logger.warn("kept warn");
    logger.error("kept error");

    assert.deepEqual(
      records.map((record) => record.level),
      ["warn", "error"]
    );
  });

  it("createTraceId returns a valid UUID v4", () => {
    const traceId = createTraceId();

    assert.equal(isUuid(traceId), true);
    assert.equal(uuidVersion(traceId), 4);
  });
});
