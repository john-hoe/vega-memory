import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import { expandHomePath } from "../config.js";
import type { MemorySourceContext } from "./types.js";

export interface DeviceIdentity {
  device_id: string;
  device_name: string;
  platform: string;
}

let cachedDeviceIdentity: DeviceIdentity | null = null;
let warnedDeviceIdentityPersistenceFailure = false;

const resolveVegaHome = (): string =>
  expandHomePath(process.env.VEGA_HOME?.trim() || "~/.vega");

const getDeviceIdentityPath = (): string => join(resolveVegaHome(), "device.json");

const isDeviceIdentity = (value: unknown): value is DeviceIdentity =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>).device_id === "string" &&
  typeof (value as Record<string, unknown>).device_name === "string" &&
  typeof (value as Record<string, unknown>).platform === "string";

const createDeviceIdentity = (): DeviceIdentity => ({
  device_id: randomUUID(),
  device_name: hostname(),
  platform: process.platform
});

const createFallbackDeviceIdentity = (): DeviceIdentity => {
  const hash = createHash("sha256")
    .update(hostname())
    .update("\u0000")
    .update(process.platform)
    .update("\u0000")
    .update(homedir())
    .digest("hex");

  return {
    device_id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    device_name: hostname(),
    platform: process.platform
  };
};

const warnDeviceIdentityPersistenceFailure = (path: string, error: unknown): void => {
  if (warnedDeviceIdentityPersistenceFailure) {
    return;
  }

  warnedDeviceIdentityPersistenceFailure = true;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[device-identity] failed to persist device identity at ${path}: ${message}. Using deterministic fallback identity.`
  );
};

const persistDeviceIdentity = (identity: DeviceIdentity): boolean => {
  try {
    const path = getDeviceIdentityPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
    return true;
  } catch (error) {
    warnDeviceIdentityPersistenceFailure(getDeviceIdentityPath(), error);
    return false;
  }
};

export const getDeviceIdentity = (): DeviceIdentity => {
  if (cachedDeviceIdentity !== null) {
    return cachedDeviceIdentity;
  }

  try {
    const parsed = JSON.parse(readFileSync(getDeviceIdentityPath(), "utf8")) as unknown;

    if (isDeviceIdentity(parsed)) {
      cachedDeviceIdentity = parsed;
      return parsed;
    }
  } catch {}

  const identity = createDeviceIdentity();
  if (persistDeviceIdentity(identity)) {
    cachedDeviceIdentity = identity;
    return identity;
  }

  const fallbackIdentity = createFallbackDeviceIdentity();
  cachedDeviceIdentity = fallbackIdentity;
  return fallbackIdentity;
};

export const buildSourceContext = (
  actor: string,
  channel: string,
  extras?: Pick<MemorySourceContext, "client_info" | "session_id">
): MemorySourceContext => ({
  actor,
  channel,
  ...getDeviceIdentity(),
  ...(extras?.session_id === undefined ? {} : { session_id: extras.session_id }),
  ...(extras?.client_info === undefined ? {} : { client_info: extras.client_info })
});

export const resetDeviceIdentityCacheForTests = (): void => {
  cachedDeviceIdentity = null;
  warnedDeviceIdentityPersistenceFailure = false;
};
