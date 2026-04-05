import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { PluginContext, VegaPlugin } from "./sdk.js";

interface PluginManifest {
  name?: string;
  version?: string;
  main?: string;
}

interface PluginDescriptor {
  directory: string;
  entryPath: string;
  manifest: PluginManifest;
  name: string;
}

export interface LoadedPlugin {
  name: string;
  version: string;
  directory: string;
  entryPath: string;
}

const DEFAULT_PLUGIN_DIR = resolve(process.cwd(), "data", "plugins");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readManifest = (manifestPath: string): PluginManifest => {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;

  if (!isRecord(parsed)) {
    return {};
  }

  return {
    name: typeof parsed.name === "string" ? parsed.name.trim() : undefined,
    version: typeof parsed.version === "string" ? parsed.version.trim() : undefined,
    main: typeof parsed.main === "string" ? parsed.main.trim() : undefined
  };
};

const resolvePluginExport = (moduleExports: Record<string, unknown>): VegaPlugin => {
  const plugin = (moduleExports.default ?? moduleExports.plugin ?? moduleExports) as unknown;

  if (
    !isRecord(plugin) ||
    typeof plugin.name !== "string" ||
    typeof plugin.version !== "string" ||
    typeof plugin.init !== "function"
  ) {
    throw new Error("Plugin entry must export an object with name, version, and init(context)");
  }

  return plugin as unknown as VegaPlugin;
};

export class PluginLoader {
  readonly pluginDir: string;

  constructor(pluginDir = DEFAULT_PLUGIN_DIR) {
    this.pluginDir = resolve(pluginDir);
  }

  private getPluginDescriptors(): PluginDescriptor[] {
    if (!existsSync(this.pluginDir)) {
      return [];
    }

    return readdirSync(this.pluginDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const directory = join(this.pluginDir, entry.name);
        const manifestPath = join(directory, "plugin.json");

        if (!existsSync(manifestPath)) {
          return [];
        }

        const manifest = readManifest(manifestPath);
        const name = manifest.name && manifest.name.length > 0 ? manifest.name : entry.name;

        return [
          {
            directory,
            entryPath: resolve(directory, manifest.main ?? "index.js"),
            manifest,
            name
          }
        ];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async loadPlugins(context: PluginContext): Promise<LoadedPlugin[]> {
    const loadedPlugins: LoadedPlugin[] = [];

    for (const descriptor of this.getPluginDescriptors()) {
      const moduleExports = (await import(
        pathToFileURL(descriptor.entryPath).href
      )) as Record<string, unknown>;
      const plugin = resolvePluginExport(moduleExports);

      await Promise.resolve(plugin.init(context));
      loadedPlugins.push({
        name: plugin.name,
        version: plugin.version,
        directory: descriptor.directory,
        entryPath: descriptor.entryPath
      });
    }

    return loadedPlugins;
  }

  listPlugins(): string[] {
    return this.getPluginDescriptors().map((descriptor) => descriptor.name);
  }
}
