import type { VegaConfig } from "../config.js";
import type { MemorySource, Topic } from "./types.js";
import { Repository } from "../db/repository.js";

export class TopicService {
  constructor(
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {}

  /** Attach an active topic assignment to a stored memory. */
  async assignTopic(
    memoryId: string,
    topicKey: string,
    source: MemorySource
  ): Promise<void> {
    void this.repository;
    void this.config;
    throw new Error(`Topic assignment is not implemented for ${memoryId}:${topicKey}:${source}`);
  }

  /** Infer the best topic key for a memory payload. */
  async inferTopic(content: string, tags: string[], project: string): Promise<string | null> {
    void this.repository;
    void this.config;
    throw new Error(`Topic inference is not implemented for project ${project}`);
  }

  /** List active taxonomy rows for a project. */
  listTopics(project: string): Topic[] {
    void this.repository;
    void this.config;
    throw new Error(`Topic listing is not implemented for project ${project}`);
  }

  /** Replace the active topic assignment with an explicit override. */
  async overrideTopic(memoryId: string, newTopicKey: string): Promise<void> {
    void this.repository;
    void this.config;
    throw new Error(`Topic override is not implemented for ${memoryId}:${newTopicKey}`);
  }
}
