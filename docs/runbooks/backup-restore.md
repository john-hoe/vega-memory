## Backup triggers

Vega supports three backup triggers:
- Manual local execution through the backup runtime.
- MCP tool calls through `backup.create`.
- The self-managed `setInterval` scheduler when `VEGA_BACKUP_SCHEDULER_ENABLED` is not `false`.

## Manifest format + integrity chain

Each backup writes `manifest.json` alongside the copied files. Every file entry records its `relative_path`, `size`, and `sha256`. The top-level `manifest_sha256` is computed from `JSON.stringify(files)` only, so the manifest hash excludes the `manifest_sha256` field itself and avoids a circular hash.

## Restore procedure (full + selective)

1. Identify the backup ID under `~/.vega/backups/<backup_id>/`.
2. Run manifest verification before any write. If verification fails, stop and inspect the mismatches.
3. For a full restore, call `backup.restore` with `mode: "full"`.
4. For a selective restore, call `backup.restore` with `mode: "selective"` and pass `selective.files` with the manifest relative paths to restore.
5. Confirm the restored files and capture the audit row for the operation.

## Restore drill

Use the `backup.restore_drill` MCP tool before a real restore whenever you need a no-write integrity check. The drill verifies every file hash plus `manifest_sha256` and returns mismatches without copying data back into place.

## Audit log

Restore operations append rows to the SQLite `restore_audit` table with backup ID, mode, operator, before/after state hashes, verification status, and mismatches. Query the newest rows with `ORDER BY restored_at DESC, id DESC`. Backup retention pruning only removes backup directories; audit retention is managed separately at the database layer.
