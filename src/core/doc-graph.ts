import type { StructuredGraph } from "./types.js";

export interface IndexedDocSection {
  heading: string;
  content: string;
  memoryId: string;
  ordinal: number;
}

interface PendingReference {
  link: string;
  sourceEntity: string;
}

const HEADING_PATTERN = /^(#{3,6})\s+(.+?)\s*$/;
const CROSS_REFERENCE_PATTERN = /\[\[([^[\]]+)\]\]/g;
const TERM_DEFINITION_PATTERN = /^(?:\*\*)?([A-Z][A-Za-z0-9 _/-]{1,80})(?:\*\*)?:\s+.+$/;

const normalizeDocumentName = (sourceLabel: string): string => sourceLabel.replaceAll("\\", "/");

const normalizeLookupKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const createDocumentEntity = (documentName: string): string => `doc:${documentName}`;

const createHeadingEntity = (
  documentName: string,
  headingPath: string[],
  ordinal: string
): string => `heading:${documentName}#${ordinal}:${headingPath.join(" > ")}`;

const createReferenceEntity = (link: string): string =>
  `doc:${link.trim().replace(/\s+/g, " ")}`;

const createTermEntity = (term: string): string =>
  `term:${normalizeLookupKey(term).replaceAll(" ", "-")}`;

const addEntity = (
  entities: Map<string, StructuredGraph["entities"][number]>,
  name: string,
  type: StructuredGraph["entities"][number]["type"]
): void => {
  if (!entities.has(name)) {
    entities.set(name, { name, type });
  }
};

const addRelation = (
  relations: Map<string, StructuredGraph["relations"][number]>,
  source: string,
  target: string,
  relationType: StructuredGraph["relations"][number]["relation_type"]
): void => {
  const key = `${source}\u0000${target}\u0000${relationType}`;

  if (!relations.has(key)) {
    relations.set(key, {
      source,
      target,
      relation_type: relationType
    });
  }
};

export const extractStructuredDocGraphs = (
  sourceLabel: string,
  sections: IndexedDocSection[]
): Array<{ memoryId: string; graph: StructuredGraph }> => {
  const documentName = normalizeDocumentName(sourceLabel);
  const documentEntity = createDocumentEntity(documentName);
  const headingIndex = new Map<string, string>();
  const termIndex = new Map<string, string>();
  const pendingReferencesByMemory = new Map<string, PendingReference[]>();
  const memoryGraphs = new Map<
    string,
    {
      entities: Map<string, StructuredGraph["entities"][number]>;
      relations: Map<string, StructuredGraph["relations"][number]>;
    }
  >();

  for (const section of sections) {
    const entities = new Map<string, StructuredGraph["entities"][number]>();
    const relations = new Map<string, StructuredGraph["relations"][number]>();
    const lines = section.content.split(/\r?\n/);
    const sectionPath = [section.heading];
    const sectionEntity = createHeadingEntity(documentName, sectionPath, String(section.ordinal));
    const headingStack: Array<{
      level: number;
      entityName: string;
      path: string[];
      ordinal: string;
    }> = [
      {
        level: 2,
        entityName: sectionEntity,
        path: sectionPath,
        ordinal: String(section.ordinal)
      }
    ];
    let activeHeadingEntity = sectionEntity;
    let nestedHeadingCount = 0;

    addEntity(entities, documentEntity, "document");
    addEntity(entities, sectionEntity, "heading");
    addRelation(relations, documentEntity, sectionEntity, "contains");
    headingIndex.set(normalizeLookupKey(section.heading), sectionEntity);

    for (const line of lines) {
      const headingMatch = HEADING_PATTERN.exec(line.trim());

      if (headingMatch) {
        const level = headingMatch[1].length;
        const headingText = headingMatch[2].trim();

        nestedHeadingCount += 1;

        while (
          headingStack.length > 0 &&
          headingStack[headingStack.length - 1]!.level >= level
        ) {
          headingStack.pop();
        }

        const parent = headingStack[headingStack.length - 1] ?? {
          level: 2,
          entityName: sectionEntity,
          path: sectionPath,
          ordinal: String(section.ordinal)
        };
        const headingPath = [...parent.path, headingText];
        const headingEntity = createHeadingEntity(
          documentName,
          headingPath,
          `${section.ordinal}.${nestedHeadingCount}`
        );

        addEntity(entities, headingEntity, "heading");
        addRelation(relations, parent.entityName, headingEntity, "contains");
        headingStack.push({
          level,
          entityName: headingEntity,
          path: headingPath,
          ordinal: `${section.ordinal}.${nestedHeadingCount}`
        });
        headingIndex.set(normalizeLookupKey(headingText), headingEntity);
        activeHeadingEntity = headingEntity;
        continue;
      }

      const definitionMatch = TERM_DEFINITION_PATTERN.exec(line.trim());

      if (definitionMatch) {
        const term = definitionMatch[1].trim();
        const termEntity = createTermEntity(term);

        addEntity(entities, termEntity, "term");
        addRelation(relations, activeHeadingEntity, termEntity, "defines");
        termIndex.set(normalizeLookupKey(term), termEntity);
      }

      for (const match of line.matchAll(CROSS_REFERENCE_PATTERN)) {
        const link = match[1]?.trim();

        if (!link) {
          continue;
        }

        const references = pendingReferencesByMemory.get(section.memoryId) ?? [];
        references.push({
          link,
          sourceEntity: activeHeadingEntity
        });
        pendingReferencesByMemory.set(section.memoryId, references);
      }
    }

    memoryGraphs.set(section.memoryId, {
      entities,
      relations
    });
  }

  for (const [memoryId, pendingReferences] of pendingReferencesByMemory.entries()) {
    const graph = memoryGraphs.get(memoryId);

    if (!graph) {
      continue;
    }

    for (const pending of pendingReferences) {
      const lookupKey = normalizeLookupKey(pending.link);
      const targetEntity =
        termIndex.get(lookupKey) ??
        headingIndex.get(lookupKey) ??
        createReferenceEntity(pending.link);
      const targetType =
        termIndex.has(lookupKey) ? "term" : headingIndex.has(lookupKey) ? "heading" : "document";

      addEntity(graph.entities, targetEntity, targetType);
      addRelation(graph.relations, pending.sourceEntity, targetEntity, "references");
    }
  }

  return sections.map((section) => {
    const graph = memoryGraphs.get(section.memoryId);

    return {
      memoryId: section.memoryId,
      graph: {
        entities: graph ? [...graph.entities.values()] : [],
        relations: graph ? [...graph.relations.values()] : []
      }
    };
  });
};
