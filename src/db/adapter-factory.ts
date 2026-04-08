import type { VegaConfig } from "../config.js";
import type { DatabaseAdapter } from "./adapter.js";
import { PostgresAdapter } from "./postgres-adapter.js";
import { SQLiteAdapter } from "./sqlite-adapter.js";

export const createAdapter = (config: VegaConfig): DatabaseAdapter => {
  if (config.databaseType === "postgres") {
    return new PostgresAdapter({
      host: config.pgHost,
      port: config.pgPort,
      database: config.pgDatabase,
      user: config.pgUser,
      password: config.pgPassword,
      ssl: config.pgSsl,
      schema: config.pgSchema
    });
  }

  return new SQLiteAdapter(config.dbPath, config.encryptionKey);
};
