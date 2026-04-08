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
  status: "completed" | "failed" | "delayed" | "waiting";
  result?: unknown;
  error?: string;
}

type JobProcessor = (data: Record<string, unknown>) => Promise<unknown>;

export class TaskQueue {
  private connected: boolean;

  private nextId = 0;

  private readonly jobs = new Map<string, JobResult>();

  private readonly processors = new Map<string, JobProcessor>();

  constructor(config: QueueConfig) {
    this.connected = config.enabled;
  }

  async addJob(job: JobDefinition): Promise<JobResult> {
    const id = this.createJobId();
    const processor = this.processors.get(job.name);

    try {
      const result = processor === undefined ? undefined : await processor(job.data);
      const jobResult: JobResult = {
        id,
        name: job.name,
        status: "completed",
        ...(result === undefined ? {} : { result })
      };

      this.jobs.set(id, jobResult);
      return jobResult;
    } catch (error) {
      const jobResult: JobResult = {
        id,
        name: job.name,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      };

      this.jobs.set(id, jobResult);
      return jobResult;
    }
  }

  async addBulk(jobs: JobDefinition[]): Promise<JobResult[]> {
    return Promise.all(jobs.map(async (job) => this.addJob(job)));
  }

  async getJob(id: string): Promise<JobResult | null> {
    return this.jobs.get(id) ?? null;
  }

  async removeJob(id: string): Promise<boolean> {
    return this.jobs.delete(id);
  }

  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const stats = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0
    };

    for (const job of this.jobs.values()) {
      if (job.status === "completed") {
        stats.completed += 1;
      } else if (job.status === "failed") {
        stats.failed += 1;
      } else if (job.status === "delayed") {
        stats.delayed += 1;
      } else {
        stats.waiting += 1;
      }
    }

    return stats;
  }

  async drain(): Promise<void> {
    this.jobs.clear();
  }

  registerProcessor(name: string, fn: JobProcessor): void {
    this.processors.set(name, fn);
  }

  isConnected(): boolean {
    return this.connected;
  }

  private createJobId(): string {
    this.nextId += 1;
    return `job-${this.nextId}`;
  }
}
