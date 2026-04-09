import { Command, InvalidArgumentError } from "commander";

import { TopicService } from "../../core/topic-service.js";
import type { AuditContext, Topic } from "../../core/types.js";

const CLI_AUDIT_CONTEXT: AuditContext = { actor: "cli", ip: null };

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
}
