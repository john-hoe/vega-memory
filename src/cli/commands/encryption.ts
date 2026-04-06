import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";
import { Command } from "commander";

import { loadConfig } from "../../config.js";
import { generateKey } from "../../security/encryption.js";
import {
  VEGA_ENCRYPTION_ACCOUNT,
  VEGA_KEYCHAIN_SERVICE,
  getKey,
  setKey
} from "../../security/keychain.js";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");

const isPlainSqliteDatabase = (dbPath: string): boolean => {
  if (!existsSync(dbPath)) {
    return false;
  }

  return readFileSync(dbPath).subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER);
};

const enableDbEncryptionEnv = (): void => {
  const envPath = resolve(process.cwd(), ".env");
  const nextLine = "VEGA_DB_ENCRYPTION=true";
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const updated = /^VEGA_DB_ENCRYPTION=/m.test(current)
    ? current.replace(/^VEGA_DB_ENCRYPTION=.*$/m, nextLine)
    : `${current}${current.length === 0 || current.endsWith("\n") ? "" : "\n"}${nextLine}\n`;

  writeFileSync(envPath, updated, "utf8");
};

export function registerEncryptionCommand(program: Command): void {
  program
    .command("init-encryption")
    .description("Generate and store an encryption key in the macOS Keychain")
    .action(async () => {
      if (process.platform !== "darwin") {
        throw new Error("init-encryption is only supported on macOS");
      }

      const config = loadConfig();
      const existingKey = await getKey(VEGA_KEYCHAIN_SERVICE, VEGA_ENCRYPTION_ACCOUNT);
      const key = existingKey ?? generateKey();

      if (existingKey === null) {
        await setKey(VEGA_KEYCHAIN_SERVICE, VEGA_ENCRYPTION_ACCOUNT, key);
      }

      let migrationMessage = "No database file found. Encryption will apply when the database is created.";

      if (config.dbPath !== ":memory:" && existsSync(config.dbPath)) {
        if (isPlainSqliteDatabase(config.dbPath)) {
          const database = new Database(config.dbPath);

          try {
            database.pragma(`rekey = "x'${key}'"`);
          } finally {
            database.close();
          }

          migrationMessage = `Migrated existing database in place: ${config.dbPath}`;
        } else {
          migrationMessage = `Database is already encrypted: ${config.dbPath}`;
        }
      }

      enableDbEncryptionEnv();
      console.log("Encryption key configured in macOS Keychain.");
      console.log(migrationMessage);
      console.log("Set VEGA_DB_ENCRYPTION=true in your runtime environment before starting Vega.");
    });
}
