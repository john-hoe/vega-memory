Task 26-31: Phase 3 — Security + Lifecycle (all 6 tasks).

Read AGENTS.md for rules. Read ALL src/ files to understand the current codebase.

## Task 26: SQLCipher Database Encryption
Files: src/db/repository.ts, src/config.ts, package.json
Problem: Database file is stored in plaintext.
Fix:
- Install better-sqlite3 with SQLCipher support is complex. Instead, use a simpler approach:
  Add an optional encryption layer using Node.js built-in crypto module.
  Create src/db/encryption.ts:
  - encryptFile(inputPath: string, key: Buffer): void — AES-256-GCM encrypt the db file in-place
  - decryptFile(inputPath: string, key: Buffer): Buffer — decrypt and return content
  - For runtime: we keep using unencrypted SQLite in memory/on-disk normally, but encrypt backups.
  - Add encryptBackup option to config

Actually, simpler and more practical approach:
- Create src/security/encryption.ts with:
  - encryptBuffer(data: Buffer, key: string): Buffer — AES-256-GCM, prepend IV+authTag
  - decryptBuffer(encrypted: Buffer, key: string): Buffer — extract IV+authTag, decrypt
  - generateKey(): string — crypto.randomBytes(32).toString('hex')
- Update src/db/backup.ts: after creating backup, optionally encrypt it if encryption key is configured
- Add to config: encryptionKey?: string (from VEGA_ENCRYPTION_KEY env var)

## Task 27: macOS Keychain Integration
File: src/security/keychain.ts
- getKey(service: string, account: string): Promise<string | null>
  Run: security find-generic-password -s <service> -a <account> -w
  Return stdout or null on error
- setKey(service: string, account: string, key: string): Promise<void>
  Run: security add-generic-password -s <service> -a <account> -w <key> -U
- deleteKey(service: string, account: string): Promise<void>
  Run: security delete-generic-password -s <service> -a <account>

Create CLI command:
  vega init-encryption
  - Check if key exists in Keychain (service: 'dev.vega-memory', account: 'encryption-key')
  - If not: generate key, store in Keychain, print success
  - If yes: print "Encryption key already configured"

## Task 28: Encrypted Export
File: src/cli/commands/import-export.ts
Add --encrypt flag to export command:
  vega export --format json --encrypt -o backup.enc.json
  - Export memories as JSON
  - Encrypt the JSON content using encryption key from Keychain (or VEGA_ENCRYPTION_KEY env)
  - Write encrypted file
  
Add --decrypt flag to import:
  vega import --decrypt backup.enc.json
  - Read file, decrypt using key, parse JSON, import

## Task 29: Graceful Deletion Protocol
File: src/core/lifecycle.ts
Export class LifecycleManager:
  - constructor(repository: Repository, notificationManager: NotificationManager, config: VegaConfig)
  
  - checkPendingDeletions(): GracefulDeletionStatus
    1. Find archived memories where updated_at > 83 days ago
    2. Check if user has run 'vega export --archived' since notification
    3. Return: { pending: Memory[], daysUntilDeletion: number, userAcknowledged: boolean }
  
  - notifyPendingDeletions(memories: Memory[]): Promise<void>
    Send Telegram + write alert: "N memories will be cleaned in 7 days. Run: vega export --archived --before 90d"
  
  - executeDeletion(): { deleted: number, blocked: number }
    1. Find archived > 90 days
    2. Check if export was run (track in metadata table or file)
    3. If exported: delete. If not: extend 3 days (max 2 extensions)
    4. NEVER delete source='explicit' memories
    5. Return counts

  - Add to types.ts: GracefulDeletionStatus type

Integrate into scheduler daily task.

## Task 30: Cross-Project Auto-Promotion
File: src/core/recall.ts
Problem: Memories accessed by >=2 projects should auto-promote from project to global scope.
Fix in recall():
  After updating accessed_projects:
  - If accessed_projects.length >= 2 AND scope === 'project':
    Update scope to 'global' via repository.updateMemory
    Log: "Memory {id} promoted to global scope (accessed by {n} projects)"

## Task 31: Memory Exclusion Rules Enhancement
File: src/security/exclusion.ts
Export function shouldExclude(content: string): { excluded: boolean, reason: string }
Check content against exclusion patterns:
  - Emotional/complaints: /(真垃圾|烦死|fuck|shit|damn|hate this)/i with no actionable content
  - One-time queries: /^(这个|what does|explain|帮我查|什么意思).{0,50}[?？]$/i
  - Raw data dumps: content.length > 2000 AND content has >50% non-alphabetic chars
  - Common knowledge: /(how to|怎么写|for loop|import module)/i AND content.length < 100

Integrate into src/core/memory.ts store():
  Before processing, run shouldExclude(). If excluded, return { id: '', action: 'excluded', title: reason }

## Tests for all tasks:
File: src/tests/security-advanced.test.ts
- Test: encryptBuffer/decryptBuffer roundtrip
- Test: decryptBuffer with wrong key throws
- Test: generateKey returns 64-char hex string
- Test: shouldExclude detects emotional content
- Test: shouldExclude allows normal technical content
- Test: shouldExclude detects raw data dumps
- Test: graceful deletion finds memories > 83 days archived
- Test: graceful deletion never deletes explicit source memories
- Test: cross-project auto-promotion triggers at 2 projects

File: src/tests/keychain.test.ts
- Test: keychain operations (only if on macOS, skip otherwise)

After all:
  npx tsc
  node --test dist/tests/security-advanced.test.js
  node --test dist/tests/*.test.js

Then commit:
  git add -A && git commit -m "feat: Phase 3 — encryption, keychain, encrypted export, graceful deletion, auto-promotion, exclusion rules"
  git push origin main
