import { Command } from "commander";

import { TemplateMarketplace } from "../../plugins/marketplace.js";
import type { Repository } from "../../db/repository.js";

const printTemplates = async (marketplace: TemplateMarketplace): Promise<void> => {
  const templates = await marketplace.listTemplates();

  if (templates.length === 0) {
    console.log("No templates available.");
    return;
  }

  for (const template of templates) {
    console.log(`${template.name}\t${template.description}`);
  }
};

export function registerTemplateCommands(
  program: Command,
  marketplace: TemplateMarketplace,
  repository: Repository
): void {
  const templatesCommand = program
    .command("templates")
    .description("Browse and install memory templates");

  templatesCommand.action(async () => {
    await printTemplates(marketplace);
  });
  templatesCommand
    .command("list")
    .description("List starter templates")
    .action(async () => {
      await printTemplates(marketplace);
    });
  templatesCommand
    .command("install")
    .description("Install a starter template")
    .argument("<name>", "template name")
    .action(async (name: string) => {
      const installed = await marketplace.installTemplate(name, repository);

      console.log(`installed ${installed} rules from ${name}`);
    });
}
