import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import Database from "better-sqlite3";

import type { CloudBackupConfig } from "../config.js";

interface BackupMetadata {
  timestamp: string;
  memory_count: number;
  db_size_bytes: number;
}

const METADATA_SUFFIX = ".metadata.json";

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const log = (message: string): void => {
  console.log(`[CloudBackup] ${message}`);
};

const logError = (message: string): void => {
  console.error(`[CloudBackup] ${message}`);
};

export class CloudBackupProvider {
  constructor(private readonly config: CloudBackupConfig) {}

  private assertReady(): void {
    if (!this.config.enabled) {
      throw new Error("Cloud backup is disabled");
    }

    if (this.config.provider !== "local-sync") {
      throw new Error(`Cloud backup provider not yet implemented: ${this.config.provider}`);
    }
  }

  private getMetadataPath(remoteName: string): string {
    return join(this.config.destDir, `${remoteName}${METADATA_SUFFIX}`);
  }

  private async buildMetadata(localPath: string): Promise<BackupMetadata> {
    const fileStat = await stat(localPath);
    let memoryCount = 0;

    try {
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

    return {
      timestamp: new Date(fileStat.mtimeMs).toISOString(),
      memory_count: memoryCount,
      db_size_bytes: fileStat.size
    };
  }

  private async readMetadata(remoteName: string): Promise<BackupMetadata | null> {
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

  async upload(localPath: string): Promise<string> {
    this.assertReady();

    const remoteName = basename(localPath);
    const remotePath = join(this.config.destDir, remoteName);
    const metadataPath = this.getMetadataPath(remoteName);

    try {
      await mkdir(this.config.destDir, { recursive: true });
      await copyFile(localPath, remotePath);
      await writeFile(
        metadataPath,
        `${JSON.stringify(await this.buildMetadata(localPath), null, 2)}\n`,
        "utf8"
      );
      log(`Uploaded ${remoteName} to ${this.config.destDir}`);
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

    try {
      const entries = await readdir(this.config.destDir, { withFileTypes: true });
      const backups = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
          .map(async (entry) => {
            const metadata = await this.readMetadata(entry.name);
            const fileStat = await stat(join(this.config.destDir, entry.name));
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

      const message = `Failed to list backups in ${this.config.destDir}: ${getErrorMessage(error)}`;
      logError(message);
      throw new Error(message);
    }
  }

  async download(remoteName: string, localPath: string): Promise<void> {
    this.assertReady();

    try {
      await mkdir(dirname(localPath), { recursive: true });
      await copyFile(join(this.config.destDir, remoteName), localPath);
      log(`Downloaded ${remoteName} to ${localPath}`);
    } catch (error) {
      const message = `Download failed for ${remoteName}: ${getErrorMessage(error)}`;
      logError(message);
      throw new Error(message);
    }
  }
}
