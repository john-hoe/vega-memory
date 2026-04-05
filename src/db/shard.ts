import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { Repository } from "./repository.js";

export class ShardManager {
  private readonly shardDir: string;
  private readonly shardRoot: string;
  private readonly repositories = new Map<string, Repository>();

  constructor(private readonly baseDir: string) {
    this.shardDir = join(baseDir, "shards");
    this.shardRoot = resolve(this.shardDir);
    mkdirSync(this.shardRoot, { recursive: true });
  }

  private resolveShardPath(project: string): string {
    const normalizedProject = project.trim();

    if (
      normalizedProject.length === 0 ||
      normalizedProject === "." ||
      normalizedProject === ".." ||
      /[\/\\\u0000]/u.test(normalizedProject)
    ) {
      throw new Error("Invalid project shard name");
    }

    const shardPath = resolve(this.shardRoot, `${normalizedProject}.db`);
    if (!shardPath.startsWith(`${this.shardRoot}${sep}`)) {
      throw new Error("Invalid project shard name");
    }

    return shardPath;
  }

  getShardPath(project: string): string {
    return this.resolveShardPath(project);
  }

  getOrCreateShard(project: string): Repository {
    const shardPath = this.resolveShardPath(project);
    const cached = this.repositories.get(shardPath);
    if (cached) {
      return cached;
    }

    if (!existsSync(shardPath)) {
      mkdirSync(this.shardRoot, { recursive: true });
    }

    const repository = new Repository(shardPath);
    this.repositories.set(shardPath, repository);
    return repository;
  }

  listShards(): string[] {
    return readdirSync(this.shardRoot)
      .filter((entry) => entry.endsWith(".db"))
      .sort((left, right) => left.localeCompare(right));
  }

  closeAll(): void {
    for (const repository of this.repositories.values()) {
      repository.close();
    }

    this.repositories.clear();
  }
}
