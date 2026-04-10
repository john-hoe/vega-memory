import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  type KeyObject,
  sign as signJwtPart
} from "node:crypto";
import test from "node:test";

import { verifyIdToken } from "../api/oidc.js";

const encodeBase64Url = (value: string | Buffer): string =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");

const createSignedJwt = (
  privateKey: KeyObject,
  kid: string,
  claims: Record<string, unknown>
): string => {
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = encodeBase64Url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = signJwtPart("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKey);

  return `${signingInput}.${encodeBase64Url(signature)}`;
};

const withFetchMock = async (
  handler: typeof fetch,
  callback: () => Promise<void>
): Promise<void> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;

  try {
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const createVerificationHarness = () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  const kid = `kid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const jwk = {
    ...((publicKey.export({ format: "jwk" }) as JsonWebKey) ?? {}),
    kid,
    alg: "RS256",
    use: "sig"
  };
  const issuer = `https://issuer.example.com/${kid}`;
  const jwksUri = `${issuer}/.well-known/jwks.json`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  return {
    issuer,
    jwksUri,
    kid,
    nowSeconds,
    privateKey,
    jwk
  };
};

test("rejects expired ID token", async () => {
  const harness = createVerificationHarness();
  const claims = {
    iss: harness.issuer,
    aud: "vega-client",
    sub: "user-1",
    email: "alice@example.com",
    exp: harness.nowSeconds - 120,
    iat: harness.nowSeconds - 180,
    nonce: "nonce-1"
  };
  const token = createSignedJwt(harness.privateKey, harness.kid, claims);

  await withFetchMock(
    (async (input) => {
      if (String(input) === harness.jwksUri) {
        return new Response(JSON.stringify({ keys: [harness.jwk] }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      throw new Error(`Unexpected fetch call: ${String(input)}`);
    }) as typeof fetch,
    async () => {
      await assert.rejects(
        verifyIdToken(token, {
          issuer: harness.issuer,
          audience: "vega-client",
          jwksUri: harness.jwksUri,
          nonce: "nonce-1"
        }),
        /expired/
      );
    }
  );
});

test("rejects wrong audience", async () => {
  const harness = createVerificationHarness();
  const token = createSignedJwt(harness.privateKey, harness.kid, {
    iss: harness.issuer,
    aud: "other-client",
    sub: "user-1",
    email: "alice@example.com",
    exp: harness.nowSeconds + 300,
    iat: harness.nowSeconds - 30,
    nonce: "nonce-2"
  });

  await withFetchMock(
    (async (input) => {
      if (String(input) === harness.jwksUri) {
        return new Response(JSON.stringify({ keys: [harness.jwk] }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      throw new Error(`Unexpected fetch call: ${String(input)}`);
    }) as typeof fetch,
    async () => {
      await assert.rejects(
        verifyIdToken(token, {
          issuer: harness.issuer,
          audience: "vega-client",
          jwksUri: harness.jwksUri,
          nonce: "nonce-2"
        }),
        /audience/
      );
    }
  );
});

test("rejects wrong issuer", async () => {
  const harness = createVerificationHarness();
  const token = createSignedJwt(harness.privateKey, harness.kid, {
    iss: "https://wrong-issuer.example.com",
    aud: "vega-client",
    sub: "user-1",
    email: "alice@example.com",
    exp: harness.nowSeconds + 300,
    iat: harness.nowSeconds - 30,
    nonce: "nonce-3"
  });

  await withFetchMock(
    (async (input) => {
      if (String(input) === harness.jwksUri) {
        return new Response(JSON.stringify({ keys: [harness.jwk] }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      throw new Error(`Unexpected fetch call: ${String(input)}`);
    }) as typeof fetch,
    async () => {
      await assert.rejects(
        verifyIdToken(token, {
          issuer: harness.issuer,
          audience: "vega-client",
          jwksUri: harness.jwksUri,
          nonce: "nonce-3"
        }),
        /issuer/
      );
    }
  );
});

test("accepts valid ID token", async () => {
  const harness = createVerificationHarness();
  const claims = {
    iss: harness.issuer,
    aud: ["vega-client", "other-audience"],
    sub: "user-1",
    email: "alice@example.com",
    name: "Alice",
    exp: harness.nowSeconds + 300,
    iat: harness.nowSeconds - 30,
    nonce: "nonce-4"
  };
  const token = createSignedJwt(harness.privateKey, harness.kid, claims);

  await withFetchMock(
    (async (input) => {
      if (String(input) === harness.jwksUri) {
        return new Response(JSON.stringify({ keys: [harness.jwk] }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      throw new Error(`Unexpected fetch call: ${String(input)}`);
    }) as typeof fetch,
    async () => {
      const verified = await verifyIdToken(token, {
        issuer: harness.issuer,
        audience: "vega-client",
        jwksUri: harness.jwksUri,
        nonce: "nonce-4"
      });

      assert.equal(verified.sub, "user-1");
      assert.equal(verified.email, "alice@example.com");
      assert.equal(verified.name, "Alice");
    }
  );
});
