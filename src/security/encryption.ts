import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const AUTH_TAG_BYTES = 16;
const IV_BYTES = 12;
export const KEY_HEX_PATTERN = /^[0-9a-f]{64}$/i;

export function normalizeEncryptionKey(key: string): string {
  const normalized = key.trim();

  if (!KEY_HEX_PATTERN.test(normalized)) {
    throw new Error("Encryption key must be a 64-character hex string");
  }

  return normalized.toLowerCase();
}

const parseKey = (key: string): Buffer => Buffer.from(normalizeEncryptionKey(key), "hex");

export function encryptBuffer(data: Buffer, key: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", parseKey(key), iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]);
}

export function decryptBuffer(encrypted: Buffer, key: string): Buffer {
  if (encrypted.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error("Encrypted payload is too short");
  }

  const iv = encrypted.subarray(0, IV_BYTES);
  const authTag = encrypted.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = encrypted.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", parseKey(key), iv);

  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function generateKey(): string {
  return randomBytes(32).toString("hex");
}
