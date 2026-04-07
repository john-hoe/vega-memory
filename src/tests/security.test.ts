import assert from "node:assert/strict";
import test from "node:test";

import type { RedactionPattern } from "../core/types.js";
import { redactSensitiveData } from "../security/redactor.js";

test("redactSensitiveData redacts OpenAI API keys", () => {
  const key = "sk-abc123def456ghi789jkl012";
  const result = redactSensitiveData(`OpenAI key: ${key}`);

  assert.equal(result.redacted, "OpenAI key: [REDACTED:API_KEY]");
  assert.equal(result.wasRedacted, true);
});

test("redactSensitiveData redacts AWS access keys", () => {
  const key = "AKIA1234567890ABCDEF";
  const result = redactSensitiveData(`AWS key: ${key}`);

  assert.equal(result.redacted, "AWS key: [REDACTED:AWS_KEY]");
  assert.equal(result.wasRedacted, true);
});

test("redactSensitiveData redacts private key blocks", () => {
  const privateKey = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "abc123",
    "-----END RSA PRIVATE KEY-----"
  ].join("\n");
  const result = redactSensitiveData(privateKey);

  assert.equal(result.redacted, "[REDACTED:PRIVATE_KEY]");
  assert.equal(result.wasRedacted, true);
});

test("redactSensitiveData redacts passwords in URLs", () => {
  const result = redactSensitiveData("postgres://user:pass@host/db");

  assert.equal(
    result.redacted,
    "postgres://user:[REDACTED:PASSWORD]@host/db"
  );
  assert.equal(result.wasRedacted, true);
});

test("redactSensitiveData redacts generic api_key patterns", () => {
  const result = redactSensitiveData("api_key=super-secret-value");

  assert.equal(result.redacted, "api_key=[REDACTED:SECRET]");
  assert.equal(result.wasRedacted, true);
});

test("redactSensitiveData does not redact normal text without secrets", () => {
  const content = "Project summary without credentials.";
  const result = redactSensitiveData(content);

  assert.equal(result.redacted, content);
});

test("redactSensitiveData returns wasRedacted=false for clean content", () => {
  const result = redactSensitiveData("No secrets here.");

  assert.equal(result.wasRedacted, false);
});

test("redactSensitiveData returns wasRedacted=true when redaction occurs", () => {
  const result = redactSensitiveData("token=abc123");

  assert.equal(result.wasRedacted, true);
});

test("redactSensitiveData applies custom patterns with explicit replacements", () => {
  const patterns: RedactionPattern[] = [
    {
      name: "internal token",
      pattern: "/internal-token-[a-z0-9]+/i",
      replacement: "[REDACTED:INTERNAL_TOKEN]"
    }
  ];
  const result = redactSensitiveData("credential internal-token-abc123", patterns);

  assert.equal(result.redacted, "credential [REDACTED:INTERNAL_TOKEN]");
  assert.equal(result.wasRedacted, true);
});

test("redactSensitiveData skips disabled custom patterns", () => {
  const patterns: RedactionPattern[] = [
    {
      name: "disabled secret",
      pattern: "customer-secret-[0-9]+",
      enabled: false
    }
  ];
  const content = "customer-secret-42";
  const result = redactSensitiveData(content, patterns);

  assert.equal(result.redacted, content);
  assert.equal(result.wasRedacted, false);
});

test("redactSensitiveData derives a replacement token from custom pattern names", () => {
  const patterns: RedactionPattern[] = [
    {
      name: "Tenant Secret",
      pattern: "tenant-secret-[a-z0-9]+"
    }
  ];
  const result = redactSensitiveData("tenant-secret-abc123", patterns);

  assert.equal(result.redacted, "[REDACTED:TENANT_SECRET]");
  assert.equal(result.wasRedacted, true);
});
