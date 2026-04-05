import { Command, Option } from "commander";

import { TENANT_PLANS, TenantService } from "../../core/tenant.js";
import type { Tenant, TenantPlan } from "../../core/types.js";

const printTenant = (tenant: Tenant): void => {
  console.log(`id: ${tenant.id}`);
  console.log(`name: ${tenant.name}`);
  console.log(`plan: ${tenant.plan}`);
  console.log(`api_key: ${tenant.api_key}`);
  console.log(`active: ${tenant.active}`);
  console.log(`memory_limit: ${tenant.memory_limit}`);
};

export function registerTenantCommands(program: Command, tenantService: TenantService): void {
  const tenantCommand = program.command("tenant").description("Manage tenants");

  tenantCommand
    .command("create")
    .description("Create a tenant")
    .argument("<name>", "tenant name")
    .addOption(new Option("--plan <plan>", "tenant plan").choices([...TENANT_PLANS]).default("free"))
    .action((name: string, options: { plan: TenantPlan }) => {
      printTenant(tenantService.createTenant(name, options.plan));
    });

  tenantCommand
    .command("list")
    .description("List tenants")
    .action(() => {
      const tenants = tenantService.listTenants();

      if (tenants.length === 0) {
        console.log("No tenants found.");
        return;
      }

      console.table(
        tenants.map((tenant) => ({
          id: tenant.id,
          name: tenant.name,
          plan: tenant.plan,
          active: tenant.active,
          memory_limit: tenant.memory_limit,
          created_at: tenant.created_at
        }))
      );
    });

  tenantCommand
    .command("deactivate")
    .description("Deactivate a tenant")
    .argument("<id>", "tenant id")
    .action((id: string) => {
      tenantService.deactivateTenant(id);
      console.log(`deactivated ${id}`);
    });
}
