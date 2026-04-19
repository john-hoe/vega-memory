import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { VegaConfig } from "../config.js";
import { normalizeEncryptionKey } from "./encryption.js";

const execFileAsync = promisify(execFile);
const isNodeTestEnvironment = (): boolean =>
  process.execArgv.some((argument) => argument === "--test" || argument.startsWith("--test-"));
let keychainTouchedInProcess = false;

export const VEGA_KEYCHAIN_SERVICE = "dev.vega-memory";
export const VEGA_ENCRYPTION_ACCOUNT = "encryption-key";

interface ExecFileError extends Error {
  code?: number | string;
  stderr?: string;
}

const isMissingKeychainItemError = (error: unknown): boolean => {
  const candidate = error as ExecFileError;
  const stderr = candidate.stderr ?? "";

  return candidate.code === 44 || /could not be found in the keychain/i.test(stderr);
};

export async function getKey(service: string, account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w"
    ]);
    const rawKey = stdout.trim();

    if (rawKey.length === 0) {
      return null;
    }

    const key = normalizeEncryptionKey(rawKey);

    return key.length > 0 ? key : null;
  } catch (error) {
    if (isMissingKeychainItemError(error)) {
      return null;
    }

    throw error;
  }
}

export async function resolveConfiguredEncryptionKey(
  config: Pick<VegaConfig, "encryptionKey">
): Promise<string | undefined> {
  if (config.encryptionKey !== undefined) {
    return normalizeEncryptionKey(config.encryptionKey);
  }

  if (process.platform !== "darwin") {
    return undefined;
  }

  if (isNodeTestEnvironment() && !keychainTouchedInProcess) {
    return undefined;
  }

  return (await getKey(VEGA_KEYCHAIN_SERVICE, VEGA_ENCRYPTION_ACCOUNT)) ?? undefined;
}

export async function requireConfiguredEncryptionKey(
  config: Pick<VegaConfig, "encryptionKey">
): Promise<string> {
  const key = await resolveConfiguredEncryptionKey(config);

  if (key === undefined) {
    throw new Error(
      "Encryption key not configured. Set VEGA_ENCRYPTION_KEY or run `vega init-encryption`."
    );
  }

  return key;
}

export async function setKey(service: string, account: string, key: string): Promise<void> {
  keychainTouchedInProcess = true;
  await execFileAsync("security", [
    "add-generic-password",
    "-s",
    service,
    "-a",
    account,
    "-w",
    normalizeEncryptionKey(key),
    "-U"
  ]);
}

export async function deleteKey(service: string, account: string): Promise<void> {
  keychainTouchedInProcess = true;
  try {
    await execFileAsync("security", [
      "delete-generic-password",
      "-s",
      service,
      "-a",
      account
    ]);
  } catch (error) {
    if (!isMissingKeychainItemError(error)) {
      throw error;
    }
  }
}
