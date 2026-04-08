import { createServer, type Server, type Socket } from "node:net";

interface Entry {
  value: string;
  expiresAt?: number;
}

function encodeSimpleString(value: string): string {
  return `+${value}\r\n`;
}

function encodeBulkString(value: string | null): string {
  if (value === null) {
    return "$-1\r\n";
  }

  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function encodeInteger(value: number): string {
  return `:${value}\r\n`;
}

function encodeError(value: string): string {
  return `-${value}\r\n`;
}

function encodeArray(values: string[]): string {
  return `*${values.length}\r\n${values.map((value) => encodeBulkString(value)).join("")}`;
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

function readLine(
  buffer: Buffer,
  offset: number
): { value: string; nextOffset: number } | null {
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd === -1) {
    return null;
  }

  return {
    value: buffer.toString("utf8", offset, lineEnd),
    nextOffset: lineEnd + 2
  };
}

function parseCommand(buffer: Buffer): { command: string[]; consumed: number } | null {
  if (buffer.length === 0 || buffer[0] !== 42) {
    return null;
  }

  const header = readLine(buffer, 1);
  if (header === null) {
    return null;
  }

  const itemCount = parseInteger(header.value);
  const command: string[] = [];
  let offset = header.nextOffset;

  for (let index = 0; index < itemCount; index += 1) {
    if (offset >= buffer.length || buffer[offset] !== 36) {
      return null;
    }

    const lengthLine = readLine(buffer, offset + 1);
    if (lengthLine === null) {
      return null;
    }

    const length = parseInteger(lengthLine.value);
    const start = lengthLine.nextOffset;
    const end = start + length;

    if (buffer.length < end + 2) {
      return null;
    }

    command.push(buffer.toString("utf8", start, end));
    offset = end + 2;
  }

  return {
    command,
    consumed: offset
  };
}

function createPatternMatcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}

export interface MockRedisServer {
  port: number;
  close(): Promise<void>;
}

export async function startMockRedisServer(): Promise<MockRedisServer> {
  const server = createServer();
  const store = new Map<string, Entry>();
  const buffers = new WeakMap<Socket, Buffer>();
  const sockets = new Set<Socket>();

  const cleanupExpired = (key: string): void => {
    const entry = store.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      store.delete(key);
    }
  };

  const handleCommand = (socket: Socket, command: string[]): void => {
    const [rawName, ...args] = command;
    const name = rawName?.toUpperCase() ?? "";

    if (name === "AUTH" || name === "SELECT") {
      socket.write(encodeSimpleString("OK"));
      return;
    }

    if (name === "GET") {
      const key = args[0] ?? "";
      cleanupExpired(key);
      socket.write(encodeBulkString(store.get(key)?.value ?? null));
      return;
    }

    if (name === "SET") {
      const key = args[0] ?? "";
      const value = args[1] ?? "";
      const expiresIndex = args.findIndex((arg) => arg.toUpperCase() === "EX");
      const expiresAt =
        expiresIndex >= 0 && args[expiresIndex + 1] !== undefined
          ? Date.now() + parseInteger(args[expiresIndex + 1]) * 1000
          : undefined;

      store.set(key, {
        value,
        ...(expiresAt === undefined ? {} : { expiresAt })
      });
      socket.write(encodeSimpleString("OK"));
      return;
    }

    if (name === "DEL") {
      let deleted = 0;
      for (const key of args) {
        deleted += store.delete(key) ? 1 : 0;
      }
      socket.write(encodeInteger(deleted));
      return;
    }

    if (name === "EXISTS") {
      const key = args[0] ?? "";
      cleanupExpired(key);
      socket.write(encodeInteger(store.has(key) ? 1 : 0));
      return;
    }

    if (name === "KEYS") {
      const pattern = createPatternMatcher(args[0] ?? "*");
      const keys = [...store.keys()].filter((key) => {
        cleanupExpired(key);
        return store.has(key) && pattern.test(key);
      });
      socket.write(encodeArray(keys));
      return;
    }

    if (name === "INCR") {
      const key = args[0] ?? "";
      cleanupExpired(key);
      const current = parseInteger(store.get(key)?.value ?? "0") + 1;
      store.set(key, { value: String(current) });
      socket.write(encodeInteger(current));
      return;
    }

    socket.write(encodeError(`ERR unsupported command ${name}`));
  };

  server.on("connection", (socket) => {
    sockets.add(socket);
    buffers.set(socket, Buffer.alloc(0));
    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.on("data", (chunk) => {
      let buffer = Buffer.concat([buffers.get(socket) ?? Buffer.alloc(0), chunk]);

      while (true) {
        const parsed = parseCommand(buffer);
        if (parsed === null) {
          break;
        }

        handleCommand(socket, parsed.command);
        buffer = buffer.subarray(parsed.consumed);
      }

      buffers.set(socket, buffer);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Mock Redis server failed to bind");
  }

  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}
