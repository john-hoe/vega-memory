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

export class DocGenerator {
  constructor(private readonly repository: Repository) {}

  generateProjectReadme(project: string): string {
    const decisions = this.repository.listMemories({
      project,
      type: "decision",
      status: "active",
      limit: 10_000,
      sort: "created_at ASC"
    });
    const pitfalls = this.repository.listMemories({
      project,
      type: "pitfall",
      status: "active",
      limit: 10_000,
      sort: "created_at ASC"
    });
    const tasks = this.repository.listMemories({
      project,
      type: "task_state",
      status: "active",
      limit: 10_000,
      sort: "updated_at DESC"
    });
    const context = this.repository.listMemories({
      project,
      type: "project_context",
      status: "active",
      limit: 10_000,
      sort: "created_at ASC"
    });
    const preferences = this.repository.listMemories({
      type: "preference",
      scope: "global",
      status: "active",
      limit: 10_000,
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
      this.repository.listMemories({
        project,
        type: "decision",
        limit: 10_000,
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
    const pitfalls = this.repository.listMemories({
      project,
      type: "pitfall",
      limit: 10_000,
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
