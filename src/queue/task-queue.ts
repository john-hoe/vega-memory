import { RedisClient } from "../cache/redis.js";

export interface QueueConfig {
  enabled: boolean;
  redisUrl?: string;
  defaultConcurrency?: number;
}

export interface JobDefinition {
  name: string;
  data: Record<string, unknown>;
  opts?: {
    delay?: number;
    attempts?: number;
    priority?: number;
  };
}

export interface JobResult {
  id: string;
  name: string;
  status: "completed" | "failed" | "delayed" | "waiting" | "active";
  result?: unknown;
  error?: string;
}

type JobProcessor = (data: Record<string, unknown>) => Promise<unknown>;

interface StoredJob {
  definition: JobDefinition;
  result: JobResult;
  attemptsMade: number;
  runAt: number;
}

interface QueueState {
  nextId: number;
  jobs: StoredJob[];
}

const STATE_KEY = "task-queue:state";

function cloneJobResult(result: JobResult): JobResult {
  return structuredClone(result) as JobResult;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function comparePendingJobs(left: StoredJob, right: StoredJob): number {
  const leftPriority = left.definition.opts?.priority ?? 0;
  const rightPriority = right.definition.opts?.priority ?? 0;

  if (leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }

  return left.runAt - right.runAt;
}

export class TaskQueue {
  private connected = false;

  private nextId = 0;

  private readonly jobs = new Map<string, StoredJob>();

  private readonly processors = new Map<string, JobProcessor>();

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly redis: RedisClient | null;

  private readonly concurrency: number;

  private initialized = false;

  private initializing: Promise<void> | null = null;

  private activeCount = 0;

  constructor(config: QueueConfig) {
    this.concurrency = Math.max(1, Math.trunc(config.defaultConcurrency ?? 1));
    this.redis =
      config.enabled && config.redisUrl
        ? new RedisClient({
            enabled: true,
            url: config.redisUrl
          })
        : null;
    this.connected = config.enabled;
  }

  async addJob(job: JobDefinition): Promise<JobResult> {
    await this.ensureReady();

    const id = this.createJobId();
    const delay = Math.max(job.opts?.delay ?? 0, 0);
    const stored: StoredJob = {
      definition: structuredClone(job),
      result: {
        id,
        name: job.name,
        status: delay > 0 ? "delayed" : "waiting"
      },
      attemptsMade: 0,
      runAt: Date.now() + delay
    };

    this.jobs.set(id, stored);
    await this.persistState();

    if (delay > 0) {
      this.scheduleJob(id, delay);
      return cloneJobResult(stored.result);
    }

    if (this.activeCount < this.concurrency) {
      await this.runJob(stored);
    } else {
      void this.processPending();
    }

    return cloneJobResult(this.jobs.get(id)?.result ?? stored.result);
  }

  async addBulk(jobs: JobDefinition[]): Promise<JobResult[]> {
    const results: JobResult[] = [];

    for (const job of jobs) {
      results.push(await this.addJob(job));
    }

    return results;
  }

  async getJob(id: string): Promise<JobResult | null> {
    await this.ensureReady();
    return this.jobs.has(id) ? cloneJobResult(this.jobs.get(id)!.result) : null;
  }

  async removeJob(id: string): Promise<boolean> {
    await this.ensureReady();
    this.clearTimer(id);
    const deleted = this.jobs.delete(id);
    if (deleted) {
      await this.persistState();
    }
    return deleted;
  }

  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    await this.ensureReady();
    const stats = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0
    };

    for (const { result } of this.jobs.values()) {
      if (result.status === "completed") {
        stats.completed += 1;
      } else if (result.status === "failed") {
        stats.failed += 1;
      } else if (result.status === "delayed") {
        stats.delayed += 1;
      } else if (result.status === "active") {
        stats.active += 1;
      } else {
        stats.waiting += 1;
      }
    }

    return stats;
  }

  async drain(): Promise<void> {
    await this.ensureReady();
    for (const id of this.timers.keys()) {
      this.clearTimer(id);
    }
    this.jobs.clear();
    await this.persistState();
  }

  registerProcessor(name: string, fn: JobProcessor): void {
    this.processors.set(name, fn);
    void this.processPending();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async ensureReady(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initializing !== null) {
      return this.initializing;
    }

    this.initializing = (async () => {
      if (this.redis !== null) {
        try {
          await this.redis.connect();
          this.connected = this.redis.isConnected();
        } catch {
          this.connected = false;
        }
      } else {
        this.connected = false;
      }

      await this.loadState();
      this.initialized = true;
      await this.processPending();
    })();

    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  private async loadState(): Promise<void> {
    if (this.redis === null || !this.redis.isConnected()) {
      return;
    }

    const state = await this.redis.getJson<QueueState>(STATE_KEY);
    if (state === null) {
      return;
    }

    this.nextId = Math.max(0, Math.trunc(state.nextId));
    this.jobs.clear();

    for (const stored of state.jobs) {
      const normalized: StoredJob = {
        definition: stored.definition,
        result:
          stored.result.status === "active"
            ? { ...stored.result, status: "waiting" }
            : stored.result,
        attemptsMade: stored.attemptsMade,
        runAt: stored.runAt
      };
      this.jobs.set(normalized.result.id, normalized);

      if (normalized.result.status === "delayed") {
        const delay = Math.max(0, normalized.runAt - Date.now());
        this.scheduleJob(normalized.result.id, delay);
      }
    }
  }

  private async persistState(): Promise<void> {
    if (this.redis === null || !this.redis.isConnected()) {
      return;
    }

    await this.redis.setJson<QueueState>(STATE_KEY, {
      nextId: this.nextId,
      jobs: [...this.jobs.values()].map((job) => structuredClone(job))
    });
  }

  private createJobId(): string {
    this.nextId += 1;
    return `job-${this.nextId}`;
  }

  private scheduleJob(id: string, delayMs: number): void {
    this.clearTimer(id);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        const stored = this.jobs.get(id);
        if (!stored || stored.result.status !== "delayed") {
          return;
        }

        stored.result.status = "waiting";
        void this.persistState().then(async () => this.processPending());
      }, delayMs)
    );
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private async processPending(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    while (this.activeCount < this.concurrency) {
      const next = [...this.jobs.values()]
        .filter((stored) => stored.result.status === "waiting" && stored.runAt <= Date.now())
        .sort(comparePendingJobs)[0];

      if (next === undefined) {
        return;
      }

      void this.runJob(next).then(async () => this.processPending());
    }
  }

  private async runJob(stored: StoredJob): Promise<void> {
    stored.result.status = "active";
    this.activeCount += 1;
    await this.persistState();

    try {
      const processor = this.processors.get(stored.definition.name);
      const result =
        processor === undefined ? undefined : await processor(structuredClone(stored.definition.data));

      stored.result = {
        id: stored.result.id,
        name: stored.definition.name,
        status: "completed",
        ...(result === undefined ? {} : { result })
      };
    } catch (error) {
      stored.attemptsMade += 1;
      const maxAttempts = Math.max(1, stored.definition.opts?.attempts ?? 1);
      const errorMessage = getErrorMessage(error);

      if (stored.attemptsMade < maxAttempts) {
        stored.result = {
          id: stored.result.id,
          name: stored.definition.name,
          status: "waiting",
          error: errorMessage
        };
        stored.runAt = Date.now();
      } else {
        stored.result = {
          id: stored.result.id,
          name: stored.definition.name,
          status: "failed",
          error: errorMessage
        };
      }
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      await this.persistState();
      if (stored.result.status === "waiting" && stored.runAt <= Date.now()) {
        void this.processPending();
      }
    }
  }
}
