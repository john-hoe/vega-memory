Task 32-36: Phase 4 — Knowledge + Multimodal (all 5 tasks).

Read AGENTS.md for rules. Read ALL src/ files to understand the current codebase.

## Task 32: Knowledge Graph Layer
Files: src/core/knowledge-graph.ts, src/db/schema.ts, src/db/repository.ts

Create an entity-relation layer on top of flat memories:

1. Add tables to schema.ts:
   - entities: id TEXT PK, name TEXT UNIQUE, type TEXT (person/project/tool/concept/file), created_at TEXT
   - relations: id TEXT PK, source_entity_id TEXT FK, target_entity_id TEXT FK, relation_type TEXT (uses/depends_on/related_to/part_of/caused_by), memory_id TEXT FK, created_at TEXT

2. Add to repository.ts:
   - createEntity(name, type): upsert entity
   - createRelation(sourceId, targetId, relationType, memoryId): insert relation
   - getEntityRelations(entityId): get all relations for an entity
   - findEntity(name): find entity by name
   - traverseGraph(entityId, depth): BFS traverse relations up to N levels

3. Create src/core/knowledge-graph.ts:
   Export class KnowledgeGraphService:
   - constructor(repository)
   - extractEntities(content: string, tags: string[]): Entity[]
     Simple rule-based extraction: tags become entities, capitalized multi-word phrases become entities
   - linkMemory(memoryId: string, entities: Entity[]): void
     Create entities and relations between them and the memory
   - query(entityName: string, depth?: number): {entity, relations, memories}
     Find entity, traverse graph, return connected memories

4. Integrate into memory.ts store():
   After storing memory, extract entities and link them

5. Add MCP tool: memory_graph — params: entity(string), depth?(number)
   Returns entity relations and connected memories

6. Add CLI command: vega graph <entity> [--depth N]

## Task 33: Code-Aware Memory (tree-sitter AST)
Files: src/core/code-index.ts

Since tree-sitter requires native bindings which are complex, implement a simpler approach:
- Create src/core/code-index.ts:
  Export class CodeIndexService:
  - constructor(repository)
  - indexFile(filePath: string): CodeSymbol[]
    Parse file using regex patterns (not full AST):
    - TypeScript/JavaScript: /export\s+(class|function|const|interface|type)\s+(\w+)/
    - Python: /^(class|def)\s+(\w+)/
    Return: [{name, kind, file, line}]
  - indexDirectory(dirPath: string, extensions: string[]): number
    Walk directory, index each file, store symbols as project_context memories
  - searchSymbol(name: string): Memory[]
    Search memories for symbol references

- Add CLI command: vega index <directory> [--ext ts,js,py]
- Store each file's symbols as a project_context memory with tags=[filename, ...symbolNames]

## Task 34: Git History Memory Source
File: src/core/git-history.ts

Export class GitHistoryService:
  - constructor(repository, memoryService)
  - extractFromGitLog(repoPath: string, since?: string, limit?: number): Promise<number>
    Run: git -C <path> log --oneline --since=<date> -n <limit>
    For each commit: extract message as a decision/task_state memory
    Deduplicate against existing memories
    Return count imported
  - extractFromRecentDiffs(repoPath: string, count?: number): Promise<number>
    Run: git -C <path> log -n <count> --format="%H %s" 
    For significant commits (not "chore:"), create pitfall/decision memories

- Add CLI command: vega git-import <repo-path> [--since 2026-01-01] [--limit 50]

## Task 35: Screenshot/Image Memory
File: src/core/image-memory.ts

Export class ImageMemoryService:
  - constructor(repository, memoryService)
  - storeScreenshot(imagePath: string, description: string, project: string): Promise<string>
    1. Read image file, compute hash for dedup
    2. Store image path + description as a project_context memory
    3. Tags: [filename, 'screenshot', project]
    4. Content: description + "\n[Image: <path>]"
    Return memory id
  - listScreenshots(project?: string): Memory[]
    List all memories with 'screenshot' tag

- Add CLI command: vega screenshot <image-path> --description "..." [--project p]
- Note: We store the file path reference, not the image binary (SQLite is for text)

## Task 36: File/Document Indexer
File: src/core/doc-index.ts

Export class DocIndexService:
  - constructor(repository, memoryService)
  - indexMarkdown(filePath: string, project: string): Promise<number>
    Parse markdown file, split by ## headings
    Each section becomes a project_context memory with L0/L1/L2 tiered content:
    - L0: heading only (~10 tokens)
    - L1: first paragraph summary (~50 tokens)
    - L2: full section content
    Store with tags=[filename, heading-keywords]
    Return count of sections indexed
  - indexDirectory(dirPath: string, project: string, extensions?: string[]): Promise<number>
    Walk directory, index .md files
    Return total sections indexed

- Add CLI command: vega index-docs <path> [--project p] [--ext md,txt]

## Tests:
File: src/tests/knowledge.test.ts
- Test: extractEntities finds tags as entities
- Test: linkMemory creates entity and relation records
- Test: traverseGraph returns connected memories at depth 1
- Test: CodeIndexService.indexFile extracts TS class/function names
- Test: GitHistoryService.extractFromGitLog creates memories from commits
- Test: DocIndexService.indexMarkdown splits by headings

After all:
  npx tsc
  node --test dist/tests/knowledge.test.js
  node --test dist/tests/*.test.js

Then commit:
  git add -A && git commit -m "feat: Phase 4 — knowledge graph, code index, git history, image memory, doc indexer"
  git push origin main
