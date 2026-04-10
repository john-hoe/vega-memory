import { readFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";

import type { CodeSymbol, GraphDirectoryStatus, Memory, StructuredGraph } from "./types.js";
import { GraphSidecarService } from "./graph-sidecar.js";
import { MemoryService } from "./memory.js";
import { SidecarReconciler } from "./sidecar-reconciler.js";
import { isCodeGraphEnabled, type VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";

const TS_EXPORT_PATTERN =
  /export\s+(?:default\s+)?(?:async\s+)?(class|function|const|interface|type)\s+(\w+)/g;
const PYTHON_PATTERN = /^\s*(?:async\s+)?(class|def)\s+(\w+)/g;
const INDEXED_MEMORY_IMPORTANCE = 0.95;
const AST_GRAPH_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

interface CodeIndexOptions {
  graph?: boolean;
  incremental?: boolean;
}

interface TypeScriptModule {
  ScriptKind: Record<string, number>;
  ScriptTarget: Record<string, number>;
  SyntaxKind: Record<string, number>;
  createSourceFile: (
    fileName: string,
    sourceText: string,
    languageVersion: number,
    setParentNodes?: boolean,
    scriptKind?: number
  ) => {
    statements: unknown[];
  };
  canHaveModifiers: (node: unknown) => boolean;
  getModifiers: (node: unknown) => Array<{ kind: number }> | undefined;
  isImportDeclaration: (node: unknown) => node is {
    moduleSpecifier?: { text?: string };
  };
  isExportDeclaration: (node: unknown) => node is {
    moduleSpecifier?: { text?: string };
  };
  isFunctionDeclaration: (node: unknown) => node is {
    name?: { text?: string };
    parameters?: Array<{ getText?: (sourceFile: unknown) => string }>;
    type?: { getText?: (sourceFile: unknown) => string };
  };
  isClassDeclaration: (node: unknown) => node is {
    name?: { text?: string };
  };
  isVariableStatement: (node: unknown) => node is {
    declarationList: {
      declarations: Array<{
        name?: { text?: string };
        initializer?: unknown;
      }>;
    };
  };
  isIdentifier: (node: unknown) => node is { text: string };
  isArrowFunction: (node: unknown) => node is {
    parameters?: Array<{ getText?: (sourceFile: unknown) => string }>;
    type?: { getText?: (sourceFile: unknown) => string };
  };
  isFunctionExpression: (node: unknown) => node is {
    parameters?: Array<{ getText?: (sourceFile: unknown) => string }>;
    type?: { getText?: (sourceFile: unknown) => string };
  };
}

const normalizeExtensions = (extensions: string[]): Set<string> =>
  new Set(
    extensions
      .map((extension) => extension.trim().toLowerCase())
      .filter((extension) => extension.length > 0)
      .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`))
  );

const findSymbols = (content: string, filePath: string): CodeSymbol[] => {
  const extension = extname(filePath).toLowerCase();
  const lines = content.split(/\r?\n/);
  const patterns =
    extension === ".py"
      ? [{ expression: PYTHON_PATTERN }]
      : [{ expression: TS_EXPORT_PATTERN }];
  const symbols: CodeSymbol[] = [];

  lines.forEach((lineContent, index) => {
    for (const { expression } of patterns) {
      expression.lastIndex = 0;

      for (const match of lineContent.matchAll(expression)) {
        symbols.push({
          name: match[2],
          kind: match[1],
          file: filePath,
          line: index + 1
        });
      }
    }
  });

  return symbols;
};

const buildMemoryContent = (relativeFilePath: string, symbols: CodeSymbol[]): string =>
  symbols.length === 0
    ? `File: ${relativeFilePath}\nNo exported symbols found.`
    : [
        `File: ${relativeFilePath}`,
        ...symbols.map((symbol) => `${symbol.kind} ${symbol.name} line ${symbol.line}`)
      ].join("\n");

const normalizeGraphPath = (value: string): string => value.replaceAll("\\", "/");

const resolveModuleSpecifier = (
  projectRoot: string,
  filePath: string,
  moduleSpecifier: string
): string => {
  if (!moduleSpecifier.startsWith(".")) {
    return moduleSpecifier;
  }

  const resolvedPath = normalizeGraphPath(relative(projectRoot, resolve(dirname(filePath), moduleSpecifier)));

  return resolvedPath.startsWith("..") ? moduleSpecifier : resolvedPath;
};

const formatParameters = (
  parameters: Array<{ getText?: (sourceFile: unknown) => string }> | undefined,
  sourceFile: unknown
): string => (parameters ?? []).map((parameter) => parameter.getText?.(sourceFile) ?? "").join(", ");

const formatReturnType = (
  node: { type?: { getText?: (sourceFile: unknown) => string } },
  sourceFile: unknown
): string => {
  const returnType = node.type?.getText?.(sourceFile)?.trim();

  return returnType ? `: ${returnType}` : "";
};

const hasExportModifier = (ts: TypeScriptModule, node: unknown): boolean => {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }

  return (
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
  );
};

const addEntity = (
  entities: Map<string, StructuredGraph["entities"][number]>,
  name: string,
  type: StructuredGraph["entities"][number]["type"],
  metadata: Record<string, unknown> = {}
): void => {
  if (!entities.has(name)) {
    entities.set(name, { name, type, metadata });
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

const loadTypeScriptModule = async (): Promise<TypeScriptModule | null> => {
  try {
    return (await import("typescript")) as unknown as TypeScriptModule;
  } catch {
    return null;
  }
};

const getScriptKind = (ts: TypeScriptModule, extension: string): number => {
  switch (extension) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
      return ts.ScriptKind.JS;
    case ".mjs":
      return ts.ScriptKind.JS;
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
};

const extractStructuredGraph = async (
  projectRoot: string,
  filePath: string,
  relativeFilePath: string,
  content: string
): Promise<StructuredGraph> => {
  const extension = extname(filePath).toLowerCase();

  if (!AST_GRAPH_EXTENSIONS.has(extension)) {
    return {
      entities: [],
      relations: []
    };
  }

  const ts = await loadTypeScriptModule();

  if (ts === null) {
    return {
      entities: [],
      relations: []
    };
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(ts, extension)
  );
  const moduleLabel = normalizeGraphPath(relativeFilePath);
  const moduleName = `module:${moduleLabel}`;
  const entities = new Map<string, StructuredGraph["entities"][number]>();
  const relations = new Map<string, StructuredGraph["relations"][number]>();

  addEntity(entities, moduleName, "module", {
    relative_path: moduleLabel
  });

  const registerDependency = (moduleSpecifier: string | undefined): void => {
    const value = moduleSpecifier?.trim();

    if (!value) {
      return;
    }

    const dependencyLabel = resolveModuleSpecifier(projectRoot, filePath, value);
    const dependency = `module:${dependencyLabel}`;
    addEntity(entities, dependency, "module");
    addRelation(relations, moduleName, dependency, "imports");
  };

  const registerFunction = (
    name: string,
    declaration: {
      parameters?: Array<{ getText?: (sourceFile: unknown) => string }>;
      type?: { getText?: (sourceFile: unknown) => string };
    },
    exported: boolean
  ): void => {
    const parameterList = formatParameters(declaration.parameters, sourceFile);
    const signature = `${name}(${parameterList})${formatReturnType(declaration, sourceFile)}`;
    const functionName = `${signature} (${moduleLabel})`;

    addEntity(entities, functionName, "function", {
      signature,
      exported
    });
    addRelation(relations, moduleName, functionName, "declares");

    if (exported) {
      addRelation(relations, moduleName, functionName, "exports");
    }
  };

  const registerClass = (name: string, exported: boolean): void => {
    const className = `${name} (${moduleLabel})`;

    addEntity(entities, className, "class", {
      definition: `class ${name}`,
      exported
    });
    addRelation(relations, moduleName, className, "declares");

    if (exported) {
      addRelation(relations, moduleName, className, "exports");
    }
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      registerDependency(statement.moduleSpecifier?.text);
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      registerDependency(statement.moduleSpecifier?.text);
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name?.text) {
      registerFunction(statement.name.text, statement, hasExportModifier(ts, statement));
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name?.text) {
      registerClass(statement.name.text, hasExportModifier(ts, statement));
      continue;
    }

    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    const exported = hasExportModifier(ts, statement);

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        continue;
      }

      const initializer = declaration.initializer;

      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        registerFunction(declaration.name.text, initializer, exported);
      }
    }
  }

  return {
    entities: [...entities.values()],
    relations: [...relations.values()]
  };
};

export class CodeIndexService {
  constructor(
    private readonly repository: Repository,
    private readonly memoryService: MemoryService,
    private readonly config?: Pick<VegaConfig, "features">,
    private readonly graphSidecar = new GraphSidecarService(
      repository,
      new SidecarReconciler(repository)
    )
  ) {}

  indexFile(filePath: string): CodeSymbol[] {
    const absolutePath = resolve(filePath);
    const content = readFileSync(absolutePath, "utf8");

    return findSymbols(content, absolutePath);
  }

  getDirectoryStatus(dirPath: string, extensions: string[]): GraphDirectoryStatus {
    const absoluteDirectory = resolve(dirPath);
    const allowedExtensions = normalizeExtensions(extensions);

    return this.graphSidecar.scanDirectory(
      "code",
      absoluteDirectory,
      absoluteDirectory,
      allowedExtensions
    ).status;
  }

  async indexDirectory(
    dirPath: string,
    extensions: string[],
    options: CodeIndexOptions = {}
  ): Promise<number> {
    const absoluteDirectory = resolve(dirPath);
    const allowedExtensions = normalizeExtensions(extensions);
    const project = basename(absoluteDirectory);
    const graphEnabled = options.graph === true || isCodeGraphEnabled(this.config);
    const cacheEnabled = graphEnabled || options.incremental === true;
    const scan = this.graphSidecar.scanDirectory(
      "code",
      absoluteDirectory,
      absoluteDirectory,
      allowedExtensions
    );
    const filesToProcess =
      cacheEnabled ? [...scan.new_files, ...scan.modified_files] : scan.current_files;
    const existingByTitle = new Map(
      this.repository
        .listMemories({
          project,
          type: "project_context",
          limit: 10_000
        })
        .map((memory) => [memory.title, memory])
    );
    let indexedFiles = 0;

    for (const file of filesToProcess) {
      const filePath = file.absolute_path;
      const relativeFilePath = file.file_path;
      const content = readFileSync(filePath, "utf8");

      const symbols = findSymbols(content, resolve(filePath));
      const title = `Code Index: ${relativeFilePath}`;
      const indexedContent = buildMemoryContent(relativeFilePath, symbols);
      const tags = [basename(filePath), ...symbols.map((symbol) => symbol.name)];
      const existing = existingByTitle.get(title);
      let indexedMemory = existing ?? null;

      if (existing) {
        await this.memoryService.update(existing.id, {
          content: indexedContent,
          tags,
          importance: INDEXED_MEMORY_IMPORTANCE
        });
        const refreshed = this.repository.getMemory(existing.id);
        if (refreshed) {
          existingByTitle.set(title, refreshed);
          indexedMemory = refreshed;
        }
      } else {
        const result = await this.memoryService.store({
          title,
          content: indexedContent,
          type: "project_context",
          project,
          tags,
          importance: INDEXED_MEMORY_IMPORTANCE,
          source: "explicit",
          skipSimilarityCheck: true
        });
        const created = this.repository.getMemory(result.id);
        if (created) {
          existingByTitle.set(title, created);
          indexedMemory = created;
        }
      }

      if (graphEnabled && indexedMemory) {
        try {
          this.graphSidecar.syncFileGraph({
            kind: "code",
            scopeKey: absoluteDirectory,
            relativePath: relativeFilePath,
            hash: file.content_hash,
            itemCount: 1,
            memoryIds: [indexedMemory.id],
            lastModifiedMs: file.last_modified_ms,
            memoryGraphs: [
              {
                memoryId: indexedMemory.id,
                graph: await extractStructuredGraph(
                  absoluteDirectory,
                  filePath,
                  relativeFilePath,
                  content
                )
              }
            ]
          });
        } catch (error) {
          this.repository.logAudit({
            timestamp: new Date().toISOString(),
            actor: "system",
            action: "code_graph_sidecar_failed",
            memory_id: indexedMemory.id,
            detail: error instanceof Error ? error.message : String(error),
            ip: null,
            tenant_id: indexedMemory.tenant_id ?? null
          });
        }
      } else if (indexedMemory && options.incremental === true) {
        this.graphSidecar.syncFileCache({
          kind: "code",
          scopeKey: absoluteDirectory,
          relativePath: relativeFilePath,
          hash: file.content_hash,
          itemCount: 1,
          memoryIds: [indexedMemory.id],
          lastModifiedMs: file.last_modified_ms
        });
      }

      indexedFiles += 1;
    }

    if (cacheEnabled) {
      this.graphSidecar.cleanupDeletedFiles(scan.deleted_files);
    }

    return indexedFiles;
  }

  searchSymbol(name: string): Memory[] {
    const needle = name.trim().toLowerCase();

    return this.repository
      .listMemories({
        type: "project_context",
        limit: 10_000
      })
      .filter((memory) => {
        if (!memory.title.startsWith("Code Index: ")) {
          return false;
        }

        return (
          memory.title.toLowerCase().includes(needle) ||
          memory.content.toLowerCase().includes(needle) ||
          memory.tags.some((tag) => tag.toLowerCase().includes(needle))
        );
      });
  }
}
