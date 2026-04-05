import { randomUUID } from "node:crypto";

import type { VegaConfig } from "../config.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";

export interface MemoryTemplate {
  name: string;
  description: string;
  rules: string[];
  tags: string[];
}

const STARTER_TEMPLATES: MemoryTemplate[] = [
  {
    name: "frontend-dev",
    description: "React and Vue focused preferences for frontend implementation work.",
    rules: [
      "Exclude raw build logs and screenshot-only debugging notes unless they capture a durable UI pitfall.",
      "Prefer storing reusable UI decisions, accessibility constraints, and component interaction contracts.",
      "Tag recurring frontend issues with react, vue, css, performance, accessibility, or hydration when relevant."
    ],
    tags: ["template", "frontend", "react", "vue", "pitfalls"]
  },
  {
    name: "backend-dev",
    description: "Node.js and Python backend preferences for service and API development.",
    rules: [
      "Store API contracts, migration notes, and failure patterns that affect repeated backend work.",
      "Exclude one-off operational commands unless they reveal a persistent service, database, or deployment issue.",
      "Tag durable backend knowledge with node, python, api, database, queue, or auth when applicable."
    ],
    tags: ["template", "backend", "node", "python", "api"]
  },
  {
    name: "devops",
    description: "Docker, Kubernetes, CI, and release workflow preferences for ops-heavy projects.",
    rules: [
      "Store CI failures only when the root cause or remediation is reusable across runs.",
      "Prefer explicit memories for deployment checklists, rollback procedures, and infrastructure constraints.",
      "Tag durable operations knowledge with docker, kubernetes, ci, release, monitoring, or incident."
    ],
    tags: ["template", "devops", "docker", "kubernetes", "ci"]
  }
];

const now = (): string => new Date().toISOString();

const hasTemplateRule = (memory: Memory, templateName: string, rule: string): boolean =>
  memory.type === "preference" &&
  memory.tags.includes("template") &&
  memory.tags.includes(templateName) &&
  memory.content === rule;

export class TemplateMarketplace {
  constructor(private readonly _config: VegaConfig) {}

  async listTemplates(): Promise<MemoryTemplate[]> {
    return STARTER_TEMPLATES.map((template) => ({
      ...template,
      rules: [...template.rules],
      tags: [...template.tags]
    }));
  }

  async installTemplate(name: string, repository: Repository): Promise<number> {
    const normalizedName = name.trim();
    const template = STARTER_TEMPLATES.find((candidate) => candidate.name === normalizedName);

    if (!template) {
      throw new Error(`Unknown template: ${normalizedName}`);
    }

    const existing = repository.listMemories({
      type: "preference",
      scope: "global",
      limit: 10_000
    });
    let installed = 0;

    for (const [index, rule] of template.rules.entries()) {
      if (existing.some((memory) => hasTemplateRule(memory, template.name, rule))) {
        continue;
      }

      const timestamp = now();

      repository.createMemory({
        id: randomUUID(),
        type: "preference",
        project: template.name,
        title: `Template ${template.name} Rule ${index + 1}`,
        content: rule,
        embedding: null,
        importance: 0.95,
        source: "explicit",
        tags: [...template.tags, template.name],
        created_at: timestamp,
        updated_at: timestamp,
        accessed_at: timestamp,
        status: "active",
        verified: "verified",
        scope: "global",
        accessed_projects: [template.name]
      });
      installed += 1;
    }

    return installed;
  }
}
