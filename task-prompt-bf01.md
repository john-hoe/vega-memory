Task BF-01: SQLCipher Full Database Encryption

Read AGENTS.md for rules. Read ALL relevant src/ files before making changes.

## Goal

Replace `better-sqlite3` with `better-sqlite3-multiple-ciphers` to enable full database encryption via SQLCipher. The encrypted DB file is unreadable without the key.

## Important: Backward Compatibility

Encryption is OFF by default. Existing users are not affected unless they explicitly enable it with `vega init-encryption`. All existing tests must pass without encryption enabled.

## Step 1: Replace dependency

```bash
npm uninstall better-sqlite3
npm install better-sqlite3-multiple-ciphers
```

Do NOT uninstall `@types/better-sqlite3` — keep it for type definitions (the APIs are compatible).

## Step 2: Update imports in repository.ts

File: src/db/repository.ts

Change the import:

```typescript
// Before:
import BetterSqlite3 from "better-sqlite3";

// After:
import BetterSqlite3 from "better-sqlite3-multiple-ciphers";
```

## Step 3: Update imports in schema.ts

File: src/db/schema.ts

Change the import:

```typescript
// Before:
import type Database from "better-sqlite3";

// After:
import type Database from "better-sqlite3-multiple-ciphers";
```

## Step 4: Update imports in all other files that import better-sqlite3

Search for `from "better-sqlite3"` across all .ts files in src/ and change to `from "better-sqlite3-multiple-ciphers"`. Common locations:
- src/db/shard.ts
- src/db/crdt.ts
- src/sync/client.ts (if it imports Database type)

Also update any test files that import better-sqlite3 directly.

## Step 5: Add dbEncryption config

File: src/config.ts

Add to VegaConfig interface:
```typescript
dbEncryption: boolean;
```

In loadConfig(), read from environment:
```typescript
const dbEncryption = process.env.VEGA_DB_ENCRYPTION === "true";
```

Default to `false`. Include in the returned config object.

Also read it from the file config if present (loadFileConfig).

## Step 6: Update Repository constructor for encryption

File: src/db/repository.ts

The constructor currently does:
```typescript
constructor(dbPath: string) {
  // mkdir...
  this.db = new BetterSqlite3(dbPath);
  initializeDatabase(this.db);
}
```

Change the constructor to accept an optional encryption key:

```typescript
constructor(dbPath: string, encryptionKey?: string) {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  this.db = new BetterSqlite3(dbPath);

  if (encryptionKey) {
    this.db.pragma(`key = "x'${encryptionKey}'"`);
  }

  initializeDatabase(this.db);
}
```

The `PRAGMA key` MUST be the first statement after opening the database, before WAL mode or any other pragma (those are in `initializeDatabase`).

## Step 7: Pass encryption key from entry points

The encryption key comes from macOS Keychain via `resolveConfiguredEncryptionKey(config)` in src/security/keychain.ts. This is already implemented.

Update these entry points to pass the key when creating Repository:

File: src/index.ts (MCP server entry)
- If `config.dbEncryption` is true, resolve the key and pass to `new Repository(config.dbPath, key)`
- If false or no key, pass `new Repository(config.dbPath)` (no change)

File: src/scheduler/index.ts (scheduler entry)
- Same pattern: resolve key if dbEncryption enabled, pass to Repository

File: src/cli/index.ts (CLI entry)
- Same pattern

Note: `resolveConfiguredEncryptionKey` is async (Keychain access). You may need to wrap the initialization in an async IIFE or adjust the startup flow.

## Step 8: Update backup to handle encrypted DB

File: src/db/backup.ts

The `createBackup` function copies the DB file. When the DB is encrypted, the backup file is automatically encrypted too (it's just a file copy). No change needed for the basic backup.

However, the `restoreFromBackup` function should work the same way — the restored file is still encrypted, and the key is in Keychain.

Verify that the existing backup/restore logic works with encrypted databases by checking that it uses file copy (fs.copyFile) rather than SQLite backup API. If it uses the SQLite backup API, the backup DB needs the same key applied.

## Step 9: Update vega init-encryption command

File: src/cli/commands/encryption.ts

The existing command generates a key and stores it in Keychain. Extend it to also:

1. If a memory.db already exists and is unencrypted, migrate it:
   - Open the existing DB without a key
   - Attach a new encrypted DB: `ATTACH DATABASE 'encrypted.db' AS encrypted KEY "x'${key}'"` 
   - Copy all data: `SELECT sqlcipher_export('encrypted')`
   - Detach: `DETACH DATABASE encrypted`
   - Replace: rename encrypted.db to memory.db
2. Set `VEGA_DB_ENCRYPTION=true` in .env file or print instructions to set it
3. Print success message with instructions

If the DB doesn't exist yet, just store the key — encryption will apply when the DB is created.

Note: The `sqlcipher_export` function is specific to SQLCipher. With `better-sqlite3-multiple-ciphers`, the approach may differ. An alternative is:
- Open plain DB, read all data
- Create new encrypted DB with key
- Copy all tables via INSERT ... SELECT or by dumping and restoring

A simpler approach: use the SQLite backup API:
```typescript
const plainDb = new Database(dbPath);
const encDb = new Database(encPath);
encDb.pragma(`key = "x'${key}'"`);
plainDb.backup(encPath); // This might not work with encryption
```

The safest approach:
1. Open plain DB
2. Run: `plainDb.pragma(\`rekey = "x'${key}'"\`)`
   This re-encrypts the database in place. With `better-sqlite3-multiple-ciphers`, `PRAGMA rekey` encrypts an unencrypted database.

Use the `PRAGMA rekey` approach — it's the simplest and works in-place.

## Step 10: Write tests

File: src/tests/encryption-db.test.ts

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Repository } from "../db/repository.js";
import { generateKey } from "../security/encryption.js";

test("Repository opens encrypted database and reads/writes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-enc-"));
  const dbPath = join(tempDir, "encrypted.db");
  const key = generateKey();

  try {
    const repo = new Repository(dbPath, key);
    // Store a memory
    repo.createMemory({ /* minimal memory fields */ });
    const memories = repo.listMemories({ limit: 10 });
    assert.equal(memories.length, 1);
    repo.close();

    // Re-open with same key — should work
    const repo2 = new Repository(dbPath, key);
    const memories2 = repo2.listMemories({ limit: 10 });
    assert.equal(memories2.length, 1);
    repo2.close();

    // Opening without key should fail or return empty/corrupt
    // (better-sqlite3-multiple-ciphers opens but can't read encrypted data)
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Repository works without encryption key (backward compatible)", () => {
  const repo = new Repository(":memory:");
  const memories = repo.listMemories({ limit: 10 });
  assert.equal(memories.length, 0);
  repo.close();
});
```

## Step 11: Update .env.example

File: .env.example

Add:
```
VEGA_DB_ENCRYPTION=false
```

## Step 12: Build and test

```bash
rm -rf dist && npx tsc
node --test dist/tests/encryption-db.test.js
node --test dist/tests/*.test.js
```

All existing tests must still pass (they use `:memory:` without encryption). The new tests must pass.

## Step 13: Commit

```bash
git add -A && git commit -m "feat: SQLCipher full database encryption via better-sqlite3-multiple-ciphers"
```
