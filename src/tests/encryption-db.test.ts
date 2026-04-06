import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { generateKey } from "../security/encryption.js";

const now = "2026-04-06T00:00:00.000Z";

const createMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => {
  const { summary = null, ...rest } = overrides;

  return {
    id: "encrypted-memory",
    tenant_id: null,
    type: "decision",
    project: "vega",
    title: "Encrypted Memory",
    content: "Persist this record in an encrypted database.",
    embedding: null,
    importance: 0.8,
    source: "explicit",
    tags: ["encryption"],
    created_at: now,
    updated_at: now,
    accessed_at: now,
    status: "active",
    verified: "unverified",
    scope: "project",
    accessed_projects: ["vega"],
    ...rest,
    summary
  };
};

test("Repository opens encrypted database and reads/writes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-enc-db-"));
  const dbPath = join(tempDir, "memory.db");
  const key = generateKey();

  try {
    const repository = new Repository(dbPath, key);
    repository.createMemory(createMemory());
    assert.equal(repository.listMemories({ limit: 10 }).length, 1);
    repository.close();

    const rawContents = readFileSync(dbPath);
    assert.equal(rawContents.includes(Buffer.from("SQLite format 3", "utf8")), false);

    const reopened = new Repository(dbPath, key);
    const memories = reopened.listMemories({ limit: 10 });
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.id, "encrypted-memory");
    reopened.close();

    assert.throws(() => new Repository(dbPath), /not a database|encrypted|key/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Repository fails to open encrypted database when key is missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-enc-db-missing-key-"));
  const dbPath = join(tempDir, "memory.db");
  const key = generateKey();

  try {
    const repository = new Repository(dbPath, key);
    repository.createMemory(
      createMemory({
        id: "encrypted-memory-missing-key"
      })
    );
    repository.close();

    assert.throws(() => new Repository(dbPath), /not a database|encrypted|key/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Repository works without encryption key (backward compatible)", () => {
  const repository = new Repository(":memory:");

  try {
    assert.deepEqual(repository.listMemories({ limit: 10 }), []);
  } finally {
    repository.close();
  }
});
