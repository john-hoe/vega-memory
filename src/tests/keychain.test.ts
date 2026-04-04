import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { deleteKey, getKey, setKey } from "../security/keychain.js";

test(
  "keychain operations",
  {
    skip: process.platform !== "darwin"
  },
  async () => {
    const service = `dev.vega-memory.test.${randomUUID()}`;
    const account = `account-${randomUUID()}`;
    const value = randomUUID();

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
