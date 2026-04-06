Task BF-03: Audit Log actor/IP Fix

Read AGENTS.md for rules. Read ALL relevant src/ files before making changes.

## Goal

Replace hard-coded `"system"` actor and `null` IP in audit log entries with real values from the call site (MCP, CLI, HTTP API).

## Overview

Currently every `logAudit` call in `repository.ts` and `memory.ts` passes `actor: "system"` and `ip: null`. This makes the audit log useless for tracking who did what from where. Fix this by threading an `AuditContext` through the system.

## Step 1: Add AuditContext type

File: src/core/types.ts

Add after the `MemoryUpdateParams` interface:

```typescript
export interface AuditContext {
  actor: string;
  ip: string | null;
}
```

## Step 2: Update StoreParams to accept audit context

File: src/core/types.ts

Add optional field to `StoreParams`:

```typescript
export interface StoreParams {
  // ... existing fields ...
  auditContext?: AuditContext;
}
```

Also add to `MemoryUpdateParams` — but as a separate approach: `MemoryService.update` and `MemoryService.delete` should accept an optional `auditContext` parameter directly.

## Step 3: Update Repository to accept actor/ip

File: src/db/repository.ts

Change `createMemory`, `updateMemory`, and `deleteMemory` to accept an optional `auditContext` parameter. Use it in their `logAudit` calls instead of `"system"` / `null`.

In `createMemory`: add parameter `auditContext?: AuditContext` after the existing params. In the logAudit call inside the transaction, use `auditContext?.actor ?? "system"` and `auditContext?.ip ?? null`.

In `updateMemory`: same pattern — add `auditContext?: AuditContext` to the options object (alongside `skipVersion`). Use in logAudit.

In `deleteMemory`: add `auditContext?: AuditContext` parameter. Use in logAudit.

## Step 4: Update MemoryService to thread audit context

File: src/core/memory.ts

In the `store` method: extract `auditContext` from `params` (StoreParams). Pass it to all `repository.createMemory`, `repository.updateMemory`, and `repository.logAudit` calls within the store pipeline (there are logAudit calls at the conflict, merge/update, and create branches).

In the `update` method: add `auditContext?: AuditContext` as a second parameter. Pass to `repository.updateMemory`.

In the `delete` method: add `auditContext?: AuditContext` as a second parameter. Pass to `repository.deleteMemory`.

## Step 5: Pass audit context from MCP server

File: src/mcp/server.ts

When calling `memoryService.store(...)`, add `auditContext: { actor: "mcp", ip: null }` to the params object.

When calling `memoryService.update(...)`, pass `{ actor: "mcp", ip: null }` as the auditContext.

When calling `memoryService.delete(...)`, pass `{ actor: "mcp", ip: null }` as the auditContext.

Do the same for `session_end` which internally calls `memoryService.store` — the ExtractionService or session service may need to forward the context. If session_end calls store internally, the store calls should pick up the auditContext from the params.

## Step 6: Pass audit context from HTTP API

File: src/api/routes.ts

For each route that calls memoryService.store/update/delete, extract the IP from the request and pass audit context:

```typescript
auditContext: { actor: "api", ip: req.ip ?? null }
```

Add to the store, update (PATCH), delete (DELETE), session/end, and compact routes.

## Step 7: Pass audit context from CLI

File: src/cli/commands/store.ts (and other CLI commands that call memoryService)

Pass `auditContext: { actor: "cli", ip: null }` in store params.

Check these CLI command files for memoryService calls and add audit context:
- src/cli/commands/store.ts
- src/cli/commands/session.ts
- src/cli/commands/maintenance.ts (compact)

## Step 8: Write tests

File: src/tests/audit-context.test.ts

Create a new test file:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../db/repository.js";
import { MemoryService } from "../core/memory.js";

// Helper to create test config (copy pattern from existing tests)

test("store from MCP records actor as mcp", async () => {
  // Create repository with :memory:
  // Create MemoryService
  // Call store with auditContext: { actor: "mcp", ip: null }
  // Query audit_log table
  // Assert actor === "mcp" and ip === null
});

test("store from API records actor and IP", async () => {
  // Call store with auditContext: { actor: "api", ip: "192.168.1.10" }
  // Assert actor === "api" and ip === "192.168.1.10"
});

test("store from CLI records actor as cli", async () => {
  // Call store with auditContext: { actor: "cli", ip: null }
  // Assert actor === "cli"
});

test("store without auditContext defaults to system", async () => {
  // Call store without auditContext
  // Assert actor === "system" (backward compatible)
});
```

## Step 9: Build and test

```bash
rm -rf dist && npx tsc
node --test dist/tests/audit-context.test.js
node --test dist/tests/*.test.js
```

All existing tests must still pass. The new tests must pass.

## Step 10: Commit

```bash
git add -A && git commit -m "fix: thread audit context (actor/IP) from MCP, CLI, and HTTP API entry points"
```
