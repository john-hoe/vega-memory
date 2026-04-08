import { TenantSchemaManager } from "./tenant-schema.js";

export class TenantRouter {
  constructor(private schemaManager: TenantSchemaManager) {}

  getSearchPath(tenantId: string): string {
    const schemaName = this.schemaManager.getSchemaName(tenantId);
    const sharedSchema = this.schemaManager.getSharedSchemaName();
    const defaultSchema = this.schemaManager.getDefaultSchemaName();

    return `SET search_path TO ${schemaName}, ${sharedSchema}, ${defaultSchema}`;
  }

  async withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const searchPath = this.getSearchPath(tenantId);

    console.log(`Would set search_path: ${searchPath}`);
    return fn();
  }
}
