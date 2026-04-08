import BetterSqlite3 from "better-sqlite3-multiple-ciphers";

type SqliteMasterRow = {
  name: string;
  type: "table" | "index";
  sql: string | null;
  tbl_name: string;
};

type TableInfoRow = {
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
};

type IndexInfoRow = {
  name: string;
};

export interface MigrationColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  vectorDimensions?: number;
}

export interface MigrationTable {
  name: string;
  columns: MigrationColumn[];
}

export interface MigrationIndex {
  name: string;
  tableName: string;
  columns: string[];
  unique: boolean;
  kind: "btree" | "fts" | "vector";
}

export interface MigrationData {
  tables: MigrationTable[];
  indexes: MigrationIndex[];
  rowCounts: Record<string, number>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const quoteIdentifier = (value: string): string => `"${value.replaceAll(`"`, `""`)}"`;

const normalizeColumnName = (value: string): string => {
  const trimmed = value.trim();

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }

  if (
    (trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) ||
    (trimmed.startsWith(`'`) && trimmed.endsWith(`'`)) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
};

const splitModuleArguments = (value: string): string[] => {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (const character of value) {
    if (quote !== null) {
      current += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === `"` || character === `'` || character === "`") {
      quote = character;
      current += character;
      continue;
    }

    if (character === "[") {
      bracketDepth += 1;
      current += character;
      continue;
    }

    if (character === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += character;
      continue;
    }

    if (character === "(") {
      parenDepth += 1;
      current += character;
      continue;
    }

    if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      current += character;
      continue;
    }

    if (character === "," && bracketDepth === 0 && parenDepth === 0) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      current = "";
      continue;
    }

    current += character;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    parts.push(trimmed);
  }

  return parts;
};

const extractModuleArguments = (sql: string, moduleName: string): string[] => {
  const pattern = new RegExp(`using\\s+${moduleName}\\s*\\((.*)\\)`, "i");
  const match = sql.match(pattern);

  if (!match || match[1] === undefined) {
    return [];
  }

  return splitModuleArguments(match[1]);
};

const inferFtsTargetTable = (virtualTableName: string, argumentsList: string[]): string => {
  const explicitContent = argumentsList.find((entry) => /^content\s*=/i.test(entry));

  if (explicitContent) {
    return normalizeColumnName(explicitContent.split("=", 2)[1] ?? "");
  }

  return virtualTableName.endsWith("_fts")
    ? virtualTableName.slice(0, -4)
    : virtualTableName;
};

const parseFtsIndex = (tableName: string, sql: string): MigrationIndex => {
  const argumentsList = extractModuleArguments(sql, "fts5");
  const columns = argumentsList
    .filter((entry) => !entry.includes("="))
    .map((entry) => normalizeColumnName(entry));
  const targetTable = inferFtsTargetTable(tableName, argumentsList);

  return {
    name: `${targetTable}_search_vector_gin_idx`,
    tableName: targetTable,
    columns,
    unique: false,
    kind: "fts"
  };
};

const parseVectorTable = (tableName: string, sql: string): MigrationTable => {
  const argumentsList = extractModuleArguments(sql, "vec0");
  const columns = argumentsList.map((entry) => {
    const match = entry.match(/^(.+?)\s+float\[(\d+)\]$/i);
    if (!match) {
      throw new Error(`Unsupported sqlite-vec column definition in ${tableName}: ${entry}`);
    }

    return {
      name: normalizeColumnName(match[1] ?? ""),
      type: "BLOB",
      nullable: true,
      defaultValue: null,
      vectorDimensions: Number.parseInt(match[2] ?? "", 10)
    } satisfies MigrationColumn;
  });

  return {
    name: tableName,
    columns
  };
};

const mapColumnType = (column: MigrationColumn): string => {
  if (column.vectorDimensions !== undefined) {
    return `vector(${column.vectorDimensions})`;
  }

  const normalized = column.type.trim().toUpperCase();

  if (normalized === "INTEGER") {
    return "bigint";
  }

  if (normalized === "TEXT") {
    return "text";
  }

  if (normalized === "REAL") {
    return "double precision";
  }

  if (normalized === "BLOB") {
    return "bytea";
  }

  if (normalized === "BOOLEAN") {
    return "boolean";
  }

  return normalized.length === 0 ? "text" : normalized.toLowerCase();
};

const columnSignature = (column: MigrationColumn): string =>
  [
    column.name,
    mapColumnType(column),
    column.nullable ? "nullable" : "not-null",
    column.defaultValue ?? "<null>"
  ].join("|");

const indexSignature = (index: MigrationIndex): string =>
  [
    index.name,
    index.tableName,
    index.kind,
    index.unique ? "unique" : "non-unique",
    index.columns.join(",")
  ].join("|");

const readRowCount = (database: BetterSqlite3.Database, tableName: string): number => {
  try {
    return (
      database
        .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`)
        .get()?.count ?? 0
    );
  } catch {
    return 0;
  }
};

const addFtsShadowTables = (skippedTables: Set<string>, tableName: string): void => {
  for (const suffix of ["_data", "_idx", "_content", "_docsize", "_config"]) {
    skippedTables.add(`${tableName}${suffix}`);
  }
};

export class MigrationTool {
  exportSqlite(dbPath: string): MigrationData {
    const database = new BetterSqlite3(dbPath, { readonly: true });

    try {
      const schema = database
        .prepare<[], SqliteMasterRow>(
          `SELECT name, type, sql, tbl_name
           FROM sqlite_master
           WHERE type IN ('table', 'index')
             AND name NOT LIKE 'sqlite_%'
           ORDER BY type, name`
        )
        .all();
      const ftsTables = new Map(
        schema
          .filter(
            (entry) =>
              entry.type === "table" &&
              entry.sql !== null &&
              /create\s+virtual\s+table/i.test(entry.sql) &&
              /using\s+fts5\s*\(/i.test(entry.sql)
          )
          .map((entry) => [entry.name, entry.sql as string])
      );
      const tables: MigrationTable[] = [];
      const indexes: MigrationIndex[] = [];
      const rowCounts: Record<string, number> = {};
      const skippedVirtualTables = new Set<string>();

      for (const tableName of ftsTables.keys()) {
        skippedVirtualTables.add(tableName);
        addFtsShadowTables(skippedVirtualTables, tableName);
      }

      for (const entry of schema) {
        if (entry.type !== "table") {
          continue;
        }

        const ftsSql = ftsTables.get(entry.name);
        if (ftsSql !== undefined) {
          indexes.push(parseFtsIndex(entry.name, ftsSql));
          continue;
        }

        const sql = entry.sql ?? "";
        if (/create\s+virtual\s+table/i.test(sql) && /using\s+vec0\s*\(/i.test(sql)) {
          tables.push(parseVectorTable(entry.name, sql));
          rowCounts[entry.name] = readRowCount(database, entry.name);
          skippedVirtualTables.add(entry.name);
          continue;
        }

        if (skippedVirtualTables.has(entry.name)) {
          continue;
        }

        const columns = database
          .prepare<[], TableInfoRow>(`PRAGMA table_info(${quoteIdentifier(entry.name)})`)
          .all()
          .map((column) => ({
            name: column.name,
            type: column.type,
            nullable: column.notnull === 0,
            defaultValue: column.dflt_value
          }));

        tables.push({
          name: entry.name,
          columns
        });

        rowCounts[entry.name] = readRowCount(database, entry.name);
      }

      for (const entry of schema) {
        if (entry.type !== "index" || entry.sql === null || skippedVirtualTables.has(entry.tbl_name)) {
          continue;
        }

        const columns = database
          .prepare<[], IndexInfoRow>(`PRAGMA index_info(${quoteIdentifier(entry.name)})`)
          .all()
          .map((column) => column.name)
          .filter((name) => name.length > 0);

        indexes.push({
          name: entry.name,
          tableName: entry.tbl_name,
          columns,
          unique: /create\s+unique\s+index/i.test(entry.sql),
          kind: "btree"
        });
      }

      return {
        tables,
        indexes,
        rowCounts
      };
    } finally {
      database.close();
    }
  }

  generatePgSql(data: MigrationData): string[] {
    const statements: string[] = [];
    const needsPgVector = data.tables.some((table) =>
      table.columns.some((column) => column.vectorDimensions !== undefined)
    );

    if (needsPgVector) {
      statements.push("CREATE EXTENSION IF NOT EXISTS vector;");
    }

    for (const table of data.tables) {
      const columns = table.columns.map((column) => {
        const fragments = [`${quoteIdentifier(column.name)} ${mapColumnType(column)}`];

        if (!column.nullable) {
          fragments.push("NOT NULL");
        }

        if (column.defaultValue !== null) {
          fragments.push(`DEFAULT ${column.defaultValue}`);
        }

        return `  ${fragments.join(" ")}`;
      });

      statements.push(
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.name)} (\n${columns.join(",\n")}\n);`
      );
    }

    for (const index of data.indexes) {
      if (index.kind === "fts") {
        if (index.columns.length === 0) {
          continue;
        }

        const documentExpression = index.columns
          .map((column) => `coalesce(${quoteIdentifier(column)}, '')`)
          .join(` || ' ' || `);

        statements.push(
          [
            `ALTER TABLE ${quoteIdentifier(index.tableName)}`,
            `ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', ${documentExpression})) STORED;`,
            `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(index.name)} ON ${quoteIdentifier(index.tableName)} USING GIN (search_vector);`
          ].join("\n")
        );
        continue;
      }

      const unique = index.unique ? "UNIQUE " : "";
      const columns = index.columns.map((column) => quoteIdentifier(column)).join(", ");
      statements.push(
        `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdentifier(index.name)} ON ${quoteIdentifier(index.tableName)} (${columns});`
      );
    }

    return statements;
  }

  validateMigration(source: MigrationData, target: MigrationData): ValidationResult {
    const errors: string[] = [];
    const targetTables = new Map(target.tables.map((table) => [table.name, table]));
    const targetIndexes = new Set(target.indexes.map((index) => indexSignature(index)));

    for (const table of source.tables) {
      const targetTable = targetTables.get(table.name);
      if (!targetTable) {
        errors.push(`Missing table: ${table.name}`);
        continue;
      }

      const sourceColumns = new Map(table.columns.map((column) => [column.name, columnSignature(column)]));
      const comparedColumns = new Map(
        targetTable.columns.map((column) => [
          column.name,
          [
            column.name,
            column.type.toLowerCase(),
            column.nullable ? "nullable" : "not-null",
            column.defaultValue ?? "<null>"
          ].join("|")
        ])
      );

      for (const [columnName, signature] of sourceColumns) {
        if (comparedColumns.get(columnName) !== signature) {
          errors.push(`Column mismatch: ${table.name}.${columnName}`);
        }
      }
    }

    for (const index of source.indexes) {
      if (!targetIndexes.has(indexSignature(index))) {
        errors.push(`Missing index: ${index.name}`);
      }
    }

    for (const [tableName, rowCount] of Object.entries(source.rowCounts)) {
      if (target.rowCounts[tableName] !== rowCount) {
        errors.push(`Row count mismatch: ${tableName}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}
