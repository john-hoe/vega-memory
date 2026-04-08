import { TenantSchemaManager } from "./tenant-schema.js";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll(`"`, `""`)}"`;
}

export class TenantRouter {
  constructor(private schemaManager: TenantSchemaManager) {}

  getSearchPath(tenantId: string): string {
    const schemaNames = [
      this.schemaManager.getSchemaName(tenantId),
      this.schemaManager.getSharedSchemaName(),
      this.schemaManager.getDefaultSchemaName()
    ];
    const searchPath = schemaNames
      .map((schema) => quoteIdentifier(this.schemaManager.sanitizeTenantId(schema)))
      .join(", ");

    return `SET LOCAL search_path TO ${searchPath}`;
  }

  async withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const searchPath = this.getSearchPath(tenantId);

    console.log(`Apply search_path before query execution: ${searchPath}`);
    return fn();
  }
}
