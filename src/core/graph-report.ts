import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { KnowledgeGraphService } from "./knowledge-graph.js";
import type { EntityRelation, GraphContentCacheRecord, GraphStats } from "./types.js";
import { Repository } from "../db/repository.js";

interface CountedEntity {
  name: string;
  type: string;
  relationCount: number;
}

interface ModuleMetrics {
  name: string;
  imports: number;
  importedBy: number;
  declares: number;
  exports: number;
}

interface DirectorySummary {
  path: string;
  fileCount: number;
  sampleFiles: string[];
}

interface DocumentSummary {
  name: string;
  topHeadings: string[];
  headingCount: number;
  definitionCount: number;
  referenceCount: number;
}

const TOP_ENTITY_LIMIT = 10;
const DIRECTORY_LIMIT = 10;
const DIRECTORY_FILE_SAMPLE_LIMIT = 3;
const MODULE_LIMIT = 10;
const MODULE_DEPENDENCY_LIMIT = 12;
const DOCUMENT_LIMIT = 8;
const DOCUMENT_HEADING_LIMIT = 5;

const normalizeGraphPath = (value: string): string => value.replaceAll("\\", "/");

const sanitizeProjectSegment = (project: string): string =>
  project.trim().replace(/[\\/]/g, "-").replace(/\s+/g, "-");

const formatCountMap = (counts: Record<string, number>): string => {
  const entries = Object.entries(counts).filter(([, value]) => value > 0);

  if (entries.length === 0) {
    return "none";
  }

  return entries
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, value]) => `\`${key}\` ${value}`)
    .join(", ");
};

const formatModuleName = (entityName: string): string =>
  entityName.startsWith("module:") ? entityName.slice("module:".length) : entityName;

const formatDocumentName = (entityName: string): string =>
  entityName.startsWith("doc:") ? entityName.slice("doc:".length) : entityName;

const parseHeadingEntity = (
  entityName: string
): { documentName: string; headingPath: string } | null => {
  if (!entityName.startsWith("heading:")) {
    return null;
  }

  const body = entityName.slice("heading:".length);
  const hashIndex = body.lastIndexOf("#");

  if (hashIndex <= 0) {
    return null;
  }

  const documentName = body.slice(0, hashIndex);
  const headingPart = body.slice(hashIndex + 1);
  const separatorIndex = headingPart.indexOf(":");

  if (separatorIndex < 0) {
    return null;
  }

  return {
    documentName,
    headingPath: headingPart.slice(separatorIndex + 1)
  };
};

const formatHeadingPath = (headingPath: string): string =>
  headingPath
    .split(">")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join(" > ");

const trimByLines = (content: string, maxLines: number): string =>
  content
    .split("\n")
    .slice(0, maxLines)
    .join("\n");

export class GraphReportService {
  private readonly knowledgeGraphService: KnowledgeGraphService;

  constructor(
    private readonly repository: Repository,
    knowledgeGraphService?: KnowledgeGraphService
  ) {
    this.knowledgeGraphService = knowledgeGraphService ?? new KnowledgeGraphService(repository);
  }

  generateGraphReport(project: string): string {
    const normalizedProject = project.trim();

    if (normalizedProject.length === 0) {
      throw new Error("project is required");
    }

    const stats = this.knowledgeGraphService.graphStats(normalizedProject);
    const relations = this.repository.listGraphRelations(normalizedProject);
    const projectMemoryIds = new Set(
      this.repository
        .listMemories({
          project: normalizedProject,
          limit: 10_000
        })
        .map((memory) => memory.id)
    );
    const codeRecords = this.filterProjectCacheRecords(
      this.repository.listGraphContentCache("code"),
      projectMemoryIds
    );
    const docRecords = this.filterProjectCacheRecords(
      this.repository.listGraphContentCache("doc"),
      projectMemoryIds
    );

    const lines = [
      `# Graph Report: ${normalizedProject}`,
      "",
      `Generated: ${new Date().toISOString()}`,
      "",
      "## Graph Summary",
      ...this.buildStatsSection(stats),
      "",
      "## Code Structure",
      ...this.buildCodeStructureSection(codeRecords, relations),
      "",
      "## Core Entities",
      ...this.buildCoreEntitiesSection(relations),
      "",
      "## Module Dependencies",
      ...this.buildModuleDependenciesSection(relations),
      "",
      "## Document Structure",
      ...this.buildDocumentStructureSection(docRecords, relations)
    ];

    return `${lines.join("\n").trim()}\n`;
  }

  saveGraphReport(project: string): { project: string; report: string; path: string } {
    const normalizedProject = project.trim();
    const report = this.generateGraphReport(normalizedProject);
    const path = resolve("data", `${sanitizeProjectSegment(normalizedProject)}-graph-report.md`);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, report, "utf8");

    return {
      project: normalizedProject,
      report,
      path
    };
  }

  private filterProjectCacheRecords(
    records: GraphContentCacheRecord[],
    projectMemoryIds: Set<string>
  ): GraphContentCacheRecord[] {
    return records.filter((record) => record.memory_ids.some((memoryId) => projectMemoryIds.has(memoryId)));
  }

  private buildStatsSection(stats: GraphStats): string[] {
    return [
      `- Total entities: ${stats.total_entities}`,
      `- Total relations: ${stats.total_relations}`,
      `- Tracked code files: ${stats.tracked_code_files}`,
      `- Tracked doc files: ${stats.tracked_doc_files}`,
      `- Entity types: ${formatCountMap(stats.entity_types)}`,
      `- Relation types: ${formatCountMap(stats.relation_types)}`,
      `- Average confidence: ${stats.average_confidence === null ? "n/a" : stats.average_confidence.toFixed(3)}`
    ];
  }

  private buildCodeStructureSection(
    codeRecords: GraphContentCacheRecord[],
    relations: EntityRelation[]
  ): string[] {
    if (codeRecords.length === 0) {
      return ["- No tracked code graph files for this project."];
    }

    const directorySummaries = this.summarizeDirectories(codeRecords);
    const moduleMetrics = this.buildTrackedModuleMetrics(codeRecords, relations);
    const lines = [
      `- ${codeRecords.length} files indexed through the code sidecar.`,
      "- Directory overview:"
    ];

    for (const summary of directorySummaries) {
      const sample =
        summary.sampleFiles.length === 0 ? "" : `: ${summary.sampleFiles.map((file) => `\`${file}\``).join(", ")}`;
      lines.push(`  - \`${summary.path}\` (${summary.fileCount} files)${sample}`);
    }

    lines.push("- Key modules:");

    for (const metric of moduleMetrics) {
      lines.push(
        `  - \`${formatModuleName(metric.name)}\` - imports ${metric.imports}, imported by ${metric.importedBy}, declares ${metric.declares}, exports ${metric.exports}`
      );
    }

    return lines;
  }

  private summarizeDirectories(codeRecords: GraphContentCacheRecord[]): DirectorySummary[] {
    const directoryMap = new Map<string, DirectorySummary>();

    for (const record of codeRecords) {
      const normalizedPath = normalizeGraphPath(record.file_path);
      const lastSlashIndex = normalizedPath.lastIndexOf("/");
      const directoryPath = lastSlashIndex < 0 ? "(root)" : normalizedPath.slice(0, lastSlashIndex);
      const fileName = lastSlashIndex < 0 ? normalizedPath : normalizedPath.slice(lastSlashIndex + 1);
      const existing = directoryMap.get(directoryPath) ?? {
        path: directoryPath,
        fileCount: 0,
        sampleFiles: []
      };

      existing.fileCount += 1;
      if (existing.sampleFiles.length < DIRECTORY_FILE_SAMPLE_LIMIT) {
        existing.sampleFiles.push(fileName);
      }
      directoryMap.set(directoryPath, existing);
    }

    return [...directoryMap.values()]
      .sort((left, right) => right.fileCount - left.fileCount || left.path.localeCompare(right.path))
      .slice(0, DIRECTORY_LIMIT);
  }

  private buildTrackedModuleMetrics(
    codeRecords: GraphContentCacheRecord[],
    relations: EntityRelation[]
  ): ModuleMetrics[] {
    const trackedModules = new Set(
      codeRecords.map((record) => `module:${normalizeGraphPath(record.file_path)}`)
    );
    const metrics = new Map<string, ModuleMetrics>();

    const ensureMetric = (name: string): ModuleMetrics => {
      const existing = metrics.get(name);

      if (existing) {
        return existing;
      }

      const created = {
        name,
        imports: 0,
        importedBy: 0,
        declares: 0,
        exports: 0
      };
      metrics.set(name, created);
      return created;
    };

    for (const relation of relations) {
      if (relation.source_entity_type === "module" && trackedModules.has(relation.source_entity_name)) {
        const source = ensureMetric(relation.source_entity_name);

        if (relation.relation_type === "imports") {
          source.imports += 1;
        } else if (relation.relation_type === "declares") {
          source.declares += 1;
        } else if (relation.relation_type === "exports") {
          source.exports += 1;
        }
      }

      if (relation.relation_type === "imports" && relation.target_entity_type === "module") {
        const targetName = relation.target_entity_name;

        if (trackedModules.has(targetName)) {
          ensureMetric(targetName).importedBy += 1;
        }
      }
    }

    return [...metrics.values()]
      .sort(
        (left, right) =>
          right.imports +
            right.importedBy +
            right.declares +
            right.exports -
            (left.imports + left.importedBy + left.declares + left.exports) ||
          formatModuleName(left.name).localeCompare(formatModuleName(right.name))
      )
      .slice(0, MODULE_LIMIT);
  }

  private buildCoreEntitiesSection(relations: EntityRelation[]): string[] {
    const countedEntities = this.countEntitiesByRelations(relations);

    if (countedEntities.length === 0) {
      return ["- No graph entities found for this project."];
    }

    return countedEntities.slice(0, TOP_ENTITY_LIMIT).map(
      (entity) =>
        `- \`${this.formatEntityName(entity.name, entity.type)}\` (${entity.type}) - ${entity.relationCount} relations`
    );
  }

  private countEntitiesByRelations(relations: EntityRelation[]): CountedEntity[] {
    const counts = new Map<string, CountedEntity>();

    const addCount = (id: string, name: string, type: string): void => {
      const existing = counts.get(id);

      if (existing) {
        existing.relationCount += 1;
        return;
      }

      counts.set(id, {
        name,
        type,
        relationCount: 1
      });
    };

    for (const relation of relations) {
      addCount(relation.source_entity_id, relation.source_entity_name, relation.source_entity_type);

      if (relation.target_entity_id !== relation.source_entity_id) {
        addCount(relation.target_entity_id, relation.target_entity_name, relation.target_entity_type);
      }
    }

    return [...counts.values()].sort(
      (left, right) =>
        right.relationCount - left.relationCount || left.name.localeCompare(right.name)
    );
  }

  private buildModuleDependenciesSection(relations: EntityRelation[]): string[] {
    const dependencies = relations
      .filter(
        (relation) =>
          relation.relation_type === "imports" &&
          relation.source_entity_type === "module" &&
          relation.target_entity_type === "module"
      )
      .map((relation) => ({
        source: formatModuleName(relation.source_entity_name),
        target: formatModuleName(relation.target_entity_name)
      }))
      .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target))
      .slice(0, MODULE_DEPENDENCY_LIMIT);

    if (dependencies.length === 0) {
      return ["- No module import edges found for this project."];
    }

    return dependencies.map(
      (dependency) => `- \`${dependency.source}\` -> \`${dependency.target}\``
    );
  }

  private buildDocumentStructureSection(
    docRecords: GraphContentCacheRecord[],
    relations: EntityRelation[]
  ): string[] {
    if (docRecords.length === 0) {
      return ["- No tracked document graph files for this project."];
    }

    const summaries = new Map<string, DocumentSummary>();

    const ensureSummary = (name: string): DocumentSummary => {
      const existing = summaries.get(name);

      if (existing) {
        return existing;
      }

      const created = {
        name,
        topHeadings: [],
        headingCount: 0,
        definitionCount: 0,
        referenceCount: 0
      };
      summaries.set(name, created);
      return created;
    };

    for (const record of docRecords) {
      ensureSummary(normalizeGraphPath(record.file_path));
    }

    for (const relation of relations) {
      if (
        relation.relation_type === "contains" &&
        relation.source_entity_type === "document" &&
        relation.target_entity_type === "heading"
      ) {
        const summary = ensureSummary(formatDocumentName(relation.source_entity_name));
        const parsedHeading = parseHeadingEntity(relation.target_entity_name);

        summary.headingCount += 1;
        if (parsedHeading && summary.topHeadings.length < DOCUMENT_HEADING_LIMIT) {
          summary.topHeadings.push(formatHeadingPath(parsedHeading.headingPath));
        }
        continue;
      }

      if (
        relation.relation_type === "contains" &&
        relation.source_entity_type === "heading" &&
        relation.target_entity_type === "heading"
      ) {
        const parsedHeading = parseHeadingEntity(relation.source_entity_name);

        if (parsedHeading) {
          ensureSummary(parsedHeading.documentName).headingCount += 1;
        }
        continue;
      }

      if (relation.source_entity_type !== "heading") {
        continue;
      }

      const parsedHeading = parseHeadingEntity(relation.source_entity_name);

      if (!parsedHeading) {
        continue;
      }

      const summary = ensureSummary(parsedHeading.documentName);

      if (relation.relation_type === "defines") {
        summary.definitionCount += 1;
      } else if (relation.relation_type === "references") {
        summary.referenceCount += 1;
      }
    }

    const ordered = [...summaries.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, DOCUMENT_LIMIT);

    return ordered.flatMap((summary) => {
      const headingPreview =
        summary.topHeadings.length === 0
          ? "no top headings captured"
          : summary.topHeadings.map((heading) => `\`${heading}\``).join(", ");

      return [
        `- \`${summary.name}\` - headings ${summary.headingCount}, terms ${summary.definitionCount}, references ${summary.referenceCount}`,
        `  - ${trimByLines(headingPreview, 1)}`
      ];
    });
  }

  private formatEntityName(name: string, type: string): string {
    if (type === "module") {
      return formatModuleName(name);
    }

    if (type === "document") {
      return formatDocumentName(name);
    }

    if (type === "heading") {
      const parsed = parseHeadingEntity(name);

      if (parsed) {
        return `${parsed.documentName} :: ${formatHeadingPath(parsed.headingPath)}`;
      }
    }

    return name;
  }
}
