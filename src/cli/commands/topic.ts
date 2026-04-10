import { Command, InvalidArgumentError } from "commander";

import { TopicService } from "../../core/topic-service.js";
import type { AuditContext, Memory, MemoryType, Topic, TunnelView } from "../../core/types.js";

const CLI_AUDIT_CONTEXT: AuditContext = { actor: "cli", ip: null };
const MEMORY_TYPES = [
  "task_state",
  "preference",
  "project_context",
  "decision",
  "pitfall",
  "insight"
] as const satisfies readonly MemoryType[];

const parseVersion = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("version must be a positive integer");
  }

  return parsed;
};

const printTopicHistoryTable = (topics: Topic[]): void => {
  console.table(
    topics.map((topic) => ({
      version: topic.version,
      state: topic.state,
      label: topic.label,
      kind: topic.kind,
      source: topic.source,
      description: topic.description ?? "",
      topic_id: topic.id
    }))
  );
};

const serializeMemory = (memory: Memory) => ({
  id: memory.id,
  tenant_id: memory.tenant_id ?? null,
  type: memory.type,
  project: memory.project,
  title: memory.title,
  content: memory.content,
  summary: memory.summary,
  importance: memory.importance,
  source: memory.source,
  tags: memory.tags,
  created_at: memory.created_at,
  updated_at: memory.updated_at,
  accessed_at: memory.accessed_at,
  access_count: memory.access_count,
  status: memory.status,
  verified: memory.verified,
  scope: memory.scope,
  accessed_projects: memory.accessed_projects,
  source_context: memory.source_context ?? null
});

const serializeTunnelView = (view: TunnelView) => ({
  topic_key: view.topic_key,
  project_count: view.project_count,
  total_memory_count: view.total_memory_count,
  projects: view.projects.map((project) => ({
    project: project.project,
    topic: project.topic,
    memory_count: project.memory_count,
    memories_by_type: Object.fromEntries(
      MEMORY_TYPES.flatMap((type) => {
        const memories = project.memories_by_type[type];
        return memories ? [[type, memories.map(serializeMemory)]] : [];
      })
    )
  })),
  common_pitfalls: view.common_pitfalls,
  common_decisions: view.common_decisions
});

const formatTypeCounts = (view: TunnelView["projects"][number]): string =>
  MEMORY_TYPES.flatMap((type) => {
    const count = view.memories_by_type[type]?.length ?? 0;
    return count > 0 ? [`${type}:${count}`] : [];
  }).join(", ");

const printTunnelView = (view: TunnelView): void => {
  if (view.projects.length === 0) {
    console.log("No cross-project tunnel data found.");
    return;
  }

  console.log(`topic_key: ${view.topic_key}`);
  console.log(`projects: ${view.project_count}`);
  console.log(`memories: ${view.total_memory_count}`);
  console.table(
    view.projects.map((project) => ({
      project: project.project,
      label: project.topic.label,
      kind: project.topic.kind,
      memory_count: project.memory_count,
      types: formatTypeCounts(project)
    }))
  );

  for (const project of view.projects) {
    const rows = MEMORY_TYPES.flatMap((type) =>
      (project.memories_by_type[type] ?? []).map((memory) => ({
        id: memory.id,
        type: memory.type,
        title: memory.title,
        updated_at: memory.updated_at
      }))
    );

    console.log(`\n[${project.project}] ${project.topic.label}`);
    if (rows.length === 0) {
      console.log("No memories.");
      continue;
    }

    console.table(rows);
  }

  if (view.common_pitfalls.length > 0) {
    console.log("\nCommon pitfalls");
    console.table(
      view.common_pitfalls.map((summary) => ({
        title: summary.title,
        projects: summary.projects.join(", "),
        occurrences: summary.occurrences
      }))
    );
  }

  if (view.common_decisions.length > 0) {
    console.log("\nCommon decisions");
    console.table(
      view.common_decisions.map((summary) => ({
        title: summary.title,
        projects: summary.projects.join(", "),
        occurrences: summary.occurrences
      }))
    );
  }
};

export function registerTopicCommand(program: Command, topicService: TopicService): void {
  const topicCommand = program.command("topic").description("Manage topic taxonomy");

  topicCommand
    .command("override")
    .description("Create a new explicit topic version and supersede the current head")
    .requiredOption("--project <project>", "project name")
    .requiredOption("--topic-key <topicKey>", "topic key to override")
    .requiredOption("--label <label>", "new topic label")
    .option("--description <description>", "new topic description")
    .option("--json", "print JSON")
    .action(
      async (options: {
        project: string;
        topicKey: string;
        label: string;
        description?: string;
        json?: boolean;
      }) => {
        const result = await topicService.overrideTopic(
          options.project,
          options.topicKey,
          options.label,
          options.description,
          CLI_AUDIT_CONTEXT
        );

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(
          `overrode ${options.project}:${options.topicKey} -> version ${result.topic.version} (${result.reassigned_memory_count} memories)`
        );
      }
    );

  topicCommand
    .command("revert")
    .description("Create a new active topic head from a historical version")
    .requiredOption("--project <project>", "project name")
    .requiredOption("--topic-key <topicKey>", "topic key to revert")
    .requiredOption("--version <version>", "historical version to restore", parseVersion)
    .option("--json", "print JSON")
    .action(
      async (options: {
        project: string;
        topicKey: string;
        version: number;
        json?: boolean;
      }) => {
        const result = await topicService.revertTopic(
          options.project,
          options.topicKey,
          options.version,
          CLI_AUDIT_CONTEXT
        );

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(
          `reverted ${options.project}:${options.topicKey} to version ${options.version} via version ${result.topic.version}`
        );
      }
    );

  topicCommand
    .command("history")
    .description("Show topic version history")
    .requiredOption("--project <project>", "project name")
    .requiredOption("--topic-key <topicKey>", "topic key")
    .option("--json", "print JSON")
    .action(
      (options: {
        project: string;
        topicKey: string;
        json?: boolean;
      }) => {
        const topics = topicService.listTopicVersions(options.project, options.topicKey);

        if (options.json) {
          console.log(JSON.stringify(topics, null, 2));
          return;
        }

        if (topics.length === 0) {
          console.log("No topic versions found.");
          return;
        }

        printTopicHistoryTable(topics);
      }
    );

  topicCommand
    .command("reassign")
    .description("Reclassify one memory from one topic key to another")
    .requiredOption("--memory <memoryId>", "memory id")
    .requiredOption("--from-topic-key <topicKey>", "current topic key")
    .requiredOption("--to-topic-key <topicKey>", "new topic key")
    .option("--json", "print JSON")
    .action(
      async (options: {
        memory: string;
        fromTopicKey: string;
        toTopicKey: string;
        json?: boolean;
      }) => {
        const result = await topicService.reassignMemoryTopic(
          options.memory,
          options.fromTopicKey,
          options.toTopicKey,
          CLI_AUDIT_CONTEXT
        );

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(
          `reassigned ${result.memory_id} from ${options.fromTopicKey} to ${options.toTopicKey}`
        );
      }
    );

  topicCommand
    .command("tunnel <topicKey>")
    .description("Show the cross-project tunnel view for a topic key")
    .option("--json", "print JSON")
    .action(
      (topicKey: string, options: { json?: boolean }) => {
        const result = topicService.getTunnelView(topicKey);

        if (options.json) {
          console.log(JSON.stringify(serializeTunnelView(result), null, 2));
          return;
        }

        printTunnelView(result);
      }
    );
}
