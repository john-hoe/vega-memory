import type {
  EntityRelation,
  ExtractionMethod,
  ExtractedEntity,
  GraphQueryResult,
  RelationType,
  StructuredGraph
} from "./types.js";
import { Repository } from "../db/repository.js";

const CAPITALIZED_PHRASE_PATTERN =
  /\b(?:[A-Z][a-zA-Z0-9]+|[A-Z]{2,})(?:\s+(?:[A-Z][a-zA-Z0-9]+|[A-Z]{2,})){1,}\b/g;

const TOOL_NAMES = new Set([
  "api",
  "commander",
  "express",
  "git",
  "javascript",
  "mcp",
  "node",
  "ollama",
  "python",
  "sqlite",
  "sqlite3",
  "typescript",
  "zod"
]);

const CAPITALIZED_VERBS = new Set([
  "Add",
  "Build",
  "Create",
  "Fix",
  "Implement",
  "Remember",
  "Run",
  "Store",
  "Update",
  "Use"
]);

const FILE_PATTERN = /[\\/]|(?:\.[a-z0-9]+)$/i;
const DEFAULT_EXTRACTED_RELATION_CONFIDENCE = 1;
const DEFAULT_AMBIGUOUS_RELATION_CONFIDENCE = 0.6;
const INFERRED_RELATION_DECAY = 0.85;

const normalizeName = (value: string): string => value.trim().replace(/\s+/g, " ");

const clampConfidence = (value: number): number => Math.max(0, Math.min(1, value));

const createPairKey = (leftId: string, rightId: string): string =>
  [leftId, rightId].sort().join("\u0000");

const relatedEntityIdFor = (relation: EntityRelation, entityId: string): string =>
  relation.source_entity_id === entityId ? relation.target_entity_id : relation.source_entity_id;

interface CreateRelationOptions {
  confidence?: number;
  extraction_method?: ExtractionMethod;
}

const classifyEntity = (value: string): ExtractedEntity["type"] => {
  const normalized = normalizeName(value);
  const lower = normalized.toLowerCase();

  if (FILE_PATTERN.test(normalized)) {
    return "file";
  }

  if (TOOL_NAMES.has(lower)) {
    return "tool";
  }

  if (/\b(project|service|platform|system)\b/i.test(normalized)) {
    return "project";
  }

  return "concept";
};

const inferRelationType = (content: string): RelationType => {
  if (/\bdepends on\b/i.test(content)) {
    return "depends_on";
  }

  if (/\bpart of\b/i.test(content)) {
    return "part_of";
  }

  if (/\bcaused by\b/i.test(content)) {
    return "caused_by";
  }

  if (/\b(use|uses|using)\b/i.test(content)) {
    return "uses";
  }

  return "related_to";
};

export class KnowledgeGraphService {
  constructor(private readonly repository: Repository) {}

  createRelation(
    sourceId: string,
    targetId: string,
    relationType: RelationType,
    memoryId: string,
    options: CreateRelationOptions = {}
  ): void {
    this.repository.createRelation(
      sourceId,
      targetId,
      relationType,
      memoryId,
      clampConfidence(options.confidence ?? DEFAULT_EXTRACTED_RELATION_CONFIDENCE),
      options.extraction_method ?? "EXTRACTED"
    );
  }

  extractEntities(content: string, tags: string[]): ExtractedEntity[] {
    const entities = new Map<string, ExtractedEntity>();

    const addEntity = (name: string, type?: ExtractedEntity["type"]): void => {
      const normalized = normalizeName(name);
      if (normalized.length === 0) {
        return;
      }

      const key = normalized.toLowerCase();
      if (entities.has(key)) {
        return;
      }

      entities.set(key, {
        name: normalized,
        type: type ?? classifyEntity(normalized)
      });
    };

    for (const tag of tags) {
      addEntity(tag, classifyEntity(tag));
    }

    for (const match of content.matchAll(CAPITALIZED_PHRASE_PATTERN)) {
      const phrase = normalizeName(match[0]);
      const [firstWord] = phrase.split(/\s+/);

      if (CAPITALIZED_VERBS.has(firstWord)) {
        continue;
      }

      addEntity(phrase, classifyEntity(phrase));
    }

    return [...entities.values()];
  }

  linkMemory(memoryId: string, entities: ExtractedEntity[]): void {
    const memory = this.repository.getMemory(memoryId);
    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    const previousEntityIds = this.repository.getRelationEntityIdsForMemory(memoryId);
    this.repository.deleteSemanticRelationsForMemory(memoryId);
    this.repository.deleteInferredRelationsForMemory(memoryId);
    if (entities.length === 0) {
      this.repository.pruneEntitiesWithoutRelations(previousEntityIds);
      return;
    }

    const relationType = inferRelationType(memory.content);
    const storedEntities = entities.map((entity) =>
      this.repository.createEntity(entity.name, entity.type)
    );

    if (storedEntities.length === 1) {
      const entity = storedEntities[0];
      this.createRelation(entity.id, entity.id, relationType, memoryId, {
        confidence: DEFAULT_AMBIGUOUS_RELATION_CONFIDENCE,
        extraction_method: "AMBIGUOUS"
      });
      this.inferRelations(memoryId);
      return;
    }

    for (let leftIndex = 0; leftIndex < storedEntities.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < storedEntities.length;
        rightIndex += 1
      ) {
        this.createRelation(
          storedEntities[leftIndex].id,
          storedEntities[rightIndex].id,
          relationType,
          memoryId,
          {
            confidence: DEFAULT_AMBIGUOUS_RELATION_CONFIDENCE,
            extraction_method: "AMBIGUOUS"
          }
        );
      }
    }

    this.inferRelations(memoryId);
    this.repository.pruneEntitiesWithoutRelations(previousEntityIds);
  }

  replaceMemoryGraph(memoryId: string, graph: StructuredGraph): void {
    const memory = this.repository.getMemory(memoryId);

    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    const previousEntityIds = this.repository.getRelationEntityIdsForMemory(memoryId);
    this.repository.deleteStructuralRelationsForMemory(memoryId);
    this.repository.deleteInferredRelationsForMemory(memoryId);

    if (graph.entities.length === 0 || graph.relations.length === 0) {
      this.repository.pruneEntitiesWithoutRelations(previousEntityIds);
      return;
    }

    const entityByName = new Map(
      graph.entities.map((entity) => [
        entity.name,
        this.repository.createEntity(entity.name, entity.type, entity.metadata ?? {})
      ])
    );

    for (const relation of graph.relations) {
      const source = entityByName.get(relation.source);
      const target = entityByName.get(relation.target);

      if (!source || !target) {
        continue;
      }

      this.createRelation(source.id, target.id, relation.relation_type, memoryId, {
        confidence: relation.confidence ?? DEFAULT_EXTRACTED_RELATION_CONFIDENCE,
        extraction_method: relation.extraction_method ?? "EXTRACTED"
      });
    }

    this.inferRelations(memoryId);
    this.repository.pruneEntitiesWithoutRelations(previousEntityIds);
  }

  getStats() {
    return this.repository.getGraphStats();
  }

  inferRelations(memoryId?: string): number {
    if (memoryId === undefined) {
      return this.repository
        .listMemoryIdsWithRelations()
        .reduce((count, currentMemoryId) => count + this.inferRelations(currentMemoryId), 0);
    }

    this.repository.deleteInferredRelationsForMemory(memoryId);

    const directRelations = this.repository.listRelationsForMemory(memoryId);
    if (directRelations.length < 2) {
      return 0;
    }

    const existingPairs = new Set(
      directRelations.map((relation) =>
        createPairKey(relation.source_entity_id, relation.target_entity_id)
      )
    );
    const adjacency = new Map<string, EntityRelation[]>();
    const inferredByPair = new Map<string, number>();

    for (const relation of directRelations) {
      for (const entityId of [relation.source_entity_id, relation.target_entity_id]) {
        const entityRelations = adjacency.get(entityId) ?? [];
        entityRelations.push(relation);
        adjacency.set(entityId, entityRelations);
      }
    }

    for (const [pivotId, adjacentRelations] of adjacency.entries()) {
      for (let leftIndex = 0; leftIndex < adjacentRelations.length; leftIndex += 1) {
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < adjacentRelations.length;
          rightIndex += 1
        ) {
          const leftRelation = adjacentRelations[leftIndex];
          const rightRelation = adjacentRelations[rightIndex];
          const sourceId = relatedEntityIdFor(leftRelation, pivotId);
          const targetId = relatedEntityIdFor(rightRelation, pivotId);

          if (sourceId === targetId) {
            continue;
          }

          const pairKey = createPairKey(sourceId, targetId);
          if (existingPairs.has(pairKey)) {
            continue;
          }

          const confidence = clampConfidence(
            Math.min(leftRelation.confidence, rightRelation.confidence) * INFERRED_RELATION_DECAY
          );
          const existingConfidence = inferredByPair.get(pairKey);

          if (existingConfidence === undefined || confidence > existingConfidence) {
            inferredByPair.set(pairKey, confidence);
          }
        }
      }
    }

    for (const [pairKey, confidence] of inferredByPair.entries()) {
      const [sourceId, targetId] = pairKey.split("\u0000");
      this.createRelation(sourceId, targetId, "related_to", memoryId, {
        confidence,
        extraction_method: "INFERRED"
      });
    }

    return inferredByPair.size;
  }

  query(entityName: string, depth = 1, minConfidence = 0): GraphQueryResult {
    const entity = this.repository.findEntity(entityName);

    if (!entity) {
      return {
        entity: null,
        relations: [],
        memories: []
      };
    }

    const graph = this.repository.traverseGraph(
      entity.id,
      Math.max(0, depth),
      clampConfidence(minConfidence)
    );
    const memoryIds = [...new Set(graph.relations.map((relation) => relation.memory_id))];

    return {
      entity,
      relations: graph.relations,
      memories: this.repository.getMemoriesByIds(memoryIds)
    };
  }
}
