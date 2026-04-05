import type { Memory } from "./types.js";
import { Repository } from "../db/repository.js";

const normalizeParagraph = (value: string): string => value.trim().replace(/\s+/g, " ");

const toBulletList = (
  memories: Memory[],
  render: (memory: Memory) => string = (memory) =>
    `- **${memory.title}**: ${normalizeParagraph(memory.content)}`
): string => {
  if (memories.length === 0) {
    return "- None recorded.";
  }

  return memories.map(render).join("\n");
};

const toSection = (heading: string, content: string): string => `## ${heading}\n\n${content}`;

const sortChronologically = (memories: Memory[]): Memory[] =>
  [...memories].sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));

const isUsableForDocs = (memory: Memory): boolean =>
  memory.status === "active" &&
  memory.verified !== "rejected" &&
  memory.verified !== "conflict";

export class DocGenerator {
  constructor(private readonly repository: Repository) {}

  private listDocMemories(filters: {
    project?: string;
    type: Memory["type"];
    scope?: Memory["scope"];
    sort: string;
  }): Memory[] {
    return this.repository
      .listMemories({
        ...filters,
        status: "active",
        limit: 10_000
      })
      .filter(isUsableForDocs);
  }

  generateProjectReadme(project: string): string {
    const decisions = this.listDocMemories({
      project,
      type: "decision",
      sort: "created_at ASC"
    });
    const pitfalls = this.listDocMemories({
      project,
      type: "pitfall",
      sort: "created_at ASC"
    });
    const tasks = this.listDocMemories({
      project,
      type: "task_state",
      sort: "updated_at DESC"
    });
    const context = this.listDocMemories({
      project,
      type: "project_context",
      sort: "created_at ASC"
    });
    const preferences = this.listDocMemories({
      type: "preference",
      scope: "global",
      sort: "importance DESC"
    });

    return [
      `# ${project} README`,
      toSection("Architecture Decisions", toBulletList(decisions)),
      toSection("Known Pitfalls", toBulletList(pitfalls)),
      toSection(
        "Active Tasks",
        toBulletList(tasks, (memory) => `- [ ] **${memory.title}**: ${normalizeParagraph(memory.content)}`)
      ),
      toSection("Project Context", toBulletList(context)),
      toSection("Preferences", toBulletList(preferences))
    ].join("\n\n");
  }

  generateDecisionLog(project: string): string {
    const decisions = sortChronologically(
      this.listDocMemories({
        project,
        type: "decision",
        sort: "created_at ASC"
      })
    );

    const body =
      decisions.length === 0
        ? "No decisions recorded."
        : decisions
            .map(
              (memory) =>
                `## ${memory.created_at.slice(0, 10)} - ${memory.title}\n\nReasoning: ${normalizeParagraph(memory.content)}`
            )
            .join("\n\n");

    return `# ${project} Decision Log\n\n${body}`;
  }

  generatePitfallGuide(project: string): string {
    const pitfalls = this.listDocMemories({
      project,
      type: "pitfall",
      sort: "created_at ASC"
    });
    const grouped = new Map<string, Memory[]>();

    for (const pitfall of pitfalls) {
      const tags = pitfall.tags.length > 0 ? pitfall.tags : ["untagged"];

      for (const tag of tags) {
        const tagGroup = grouped.get(tag) ?? [];
        tagGroup.push(pitfall);
        grouped.set(tag, tagGroup);
      }
    }

    const sections =
      grouped.size === 0
        ? ["No pitfalls recorded."]
        : [...grouped.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(
              ([tag, items]) =>
                `## ${tag}\n\n${toBulletList(
                  items,
                  (memory) => `- **${memory.title}**: ${normalizeParagraph(memory.content)}`
                )}`
            );

    return [`# ${project} Pitfall Guide`, ...sections].join("\n\n");
  }
}
