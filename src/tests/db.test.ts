import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import Database from "better-sqlite3-multiple-ciphers";

import { cleanOldBackups, createBackup, restoreFromBackup, shouldBackup } from "../db/backup.js";
import { Repository } from "../db/repository.js";
import { initializeDatabase } from "../db/schema.js";
import type { Memory, RawArchive, Session } from "../core/types.js";
import { generateKey } from "../security/encryption.js";

const now = "2026-04-03T12:00:00.000Z";

function createMemory(overrides: Partial<Memory> = {}): Memory {
  const { summary = null, ...rest } = overrides;

  return {
    id: "mem-1",
    tenant_id: null,
    type: "decision",
    project: "vega",
    title: "Choose SQLite",
    content: "SQLite with FTS5 is the persistence layer.",
    embedding: Buffer.from([1, 2, 3]),
    importance: 0.9,
    source: "explicit",
    tags: ["db", "sqlite"],
    created_at: now,
    updated_at: now,
    accessed_at: now,
    access_count: 0,
    status: "active",
    verified: "unverified",
    scope: "project",
    accessed_projects: ["vega"],
    ...rest,
    summary
  };
}

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    project: "vega",
    summary: "Initial planning session",
    started_at: now,
    ended_at: "2026-04-03T13:00:00.000Z",
    memories_created: ["mem-1"],
    ...overrides
  };
}

function createRawArchive(overrides: Partial<RawArchive> = {}): RawArchive {
  return {
    id: "archive-1",
    tenant_id: null,
    project: "vega",
    source_memory_id: null,
    archive_type: "document",
    title: "SQLite backup evidence",
    source_uri: null,
    content: "Full SQLite backup evidence and restore notes.",
    content_hash: "hash-1",
    metadata: {},
    captured_at: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

test("database initialization creates all tables", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-db-init-"));
  const dbPath = join(tempDir, "memory.db");
  const db = new Database(dbPath);

  try {
    initializeDatabase(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name"
      )
      .all()
      .map((row) => (row as { name: string }).name);

    assert.ok(tables.includes("memories"));
    assert.ok(tables.includes("memory_versions"));
    assert.ok(tables.includes("sessions"));
    assert.ok(tables.includes("audit_log"));
    assert.ok(tables.includes("performance_log"));
    assert.ok(tables.includes("metadata"));
    assert.ok(tables.includes("memories_fts"));
    assert.ok(tables.includes("raw_archives"));
    assert.ok(tables.includes("raw_archives_fts"));
    assert.ok(tables.includes("users"));
    assert.ok(tables.includes("fact_claims"));

    const factClaimColumns = db
      .prepare("PRAGMA table_info(fact_claims)")
      .all()
      .map((row) => (row as { name: string }).name);

    assert.ok(factClaimColumns.includes("temporal_precision"));

    const journalMode = db.pragma("journal_mode", { simple: true });
    const foreignKeys = db.pragma("foreign_keys", { simple: true });

    assert.equal(journalMode, "wal");
    assert.equal(foreignKeys, 1);
  } finally {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CRUD operations on memories", () => {
  const repository = new Repository(":memory:");
  const memory = createMemory();

  try {
    repository.createMemory(memory);

    const stored = repository.getMemory(memory.id);
    assert.ok(stored);
    assert.deepEqual(stored, memory);

    repository.updateMemory(memory.id, {
      title: "Choose better-sqlite3",
      content: "better-sqlite3 with FTS5 is the persistence layer.",
      tags: ["db", "sqlite", "fts"],
      accessed_projects: ["vega", "shared"],
      importance: 0.95
    });

    const updated = repository.getMemory(memory.id);
    assert.ok(updated);
    assert.equal(updated.title, "Choose better-sqlite3");
    assert.equal(updated.content, "better-sqlite3 with FTS5 is the persistence layer.");
    assert.deepEqual(updated.tags, ["db", "sqlite", "fts"]);
    assert.deepEqual(updated.accessed_projects, ["vega", "shared"]);
    assert.equal(updated.importance, 0.95);
    assert.equal(updated.access_count, 0);

    repository.deleteMemory(memory.id);

    assert.equal(repository.getMemory(memory.id), null);
  } finally {
    repository.close();
  }
});

test("FTS5 search returns results with rank", () => {
  const repository = new Repository(":memory:");

  try {
    repository.createMemory(
      createMemory({
        id: "mem-fts-1",
        title: "SQLite FTS plan",
        content: "Use FTS5 for fast ranked full text search.",
        tags: ["search", "fts"]
      })
    );
    repository.createMemory(
      createMemory({
        id: "mem-fts-2",
        title: "Telemetry notes",
        content: "Log query latency and result counts.",
        tags: ["metrics"]
      })
    );
    repository.createMemory(
      createMemory({
        id: "mem-fts-archived",
        title: "Archived SQLite FTS plan",
        content: "FTS5 keyword should not recall archived memories.",
        tags: ["search", "fts"],
        status: "archived"
      })
    );

    const results = repository.searchFTS("FTS5 OR ranked", "vega", "decision");

    assert.equal(results.length, 1);
    assert.equal(results[0].memory.id, "mem-fts-1");
    assert.equal(typeof results[0].rank, "number");
  } finally {
    repository.close();
  }
});

test("raw archive repository CRUD and FTS search work", () => {
  const repository = new Repository(":memory:");

  try {
    repository.createRawArchive(
      createRawArchive({
        id: "archive-fts-1",
        content_hash: "hash-fts-1",
        title: "SQLite backup tool log",
        archive_type: "tool_log",
        content: "Tool output with WAL backup evidence."
      })
    );
    repository.createRawArchive(
      createRawArchive({
        id: "archive-fts-2",
        content_hash: "hash-fts-2",
        title: "Redis notes",
        content: "Redis cache invalidation details."
      })
    );

    const stored = repository.getRawArchive("archive-fts-1");
    const byHash = repository.getRawArchiveByHash("hash-fts-1", null);
    const listed = repository.listRawArchives("vega", "tool_log", 10);
    const searched = repository.searchRawArchives("backup", "vega", 10);

    assert.ok(stored);
    assert.equal(stored.archive_type, "tool_log");
    assert.equal(byHash?.id, "archive-fts-1");
    assert.deepEqual(
      listed.map((archive) => archive.id),
      ["archive-fts-1"]
    );
    assert.equal(searched.length, 1);
    assert.equal(searched[0]?.archive.id, "archive-fts-1");
  } finally {
    repository.close();
  }
});

test("getAllEmbeddings excludes archived memories", () => {
  const repository = new Repository(":memory:");

  try {
    repository.createMemory(
      createMemory({
        id: "embedding-active",
        embedding: Buffer.from([1, 2, 3]),
        status: "active"
      })
    );
    repository.createMemory(
      createMemory({
        id: "embedding-archived",
        embedding: Buffer.from([4, 5, 6]),
        status: "archived"
      })
    );

    const embeddings = repository.getAllEmbeddings("vega", "decision");

    assert.deepEqual(
      embeddings.map(({ id }) => id),
      ["embedding-active"]
    );
  } finally {
    repository.close();
  }
});

test("listMemoriesNeedingSummary returns only active long memories with id and content", () => {
  const repository = new Repository(":memory:");

  try {
    repository.createMemory(
      createMemory({
        id: "needs-summary",
        content: "L".repeat(300),
        summary: null,
        status: "active"
      })
    );
    repository.createMemory(
      createMemory({
        id: "has-summary",
        content: "L".repeat(300),
        summary: "already summarized",
        status: "active"
      })
    );
    repository.createMemory(
      createMemory({
        id: "short-content",
        content: "short",
        summary: null,
        status: "active"
      })
    );
    repository.createMemory(
      createMemory({
        id: "archived-content",
        content: "L".repeat(300),
        summary: null,
        status: "archived"
      })
    );

    const memories = repository.listMemoriesNeedingSummary();

    assert.deepEqual(memories, [
      {
        id: "needs-summary",
        content: "L".repeat(300)
      }
    ]);
  } finally {
    repository.close();
  }
});

test("audit log insertion and querying", () => {
  const repository = new Repository(":memory:");
  const memory = createMemory();
  const timestamp = "2026-04-03T14:00:00.000Z";

  try {
    repository.createMemory(memory);
    repository.logAudit({
      timestamp,
      actor: "tester",
      action: "reviewed",
      memory_id: memory.id,
      detail: "Manual review completed",
      ip: "127.0.0.1"
    });

    const auditEntries = repository.getAuditLog({ actor: "tester", action: "reviewed" });

    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0].memory_id, memory.id);
    assert.equal(auditEntries[0].detail, "Manual review completed");
  } finally {
    repository.close();
  }
});

test("version history on update", () => {
  const repository = new Repository(":memory:");
  const memory = createMemory();

  try {
    repository.createMemory(memory);
    repository.updateMemory(memory.id, {
      content: "The updated content should create a version snapshot.",
      importance: 0.5,
      embedding: Buffer.from([9, 9, 9])
    });

    const versions = repository.getVersions(memory.id);

    assert.equal(versions.length, 1);
    assert.equal(versions[0].memory_id, memory.id);
    assert.equal(versions[0].content, memory.content);
    assert.deepEqual(versions[0].embedding, memory.embedding);
    assert.equal(versions[0].importance, memory.importance);
  } finally {
    repository.close();
  }
});

test("session CRUD", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-"));
  const dbPath = join(tempDir, "memory.db");
  const repository = new Repository(dbPath);
  const session = createSession();

  try {
    repository.createSession(session);
    repository.close();

    const db = new Database(dbPath, { readonly: true });
    try {
      const stored = db
        .prepare("SELECT id, project, summary, started_at, ended_at, memories_created FROM sessions WHERE id = ?")
        .get(session.id) as
        | {
            id: string;
            project: string;
            summary: string;
            started_at: string;
            ended_at: string;
            memories_created: string;
          }
        | undefined;

      assert.ok(stored);
      assert.equal(stored.id, session.id);
      assert.equal(stored.project, session.project);
      assert.deepEqual(JSON.parse(stored.memories_created), session.memories_created);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("listMemories with filters", () => {
  const repository = new Repository(":memory:");

  try {
    repository.createMemory(
      createMemory({
        id: "mem-filter-1",
        type: "decision",
        project: "vega",
        title: "Active project memory"
      })
    );
    repository.createMemory(
      createMemory({
        id: "mem-filter-2",
        type: "insight",
        project: "vega",
        title: "Archived project memory",
        status: "archived"
      })
    );
    repository.createMemory(
      createMemory({
        id: "mem-filter-3",
        type: "decision",
        project: "shared",
        title: "Global shared memory",
        scope: "global"
      })
    );

    const byProject = repository.listMemories({ project: "vega", limit: 10, sort: "created_at DESC" });
    const byStatus = repository.listMemories({ status: "archived" });
    const byScope = repository.listMemories({ scope: "global" });
    const byType = repository.listMemories({ type: "decision", project: "vega" });

    assert.equal(byProject.length, 2);
    assert.equal(byStatus.length, 1);
    assert.equal(byStatus[0].id, "mem-filter-2");
    assert.equal(byScope.length, 1);
    assert.equal(byScope[0].id, "mem-filter-3");
    assert.equal(byType.length, 1);
    assert.equal(byType[0].id, "mem-filter-1");
  } finally {
    repository.close();
  }
});

test("backup produces a readable consistent snapshot via SQLite backup API", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-backup-consistent-"));
  const backupDir = join(tempDir, "backups");
  const dbPath = join(tempDir, "memory.db");
  const repository = new Repository(dbPath);

  try {
    repository.createMemory(
      createMemory({
        id: "mem-1",
        title: "First memory",
        content: "Stored before backup."
      })
    );
    repository.createMemory(
      createMemory({
        id: "mem-2",
        title: "Second memory",
        content: "Also stored before backup."
      })
    );

    const backupPath = await createBackup(dbPath, backupDir);

    const backupDb = new Database(backupPath, { readonly: true });
    try {
      const rows = backupDb
        .prepare("SELECT id FROM memories ORDER BY id")
        .all() as Array<{ id: string }>;

      assert.ok(rows.length >= 2);
      assert.ok(rows.some((r) => r.id === "mem-1"));
      assert.ok(rows.some((r) => r.id === "mem-2"));

      const integrity = backupDb.pragma("integrity_check") as Array<{ integrity_check: string }>;
      assert.equal(integrity[0].integrity_check, "ok");
    } finally {
      backupDb.close();
    }
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backup create and restore", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-backup-"));
  const backupDir = join(tempDir, "backups");
  const dbPath = join(tempDir, "memory.db");
  const repository = new Repository(dbPath);
  const memory = createMemory();

  try {
    repository.createMemory(memory);

    const backupPath = await createBackup(dbPath, backupDir);

    const backupFiles = readdirSync(backupDir);
    assert.equal(backupFiles.length, 1);
    assert.match(backupFiles[0], /^memory-\d{4}-\d{2}-\d{2}\.db$/);
    assert.equal(backupPath, join(backupDir, backupFiles[0]));
    assert.equal(shouldBackup(backupDir), false);

    const backupDb = new Database(backupPath, { readonly: true });
    try {
      const stored = backupDb.prepare("SELECT title FROM memories WHERE id = ?").get(memory.id) as
        | { title: string }
        | undefined;

      assert.ok(stored);
      assert.equal(stored.title, memory.title);
    } finally {
      backupDb.close();
    }

    repository.close();
    writeFileSync(dbPath, "corrupted");
    restoreFromBackup(backupDir, dbPath);

    const restoredDb = new Database(dbPath, { readonly: true });
    try {
      const stored = restoredDb.prepare("SELECT title FROM memories WHERE id = ?").get(memory.id) as
        | { title: string }
        | undefined;

      assert.ok(stored);
      assert.equal(stored.title, memory.title);
    } finally {
      restoredDb.close();
    }

    const oldBackupPath = join(backupDir, "memory-1999-01-01.db");
    writeFileSync(oldBackupPath, readFileSync(join(backupDir, backupFiles[0])));
    utimesSync(oldBackupPath, new Date("1999-01-01T00:00:00.000Z"), new Date("1999-01-01T00:00:00.000Z"));
    cleanOldBackups(backupDir, 30);

    assert.equal(existsSync(oldBackupPath), false);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backup create and restore with encryption", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-backup-encrypted-"));
  const backupDir = join(tempDir, "backups");
  const dbPath = join(tempDir, "memory.db");
  const repository = new Repository(dbPath);
  const memory = createMemory({
    id: "mem-encrypted",
    title: "Encrypted backup memory"
  });
  const encryptionKey = generateKey();

  try {
    repository.createMemory(memory);

    const backupPath = await createBackup(dbPath, backupDir, undefined, encryptionKey);
    const encryptedContent = readFileSync(backupPath);

    assert.match(backupPath, /\.db\.enc$/);
    assert.equal(encryptedContent.includes(Buffer.from("SQLite format 3", "utf8")), false);

    repository.close();
    restoreFromBackup(backupDir, dbPath, encryptionKey);

    const restoredDb = new Database(dbPath, { readonly: true });
    try {
      const stored = restoredDb.prepare("SELECT title FROM memories WHERE id = ?").get(memory.id) as
        | { title: string }
        | undefined;

      assert.ok(stored);
      assert.equal(stored.title, memory.title);
    } finally {
      restoredDb.close();
    }
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backup create and restore from encrypted source database", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-backup-encrypted-source-"));
  const backupDir = join(tempDir, "backups");
  const dbPath = join(tempDir, "memory.db");
  const encryptionKey = generateKey();
  const repository = new Repository(dbPath, encryptionKey);
  const memory = createMemory({
    id: "mem-encrypted-source",
    title: "Encrypted source backup memory"
  });

  try {
    repository.createMemory(memory);

    const backupPath = await createBackup(dbPath, backupDir, undefined, encryptionKey);
    const encryptedBackup = new Database(backupPath, { readonly: true });
    encryptedBackup.pragma(`key = "x'${encryptionKey}'"`);

    try {
      const stored = encryptedBackup.prepare("SELECT title FROM memories WHERE id = ?").get(memory.id) as
        | { title: string }
        | undefined;

      assert.ok(stored);
      assert.equal(stored.title, memory.title);
    } finally {
      encryptedBackup.close();
    }
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
