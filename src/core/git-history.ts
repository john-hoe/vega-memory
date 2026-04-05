import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import type { Memory, MemoryType } from "./types.js";
import { MemoryService } from "./memory.js";
import { Repository } from "../db/repository.js";

const execFileAsync = promisify(execFile);

const parseGitLog = (output: string): Array<{ hash: string; subject: string }> =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash, ...subjectParts] = line.split(" ");

      return {
        hash,
        subject: subjectParts.join(" ").trim()
      };
    })
    .filter((entry) => entry.hash.length > 0 && entry.subject.length > 0);

const isTaskStateCommit = (subject: string): boolean =>
  /\b(todo|wip|next|follow[- ]?up|pending|continue)\b/i.test(subject);

const isPitfallCommit = (subject: string): boolean =>
  /\b(fix|bug|hotfix|revert|regression|incident)\b/i.test(subject);

export class GitHistoryService {
  constructor(
    private readonly repository: Repository,
    private readonly memoryService: MemoryService
  ) {}

  private listProjectMemories(project: string): Memory[] {
    return this.repository.listMemories({
      project,
      limit: 10_000
    });
  }

  private hasCommitMemory(project: string, hash: string): boolean {
    const shortHash = hash.slice(0, 7).toLowerCase();

    return this.listProjectMemories(project).some((memory) =>
      memory.tags.some((tag) => tag.toLowerCase() === shortHash)
    );
  }

  private async storeCommitMemory(
    project: string,
    hash: string,
    subject: string,
    type: MemoryType
  ): Promise<boolean> {
    if (this.hasCommitMemory(project, hash)) {
      return false;
    }

    await this.memoryService.store({
      content: subject,
      title: subject,
      type,
      project,
      tags: ["git", project, hash.slice(0, 7)],
      source: "explicit",
      skipSimilarityCheck: true
    });

    return true;
  }

  async extractFromGitLog(
    repoPath: string,
    since?: string,
    limit = 50
  ): Promise<number> {
    const absoluteRepoPath = resolve(repoPath);
    const args = ["-C", absoluteRepoPath, "log", "--oneline"];

    if (since) {
      args.push(`--since=${since}`);
    }

    args.push("-n", String(limit));

    const { stdout } = await execFileAsync("git", args, {
      encoding: "utf8"
    });
    const project = basename(absoluteRepoPath);
    let imported = 0;

    for (const entry of parseGitLog(stdout)) {
      const type: MemoryType = isTaskStateCommit(entry.subject) ? "task_state" : "decision";

      if (await this.storeCommitMemory(project, entry.hash, entry.subject, type)) {
        imported += 1;
      }
    }

    return imported;
  }

  async extractFromRecentDiffs(repoPath: string, count = 10): Promise<number> {
    const absoluteRepoPath = resolve(repoPath);
    const { stdout } = await execFileAsync(
      "git",
      ["-C", absoluteRepoPath, "log", "-n", String(count), '--format=%H %s'],
      {
        encoding: "utf8"
      }
    );
    const project = basename(absoluteRepoPath);
    let imported = 0;

    for (const entry of parseGitLog(stdout)) {
      if (/^chore:/i.test(entry.subject)) {
        continue;
      }

      const type: MemoryType = isPitfallCommit(entry.subject) ? "pitfall" : "decision";

      if (await this.storeCommitMemory(project, entry.hash, entry.subject, type)) {
        imported += 1;
      }
    }

    return imported;
  }
}
