import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import {
  deleteKey,
  getKey,
  resolveConfiguredEncryptionKey,
  setKey
} from "../security/keychain.js";

test(
  "keychain operations",
  {
    skip: process.platform !== "darwin"
  },
  async () => {
    const service = `dev.vega-memory.test.${randomUUID()}`;
    const account = `account-${randomUUID()}`;
    const value = randomBytes(32).toString("hex");

    try {
      assert.equal(await getKey(service, account), null);

      await setKey(service, account, value);
      assert.equal(await getKey(service, account), value);

      await deleteKey(service, account);
      assert.equal(await getKey(service, account), null);
    } finally {
      await deleteKey(service, account).catch(() => undefined);
    }
  }
);

test("resolveConfiguredEncryptionKey prefers config key and validates format", async () => {
  assert.equal(
    await resolveConfiguredEncryptionKey({
      encryptionKey: "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789"
    }),
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
  );

  await assert.rejects(
    () =>
      resolveConfiguredEncryptionKey({
        encryptionKey: "invalid-key"
      }),
    /64-character hex string/
  );
});

test("setKey rejects invalid encryption keys before touching the keychain", async () => {
  await assert.rejects(
    () => setKey(`dev.vega-memory.test.${randomUUID()}`, `account-${randomUUID()}`, "invalid-key"),
    /64-character hex string/
  );
});
