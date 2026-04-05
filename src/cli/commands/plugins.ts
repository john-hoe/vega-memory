import { Command } from "commander";

import { PluginLoader } from "../../plugins/loader.js";

const printPlugins = (pluginLoader: PluginLoader): void => {
  const plugins = pluginLoader.listPlugins();

  if (plugins.length === 0) {
    console.log("No plugins found.");
    return;
  }

  for (const plugin of plugins) {
    console.log(plugin);
  }
};

export function registerPluginCommands(program: Command, pluginLoader: PluginLoader): void {
  const pluginsCommand = program.command("plugins").description("Inspect available Vega plugins");

  pluginsCommand.action(() => {
    printPlugins(pluginLoader);
  });
  pluginsCommand
    .command("list")
    .description("List available plugins")
    .action(() => {
      printPlugins(pluginLoader);
    });
}
