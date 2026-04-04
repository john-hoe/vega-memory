import { copyFile, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { CloudBackupConfig } from "../config.js";

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

  async upload(localPath: string): Promise<string> {
    this.assertReady();

    await mkdir(this.config.destDir, { recursive: true });
    const remoteName = basename(localPath);

    await copyFile(localPath, join(this.config.destDir, remoteName));

    return remoteName;
  }

  async listBackups(): Promise<string[]> {
    this.assertReady();

    try {
      const entries = await readdir(this.config.destDir, { withFileTypes: true });

      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async download(remoteName: string, localPath: string): Promise<void> {
    this.assertReady();

    await mkdir(dirname(localPath), { recursive: true });
    await copyFile(join(this.config.destDir, remoteName), localPath);
  }
}
