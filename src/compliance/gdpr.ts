import type { DatabaseAdapter } from "../db/adapter.js";

export interface UserDataExport {
  sections: Record<string, unknown[]>;
  exportedAt: string;
  userId: string;
}

export interface ErasureReport {
  erasedCounts: Record<string, number>;
  erasedAt: string;
  anonymized: string[];
}

export interface DataCategory {
  name: string;
  description: string;
  retention: string;
  legalBasis: string;
}

interface ColumnInfoRow {
  name: string;
}

interface CountRow {
  total: number;
}

interface TableSpec {
  section: string;
  table: string;
  identityColumns: string[];
  mode?: "delete" | "anonymize";
}

const JSON_COLUMNS = new Map<string, Set<string>>([
  ["memories", new Set(["tags", "accessed_projects"])],
  ["sessions", new Set(["memories_created"])],
  ["wiki_pages", new Set(["tags", "source_memory_ids"])],
  ["wiki_comments", new Set(["mentions"])]
]);

const EXPORT_SPECS: TableSpec[] = [
  {
    section: "users",
    table: "users",
    identityColumns: ["id"]
  },
  {
    section: "memories",
    table: "memories",
    identityColumns: ["user_id", "owner_id", "author_id", "created_by"]
  },
  {
    section: "sessions",
    table: "sessions",
    identityColumns: ["user_id", "owner_id", "actor"]
  },
  {
    section: "wiki_pages",
    table: "wiki_pages",
    identityColumns: ["user_id", "owner_id", "author_id", "created_by"]
  },
  {
    section: "audit_log",
    table: "audit_log",
    identityColumns: ["user_id", "actor"]
  },
  {
    section: "team_members",
    table: "team_members",
    identityColumns: ["user_id"]
  },
  {
    section: "teams",
    table: "teams",
    identityColumns: ["owner_id"]
  }
];

const ERASURE_SPECS: TableSpec[] = [
  {
    section: "memories",
    table: "memories",
    identityColumns: ["user_id", "owner_id", "author_id", "created_by"],
    mode: "delete"
  },
  {
    section: "sessions",
    table: "sessions",
    identityColumns: ["user_id", "owner_id", "actor"],
    mode: "delete"
  },
  {
    section: "wiki_pages",
    table: "wiki_pages",
    identityColumns: ["user_id", "owner_id", "author_id", "created_by"],
    mode: "delete"
  },
  {
    section: "team_members",
    table: "team_members",
    identityColumns: ["user_id"],
    mode: "delete"
  },
  {
    section: "teams",
    table: "teams",
    identityColumns: ["owner_id"],
    mode: "anonymize"
  },
  {
    section: "audit_log",
    table: "audit_log",
    identityColumns: ["user_id", "actor"],
    mode: "anonymize"
  },
  {
    section: "users",
    table: "users",
    identityColumns: ["id"],
    mode: "delete"
  }
];

const DATA_CATEGORIES: DataCategory[] = [
  {
    name: "memories",
    description: "User-authored and system-derived memory records, including titles, content, tags, and metadata.",
    retention: "Retained until deleted by the tenant or lifecycle policies archive and remove the records.",
    legalBasis: "GDPR Article 6(1)(b) contract performance and Article 6(1)(f) legitimate interests."
  },
  {
    name: "sessions",
    description: "Session summaries, start and end timestamps, and references to memories created during a session.",
    retention: "Retained for operational history until removed by the tenant or an erasure workflow.",
    legalBasis: "GDPR Article 6(1)(b) contract performance."
  },
  {
    name: "wiki",
    description: "Knowledge base pages synthesized from memories, including summaries, tags, and linked source identifiers.",
    retention: "Retained until deleted by the tenant, superseded by later edits, or erased under data subject requests.",
    legalBasis: "GDPR Article 6(1)(b) contract performance and Article 6(1)(f) legitimate interests."
  },
  {
    name: "audit",
    description: "Administrative and security logs covering actors, actions, timestamps, network metadata, and affected records.",
    retention: "Retained according to tenant security policy and minimized through anonymization when erasure is requested.",
    legalBasis: "GDPR Article 6(1)(c) legal obligation and Article 6(1)(f) legitimate interests."
  }
];

const now = (): string => new Date().toISOString();

const normalizeCell = (table: string, column: string, value: unknown): unknown => {
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (typeof value === "string" && JSON_COLUMNS.get(table)?.has(column) === true) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }

  return value;
};

const normalizeRow = (table: string, row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([column, value]) => [column, normalizeCell(table, column, value)])
  );

export class GdprService {
  private readonly columnCache = new Map<string, Set<string>>();

  constructor(private readonly db: DatabaseAdapter) {}

  async exportUserData(userId: string, tenantId: string): Promise<UserDataExport> {
    const sections: Record<string, unknown[]> = {};

    for (const spec of EXPORT_SPECS) {
      sections[spec.section] = this.selectRows(spec, userId, tenantId);
    }

    return {
      sections,
      exportedAt: now(),
      userId
    };
  }

  async eraseUserData(userId: string, tenantId: string): Promise<ErasureReport> {
    const erasedCounts: Record<string, number> = {};
    const anonymized: string[] = [];

    this.db.transaction(() => {
      for (const spec of ERASURE_SPECS) {
        const result = this.eraseRows(spec, userId, tenantId);
        erasedCounts[spec.section] = result.count;

        if (result.count > 0 && spec.mode === "anonymize") {
          anonymized.push(spec.section);
        }
      }
    });

    return {
      erasedCounts,
      erasedAt: now(),
      anonymized
    };
  }

  async getDataCategories(): Promise<DataCategory[]> {
    return DATA_CATEGORIES.map((category) => ({ ...category }));
  }

  async generateDPA(tenantId: string): Promise<string> {
    const generatedAt = now();

    return [
      "DATA PROCESSING AGREEMENT",
      "",
      `Controller: Tenant ${tenantId}`,
      "Processor: Vega Memory operator",
      `Generated at: ${generatedAt}`,
      "",
      "1. Subject Matter and Duration",
      "The Processor handles memory storage, session history, wiki content, and audit records solely to provide the Vega Memory service during the subscription term.",
      "",
      "2. Nature and Purpose of Processing",
      "Processing covers storage, retrieval, synchronization, security logging, and deletion workflows requested by the Controller.",
      "",
      "3. Categories of Data and Data Subjects",
      "Categories include memories, sessions, wiki content, and audit metadata relating to end users, administrators, and team members.",
      "",
      "4. Processor Obligations under Article 28",
      "The Processor acts only on documented instructions from the Controller, ensures personnel confidentiality, supports subprocessors under written terms, and makes information available for audits required by Article 28 GDPR.",
      "",
      "5. Security under Article 32",
      "The Processor maintains technical and organizational measures appropriate to the risk, including access controls, encryption options, backup controls, and audit logging.",
      "",
      "6. Breach Notification under Article 33",
      "The Processor will notify the Controller without undue delay after becoming aware of a personal data breach affecting Controller data.",
      "",
      "7. Data Subject Assistance under Articles 15 and 17",
      "The Processor provides export and erasure workflows so the Controller can answer Article 15 Right of Access and Article 17 Right to Erasure requests.",
      "",
      "8. Return and Deletion",
      "Upon termination or instruction, the Processor deletes or returns personal data unless Union or Member State law requires retention.",
      "",
      "9. Audit and Demonstration of Compliance",
      "The Processor will provide reasonable information necessary to demonstrate compliance with this DPA and GDPR obligations."
    ].join("\n");
  }

  private getColumns(table: string): Set<string> {
    const cached = this.columnCache.get(table);

    if (cached !== undefined) {
      return cached;
    }

    const rows = this.db.all<ColumnInfoRow>(`PRAGMA table_info(${table})`);
    const columns = new Set(rows.map((row) => row.name));
    this.columnCache.set(table, columns);
    return columns;
  }

  private selectRows(spec: TableSpec, userId: string, tenantId: string): unknown[] {
    const clause = this.buildWhereClause(spec, userId, tenantId);

    if (clause === null) {
      return [];
    }

    const orderBy = this.resolveOrderBy(this.getColumns(spec.table));
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM ${spec.table} ${clause.where} ${orderBy}`,
      ...clause.params
    );

    return rows.map((row) => normalizeRow(spec.table, row));
  }

  private eraseRows(
    spec: TableSpec,
    userId: string,
    tenantId: string
  ): {
    count: number;
  } {
    const clause = this.buildWhereClause(spec, userId, tenantId);

    if (clause === null) {
      return {
        count: 0
      };
    }

    const count = this.db.get<CountRow>(
      `SELECT COUNT(*) AS total FROM ${spec.table} ${clause.where}`,
      ...clause.params
    )?.total ?? 0;

    if (count === 0) {
      return {
        count: 0
      };
    }

    if (spec.mode === "anonymize") {
      const assignments = this.resolveAnonymizationAssignments(spec.table);

      if (assignments.length === 0) {
        return {
          count: 0
        };
      }

      this.db.run(
        `UPDATE ${spec.table}
         SET ${assignments.join(", ")}
         ${clause.where}`,
        ...clause.params
      );

      return {
        count
      };
    }

    this.db.run(`DELETE FROM ${spec.table} ${clause.where}`, ...clause.params);

    return {
      count
    };
  }

  private buildWhereClause(
    spec: TableSpec,
    userId: string,
    tenantId: string
  ): {
    where: string;
    params: unknown[];
  } | null {
    const columns = this.getColumns(spec.table);
    if (columns.size === 0) {
      return null;
    }

    const identityColumns = spec.identityColumns.filter((column) => columns.has(column));
    if (identityColumns.length === 0) {
      return null;
    }

    const whereParts = [
      `(${identityColumns.map((column) => `${column} = ?`).join(" OR ")})`
    ];
    const params: unknown[] = identityColumns.map(() => userId);

    if (columns.has("tenant_id")) {
      whereParts.push("tenant_id = ?");
      params.push(tenantId);
    }

    return {
      where: `WHERE ${whereParts.join(" AND ")}`,
      params
    };
  }

  private resolveOrderBy(columns: Set<string>): string {
    for (const column of ["updated_at", "created_at", "joined_at", "timestamp", "id"]) {
      if (columns.has(column)) {
        return `ORDER BY ${column} ASC`;
      }
    }

    return "";
  }

  private resolveAnonymizationAssignments(table: string): string[] {
    const columns = this.getColumns(table);
    const assignments: string[] = [];

    if (table === "audit_log") {
      if (columns.has("actor")) {
        assignments.push(`actor = 'deleted-user'`);
      }

      if (columns.has("detail")) {
        assignments.push(`detail = 'Erased under GDPR Article 17 request'`);
      }

      if (columns.has("ip")) {
        assignments.push("ip = NULL");
      }

      if (columns.has("user_id")) {
        assignments.push(`user_id = 'deleted-user'`);
      }
    }

    if (table === "teams" && columns.has("owner_id")) {
      assignments.push(`owner_id = 'deleted-user'`);
    }

    return assignments;
  }
}
