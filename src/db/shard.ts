import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { Repository } from "./repository.js";

export class ShardManager {
  private readonly shardDir: string;
  private readonly repositories = new Map<string, Repository>();

  constructor(private readonly baseDir: string) {
    this.shardDir = join(baseDir, "shards");
    mkdirSync(this.shardDir, { recursive: true });
  }

  getShardPath(project: string): string {
    return join(this.shardDir, `${project}.db`);
  }

  getOrCreateShard(project: string): Repository {
    const cached = this.repositories.get(project);
    if (cached) {
      return cached;
    }

    const shardPath = this.getShardPath(project);
    if (!existsSync(shardPath)) {
      mkdirSync(this.shardDir, { recursive: true });
    }

    const repository = new Repository(shardPath);
    this.repositories.set(project, repository);
    return repository;
  }

  listShards(): string[] {
    return readdirSync(this.shardDir)
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
