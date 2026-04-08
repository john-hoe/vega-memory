import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";

import type { CloudBackupConfig } from "../config.js";
import type { CloudStorageProvider } from "./cloud-providers.js";
import { createCloudProvider } from "./cloud-providers.js";

interface BackupMetadata {
  timestamp: string;
  memory_count: number;
  db_size_bytes: number;
}

const METADATA_SUFFIX = ".metadata.json";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const log = (message: string): void => {
  console.log(`[CloudBackup] ${message}`);
};

const logError = (message: string): void => {
  console.error(`[CloudBackup] ${message}`);
};

type LocalSyncCloudBackupConfig = Extract<CloudBackupConfig, { provider: "local-sync" }>;

export class CloudBackupProvider {
  private readonly remoteProvider: CloudStorageProvider | null;

  constructor(private readonly config: CloudBackupConfig) {
    switch (config.provider) {
      case "s3":
        this.remoteProvider = createCloudProvider("s3", config);
        break;
      case "gdrive":
        this.remoteProvider = createCloudProvider("gdrive", config);
        break;
      case "icloud":
        this.remoteProvider = createCloudProvider("icloud", config);
        break;
      default:
        this.remoteProvider = null;
        break;
    }
  }

  private getLocalConfig(): LocalSyncCloudBackupConfig {
    if (this.config.provider !== "local-sync") {
      throw new Error("Local sync configuration is unavailable");
    }

    return this.config;
  }

  private getRemoteProvider(): CloudStorageProvider {
    if (this.remoteProvider === null) {
      throw new Error(`Cloud backup provider is unavailable: ${this.config.provider}`);
    }

    return this.remoteProvider;
  }

  private assertReady(): void {
    if (!this.config.enabled) {
      throw new Error("Cloud backup is disabled");
    }

    if (this.config.provider !== "local-sync" && !this.getRemoteProvider().isConfigured()) {
      throw new Error(`Cloud backup provider is not configured: ${this.config.provider}`);
    }
  }

  private getMetadataPath(remoteName: string): string {
    return join(this.getLocalConfig().destDir, this.getMetadataKey(remoteName));
  }

  private getMetadataKey(remoteName: string): string {
    return `${remoteName}${METADATA_SUFFIX}`;
  }

  private async buildMetadata(localPath: string): Promise<BackupMetadata> {
    const fileStat = await stat(localPath);
    let memoryCount = 0;

    if (!localPath.endsWith(".enc")) {
      try {
        const fileHeader = (await readFile(localPath)).subarray(0, SQLITE_HEADER.length);

        if (!fileHeader.equals(SQLITE_HEADER)) {
          return {
            timestamp: new Date(fileStat.mtimeMs).toISOString(),
            memory_count: memoryCount,
            db_size_bytes: fileStat.size
          };
        }

        const db = new Database(localPath, { readonly: true, fileMustExist: true });

        try {
          memoryCount =
            db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM memories").get()?.count ?? 0;
        } finally {
          db.close();
        }
      } catch (error) {
        logError(`Metadata count lookup failed for ${localPath}: ${getErrorMessage(error)}`);
      }
    }

    return {
      timestamp: new Date(fileStat.mtimeMs).toISOString(),
      memory_count: memoryCount,
      db_size_bytes: fileStat.size
    };
  }

  private async readLocalMetadata(remoteName: string): Promise<BackupMetadata | null> {
    try {
      const content = await readFile(this.getMetadataPath(remoteName), "utf8");
      return JSON.parse(content) as BackupMetadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      logError(`Metadata read failed for ${remoteName}: ${getErrorMessage(error)}`);
      return null;
    }
  }

  private async readRemoteMetadata(remoteName: string): Promise<BackupMetadata | null> {
    try {
      const content = await this.getRemoteProvider().download(this.getMetadataKey(remoteName));
      return JSON.parse(content.toString("utf8")) as BackupMetadata;
    } catch (error) {
      logError(`Metadata read failed for ${remoteName}: ${getErrorMessage(error)}`);
      return null;
    }
  }

  async upload(localPath: string): Promise<string> {
    this.assertReady();

    const remoteName = basename(localPath);

    if (this.config.provider !== "local-sync") {
      const provider = this.getRemoteProvider();
      const metadataKey = this.getMetadataKey(remoteName);

      try {
        const [data, metadata] = await Promise.all([readFile(localPath), this.buildMetadata(localPath)]);

        await provider.upload(remoteName, data);
        await provider.upload(metadataKey, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"));
        log(`Uploaded ${remoteName} via ${this.config.provider}`);
        return remoteName;
      } catch (error) {
        await provider.delete(remoteName);
        await provider.delete(metadataKey);
        const message = `Upload failed for ${localPath}: ${getErrorMessage(error)}`;
        logError(message);
        throw new Error(message);
      }
    }

    const localConfig = this.getLocalConfig();
    const remotePath = join(localConfig.destDir, remoteName);
    const metadataPath = this.getMetadataPath(remoteName);

    try {
      await mkdir(localConfig.destDir, { recursive: true });
      await copyFile(localPath, remotePath);
      await writeFile(
        metadataPath,
        `${JSON.stringify(await this.buildMetadata(localPath), null, 2)}\n`,
        "utf8"
      );
      log(`Uploaded ${remoteName} to ${localConfig.destDir}`);
      return remoteName;
    } catch (error) {
      await rm(remotePath, { force: true });
      await rm(metadataPath, { force: true });
      const message = `Upload failed for ${localPath}: ${getErrorMessage(error)}`;
      logError(message);
      throw new Error(message);
    }
  }

  async listBackups(): Promise<string[]> {
    this.assertReady();

    if (this.config.provider !== "local-sync") {
      try {
        const backups = await Promise.all(
          (await this.getRemoteProvider().list())
            .filter((entry) => /\.db(?:\.enc)?$/.test(entry.key))
            .map(async (entry) => {
              const metadata = await this.readRemoteMetadata(entry.key);
              const sortTime = metadata ? Date.parse(metadata.timestamp) : entry.lastModified.getTime();

              return {
                name: entry.key,
                sortTime: Number.isFinite(sortTime) ? sortTime : entry.lastModified.getTime()
              };
            })
        );

        return backups
          .sort((left, right) => right.sortTime - left.sortTime || left.name.localeCompare(right.name))
          .map((entry) => entry.name);
      } catch (error) {
        const message = `Failed to list backups for ${this.config.provider}: ${getErrorMessage(error)}`;
        logError(message);
        throw new Error(message);
      }
    }

    const localConfig = this.getLocalConfig();

    try {
      const entries = await readdir(localConfig.destDir, { withFileTypes: true });
      const backups = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && /\.db(?:\.enc)?$/.test(entry.name))
          .map(async (entry) => {
            const metadata = await this.readLocalMetadata(entry.name);
            const fileStat = await stat(join(localConfig.destDir, entry.name));
            const sortTime = metadata ? Date.parse(metadata.timestamp) : fileStat.mtimeMs;

            return {
              name: entry.name,
              sortTime: Number.isFinite(sortTime) ? sortTime : fileStat.mtimeMs
            };
          })
      );

      return backups
        .sort((left, right) => right.sortTime - left.sortTime || left.name.localeCompare(right.name))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      const message = `Failed to list backups in ${localConfig.destDir}: ${getErrorMessage(error)}`;
      logError(message);
      throw new Error(message);
    }
  }

  async download(remoteName: string, localPath: string): Promise<void> {
    this.assertReady();

    if (this.config.provider !== "local-sync") {
      try {
        await mkdir(dirname(localPath), { recursive: true });
        await writeFile(localPath, await this.getRemoteProvider().download(remoteName));
        log(`Downloaded ${remoteName} via ${this.config.provider} to ${localPath}`);
        return;
      } catch (error) {
        const message = `Download failed for ${remoteName}: ${getErrorMessage(error)}`;
        logError(message);
        throw new Error(message);
      }
    }

    try {
      await mkdir(dirname(localPath), { recursive: true });
      await copyFile(join(this.getLocalConfig().destDir, remoteName), localPath);
      log(`Downloaded ${remoteName} to ${localPath}`);
    } catch (error) {
      const message = `Download failed for ${remoteName}: ${getErrorMessage(error)}`;
      logError(message);
      throw new Error(message);
    }
  }
}
