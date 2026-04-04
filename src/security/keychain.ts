import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const VEGA_KEYCHAIN_SERVICE = "dev.vega-memory";
export const VEGA_ENCRYPTION_ACCOUNT = "encryption-key";

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
    const key = stdout.trim();

    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export async function setKey(service: string, account: string, key: string): Promise<void> {
  await execFileAsync("security", [
    "add-generic-password",
    "-s",
    service,
    "-a",
    account,
    "-w",
    key,
    "-U"
  ]);
}

export async function deleteKey(service: string, account: string): Promise<void> {
  await execFileAsync("security", [
    "delete-generic-password",
    "-s",
    service,
    "-a",
    account
  ]);
}
