import { Command } from "commander";

import { WhiteLabelConfig } from "../../core/whitelabel.js";

const printSettings = (settings: ReturnType<WhiteLabelConfig["load"]>): void => {
  console.log(`brandName: ${settings.brandName}`);
  console.log(`primaryColor: ${settings.primaryColor}`);
  console.log(`dashboardTitle: ${settings.dashboardTitle}`);
  console.log(`footerText: ${settings.footerText}`);
  console.log(`logoUrl: ${settings.logoUrl ?? "none"}`);
  console.log(`customCss: ${settings.customCss ?? "none"}`);
};

export function registerWhiteLabelCommand(
  program: Command,
  whiteLabelConfig: WhiteLabelConfig
): void {
  program
    .command("whitelabel")
    .description("View or update white-label settings")
    .option("--brand-name <name>", "brand name")
    .option("--primary-color <color>", "primary color")
    .action((options: { brandName?: string; primaryColor?: string }) => {
      const current = whiteLabelConfig.load();
      const shouldSave = options.brandName !== undefined || options.primaryColor !== undefined;

      if (!shouldSave) {
        printSettings(current);
        return;
      }

      whiteLabelConfig.save({
        ...current,
        ...(options.brandName !== undefined ? { brandName: options.brandName } : {}),
        ...(options.primaryColor !== undefined ? { primaryColor: options.primaryColor } : {})
      });

      printSettings(whiteLabelConfig.load());
    });
}
