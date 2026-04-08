import assert from "node:assert/strict";
import test from "node:test";

import {
  SecurityAuditReport,
  type AuditCheck
} from "../security/audit-report.js";
import { SecurityHardening } from "../security/hardening.js";

test("SecurityHardening generates, validates, encrypts, and decrypts BYOK keys", () => {
  const hardening = new SecurityHardening({
    byokEnabled: true,
    csrfEnabled: true
  });
  const key = hardening.generateByokKey();
  const validation = hardening.validateByokKey(key);
  const encrypted = hardening.encryptWithByok("vega-memory", key);

  assert.deepEqual(validation, {
    valid: true,
    algorithm: "aes-256-gcm",
    keyLength: 32
  });
  assert.equal(
    hardening.decryptWithByok(encrypted.ciphertext, encrypted.iv, encrypted.tag, key),
    "vega-memory"
  );
});

test("SecurityHardening rejects invalid BYOK keys", () => {
  const hardening = new SecurityHardening({
    byokEnabled: true,
    csrfEnabled: false
  });
  const invalidKey = Buffer.alloc(24, 7).toString("base64");

  assert.deepEqual(hardening.validateByokKey(invalidKey), {
    valid: false,
    algorithm: "unknown",
    keyLength: 24
  });
  assert.throws(() => hardening.encryptWithByok("secret", invalidKey), {
    message: "BYOK key must decode to 16 or 32 bytes"
  });
});

test("SecurityHardening returns CORS headers for allowed origins", () => {
  const hardening = new SecurityHardening({
    byokEnabled: false,
    csrfEnabled: false,
    corsOrigins: ["https://app.example.com"]
  });

  assert.deepEqual(hardening.getCorsHeaders("https://app.example.com"), {
    "Access-Control-Allow-Origin": "https://app.example.com",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CSRF-Token",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin"
  });
  assert.deepEqual(hardening.getCorsHeaders("https://evil.example.com"), {});
});

test("SecurityHardening generates and validates CSRF tokens", () => {
  const hardening = new SecurityHardening({
    byokEnabled: false,
    csrfEnabled: true
  });
  const token = hardening.generateCsrfToken();

  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(hardening.validateCsrfToken(token, token), true);
  assert.equal(hardening.validateCsrfToken(token, `${token.slice(0, -1)}0`), false);
});

test("SecurityAuditReport scores fully hardened configs at 100", async () => {
  const report = await new SecurityAuditReport({
    httpsEnforced: true,
    apiKey: "a".repeat(32),
    corsOrigins: ["https://app.example.com"],
    rateLimitEnabled: true,
    csrfEnabled: true,
    dbEncryption: true,
    passwordHashAlgorithm: "argon2id"
  }).generate();

  assert.equal(report.score, 100);
  assert.equal(report.checks.length, 7);
  assert.equal(report.recommendations.length, 0);
  assert.equal(Number.isNaN(Date.parse(report.generatedAt)), false);
});

test("SecurityAuditReport reflects mixed hardening posture in checks and score", async () => {
  const report = await new SecurityAuditReport({
    serverUrl: "http://127.0.0.1:3271",
    apiKey: "short-key",
    corsEnabled: true,
    rateLimiting: { enabled: true },
    csrfEnabled: false,
    dbEncryption: false,
    passwordHashing: true
  }).generate();
  const statuses = Object.fromEntries(report.checks.map((check: AuditCheck) => [check.name, check.status]));

  assert.deepEqual(statuses, {
    "HTTPS enforced": "fail",
    "API key length": "fail",
    "CORS configured": "warn",
    "Rate limiting": "pass",
    "CSRF protection": "fail",
    "Encryption at rest": "fail",
    "Password hashing": "warn"
  });
  assert.equal(report.score, 29);
  assert.equal(report.recommendations.length, 6);
});
