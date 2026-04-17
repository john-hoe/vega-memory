import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3-multiple-ciphers";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  backfillMemoriesToRawInbox
} from "../ingestion/raw-inbox-backfill.js";
import { applyRawInboxMigration, queryRawInbox } from "../ingestion/raw-inbox.js";

const createMemoriesTable = (db: SQLiteAdapter): void => {
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      tags TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source_context TEXT
    )
  `);
};

test("backfill dry_run maps valid memories without inserting rows", () => {
  const db = new SQLiteAdapter(new Database(":memory:"));

  try {
    createMemoriesTable(db);
    applyRawInboxMigration(db);
    db.run(
      `INSERT INTO memories (id, type, project, title, content, summary, tags, created_at, source_context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "77777777-7777-4777-8777-777777777777",
      "decision",
      "vega-memory",
      "Decision A",
      "Content A",
      "Summary A",
      JSON.stringify(["phase-8"]),
      "2026-04-17T00:00:00.000Z",
      JSON.stringify({ session_id: "session-a" })
    );
    db.run(
      `INSERT INTO memories (id, type, project, title, content, summary, tags, created_at, source_context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "88888888-8888-4888-8888-888888888888",
      "pitfall",
      "vega-memory",
      "Decision B",
      "Content B",
      "Summary B",
      JSON.stringify(["phase-8", "backfill"]),
      "2026-04-17T00:01:00.000Z",
      null
    );

    const result = backfillMemoriesToRawInbox(db, { dry_run: true });

    assert.deepEqual(result, {
      scanned: 2,
      mapped: 2,
      skipped: 0,
      inserted: 0,
      deduped: 0
    });
    assert.equal(queryRawInbox(db).length, 0);
  } finally {
    db.close();
  }
});

test("backfill inserts rows once and reports deduped rows on the second run", () => {
  const db = new SQLiteAdapter(new Database(":memory:"));

  try {
    createMemoriesTable(db);
    applyRawInboxMigration(db);
    db.run(
      `INSERT INTO memories (id, type, project, title, content, summary, tags, created_at, source_context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "99999999-9999-4999-8999-999999999999",
      "decision",
      "vega-memory",
      "Decision C",
      "Content C",
      "Summary C",
      JSON.stringify(["phase-8"]),
      "2026-04-17T00:02:00.000Z",
      JSON.stringify({ session_id: "session-c" })
    );
    db.run(
      `INSERT INTO memories (id, type, project, title, content, summary, tags, created_at, source_context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "insight",
      "vega-memory",
      "Decision D",
      "Content D",
      "Summary D",
      JSON.stringify(["phase-8"]),
      "2026-04-17T00:03:00.000Z",
      JSON.stringify({ session_id: "session-d" })
    );

    const first = backfillMemoriesToRawInbox(db);
    const second = backfillMemoriesToRawInbox(db);

    assert.deepEqual(first, {
      scanned: 2,
      mapped: 2,
      skipped: 0,
      inserted: 2,
      deduped: 0
    });
    assert.deepEqual(second, {
      scanned: 2,
      mapped: 2,
      skipped: 0,
      inserted: 0,
      deduped: 2
    });
    assert.equal(queryRawInbox(db).length, 2);
  } finally {
    db.close();
  }
});

test("backfill skips memories that cannot be mapped into valid envelopes", () => {
  const db = new SQLiteAdapter(new Database(":memory:"));

  try {
    createMemoriesTable(db);
    applyRawInboxMigration(db);
    db.run(
      `INSERT INTO memories (id, type, project, title, content, summary, tags, created_at, source_context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "decision",
      "vega-memory",
      "Broken Memory",
      "Broken Content",
      "Broken Summary",
      JSON.stringify(["phase-8"]),
      "not-an-iso-date",
      null
    );

    const result = backfillMemoriesToRawInbox(db);

    assert.deepEqual(result, {
      scanned: 1,
      mapped: 0,
      skipped: 1,
      inserted: 0,
      deduped: 0
    });
    assert.equal(queryRawInbox(db).length, 0);
  } finally {
    db.close();
  }
});
