import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import ts from "typescript";
import {
  type DependencyEdgeKind,
  type DependencyGraphEdge,
  type DependencyGraphFile,
  type DependencyGraphSymbol,
  dependencyGraphSymbolStableIdentity,
  type ExtractedDependencyGraph,
} from "./types";

const ignoredDirectoryNames = new Set([".git", "node_modules", "dist", "build", ".turbo"]);

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");

const normalizePath = (path: string) => path.split(sep).join("/");

const relativePath = (repoRoot: string, path: string) => normalizePath(relative(repoRoot, path));

const readDirectoryRecursive = (root: string): ReadonlyArray<string> => {
  const files: Array<string> = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (ignoredDirectoryNames.has(entry)) {
        continue;
      }
      const path = join(directory, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
};

const isSourceFilePath = (path: string) =>
  /\.(?:ts|tsx|mts|cts)$/.test(path) && !path.endsWith(".d.ts");

const discoverTsconfigPaths = (repoRoot: string) =>
  readDirectoryRecursive(repoRoot)
    .filter((path) => path.endsWith("tsconfig.json"))
    .sort((a, b) => a.localeCompare(b));

const parseTsconfig = (repoRoot: string, tsconfigPath: string) => {
  const configText = ts.sys.readFile(tsconfigPath);
  if (!configText) {
    return null;
  }
  const parsedConfig = ts.parseConfigFileTextToJson(tsconfigPath, configText);
  if (parsedConfig.error) {
    return null;
  }
  const parsed = ts.parseJsonConfigFileContent(
    parsedConfig.config,
    ts.sys,
    resolve(tsconfigPath, ".."),
    { noEmit: true, skipLibCheck: true },
    tsconfigPath,
  );
  const fileNames = parsed.fileNames
    .filter((path) => path.startsWith(repoRoot))
    .filter(isSourceFilePath)
    .filter(
      (path) =>
        !relativePath(repoRoot, path)
          .split("/")
          .some((part) => ignoredDirectoryNames.has(part)),
    );
  return {
    tsconfigPath,
    fileNames,
    options: parsed.options,
  };
};

const fallbackProgramConfig = (repoRoot: string) => ({
  tsconfigPath: "<inferred>",
  fileNames: readDirectoryRecursive(repoRoot).filter(isSourceFilePath),
  options: {
    allowJs: false,
    esModuleInterop: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  } satisfies ts.CompilerOptions,
});

const discoverProgramConfigs = (repoRoot: string) => {
  const configs = discoverTsconfigPaths(repoRoot)
    .map((path) => parseTsconfig(repoRoot, path))
    .filter((config): config is NonNullable<typeof config> => config !== null)
    .filter((config) => config.fileNames.length > 0);
  return configs.length > 0 ? configs : [fallbackProgramConfig(repoRoot)];
};

const rangeForNode = (sourceFile: ts.SourceFile, node: ts.Node) => {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
};

const hasExportModifier = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

const declarationName = (
  node: ts.Node,
): ts.Identifier | ts.PrivateIdentifier | ts.StringLiteral | null => {
  if (
    (ts.isClassDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)) &&
    node.name
  ) {
    return node.name;
  }
  if (
    (ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isImportSpecifier(node) ||
      ts.isImportClause(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportEqualsDeclaration(node)) &&
    node.name &&
    (ts.isIdentifier(node.name) ||
      ts.isPrivateIdentifier(node.name) ||
      ts.isStringLiteral(node.name))
  ) {
    return node.name;
  }
  return null;
};

const symbolKind = (node: ts.Node) => ts.SyntaxKind[node.kind] ?? "Unknown";

const isFunctionValuedVariableDeclaration = (node: ts.Node) =>
  ts.isVariableDeclaration(node) &&
  node.initializer &&
  (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));

const isModuleScopeVariableDeclaration = (node: ts.Node) =>
  ts.isVariableDeclaration(node) &&
  ts.isVariableDeclarationList(node.parent) &&
  ts.isVariableStatement(node.parent.parent) &&
  ts.isSourceFile(node.parent.parent.parent);

const isVariableDeclarationOwner = (node: ts.Node) =>
  isFunctionValuedVariableDeclaration(node) || isModuleScopeVariableDeclaration(node);

const symbolKeyFor = (input: {
  readonly repoRoot: string;
  readonly tsconfigPath: string;
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly start: number;
  readonly declarationHash: string;
}) =>
  sha256(
    [
      input.repoRoot,
      input.tsconfigPath,
      input.path,
      input.kind,
      input.name,
      String(input.start),
      input.declarationHash,
    ].join("\0"),
  );

const edgeKeyFor = (edge: Omit<DependencyGraphEdge, "edgeKey">) =>
  sha256(
    [
      edge.fromSymbolKey,
      edge.toSymbolKey,
      edge.kind,
      edge.sourcePath,
      String(edge.sourceStartLine),
      String(edge.sourceStartColumn),
    ].join("\0"),
  );

const resolveAliasedSymbol = (checker: ts.TypeChecker, symbol: ts.Symbol | undefined) => {
  if (!symbol) {
    return undefined;
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      return checker.getAliasedSymbol(symbol);
    } catch {
      return symbol;
    }
  }
  return symbol;
};

const symbolIdentityForDeclaration = (
  repoRoot: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
) => {
  const name = declarationName(node);
  const range = rangeForNode(sourceFile, node);
  return name
    ? dependencyGraphSymbolStableIdentity({
        path: relativePath(repoRoot, sourceFile.fileName),
        name: name.getText(sourceFile),
        kind: symbolKind(node),
        startLine: range.startLine,
        startColumn: range.startColumn,
      })
    : undefined;
};

export const extractDependencyGraph = (repoRootInput: string): ExtractedDependencyGraph => {
  const repoRoot = resolve(repoRootInput);
  const configs = discoverProgramConfigs(repoRoot);
  const files = new Map<string, DependencyGraphFile>();
  const symbols = new Map<string, DependencyGraphSymbol>();
  const edges = new Map<string, DependencyGraphEdge>();
  const symbolIdentityToKeys = new Map<string, Set<string>>();
  const scopedSymbolIdentityToKey = new Map<string, string>();
  const pendingEdges: Array<
    Omit<DependencyGraphEdge, "edgeKey" | "toSymbolKey"> & {
      readonly tsconfigPath: string;
      readonly toIdentity: string;
    }
  > = [];
  const ambiguousPendingIdentities = new Map<string, number>();
  const scopedIdentity = (tsconfigPath: string, identity: string) =>
    [tsconfigPath, identity].join("\0");
  const rememberSymbolIdentity = (tsconfigPath: string, identity: string, symbolKey: string) => {
    scopedSymbolIdentityToKey.set(scopedIdentity(tsconfigPath, identity), symbolKey);
    const keys = symbolIdentityToKeys.get(identity) ?? new Set<string>();
    keys.add(symbolKey);
    symbolIdentityToKeys.set(identity, keys);
  };
  const symbolKeysForIdentity = (identity: string) => [
    ...(symbolIdentityToKeys.get(identity) ?? []),
  ];
  const uniqueSymbolKeyForIdentity = (identity: string) => {
    const keys = symbolKeysForIdentity(identity);
    return keys.length === 1 ? keys[0] : undefined;
  };
  const addResolvedEdge = (edge: Omit<DependencyGraphEdge, "edgeKey">) => {
    if (edge.fromSymbolKey === edge.toSymbolKey) {
      return;
    }
    edges.set(edgeKeyFor(edge), { edgeKey: edgeKeyFor(edge), ...edge });
  };

  for (const config of configs) {
    const program = ts.createProgram(config.fileNames, config.options);
    const checker = program.getTypeChecker();
    const sourceFiles = program
      .getSourceFiles()
      .filter((sourceFile) => !sourceFile.isDeclarationFile)
      .filter((sourceFile) => sourceFile.fileName.startsWith(repoRoot))
      .filter((sourceFile) => config.fileNames.includes(sourceFile.fileName));
    const programSymbolToKey = new Map<ts.Symbol, string>();

    for (const sourceFile of sourceFiles) {
      const path = relativePath(repoRoot, sourceFile.fileName);
      const contentHash = sha256(sourceFile.text);
      const fileKey = sha256([repoRoot, path, contentHash, config.tsconfigPath].join("\0"));
      files.set(fileKey, {
        fileKey,
        repoRoot,
        path,
        contentHash,
        tsconfigPath:
          config.tsconfigPath === "<inferred>"
            ? config.tsconfigPath
            : relativePath(repoRoot, config.tsconfigPath),
      });

      const visitDeclarations = (node: ts.Node) => {
        const name = declarationName(node);
        if (name) {
          const symbol = checker.getSymbolAtLocation(name);
          if (symbol) {
            const range = rangeForNode(sourceFile, node);
            const kind = symbolKind(node);
            const declarationHash = sha256(node.getText(sourceFile));
            const identity = dependencyGraphSymbolStableIdentity({
              path,
              name: name.getText(sourceFile),
              kind,
              startLine: range.startLine,
              startColumn: range.startColumn,
            });
            const symbolKey = symbolKeyFor({
              repoRoot,
              tsconfigPath: config.tsconfigPath,
              path,
              name: name.getText(sourceFile),
              kind,
              start: node.getStart(sourceFile),
              declarationHash,
            });
            programSymbolToKey.set(symbol, symbolKey);
            rememberSymbolIdentity(config.tsconfigPath, identity, symbolKey);
            symbols.set(symbolKey, {
              symbolKey,
              fileKey,
              name: name.getText(sourceFile),
              qualifiedName: checker.getFullyQualifiedName(symbol).replace(/^".*"\./, ""),
              kind,
              path,
              ...range,
              exported: hasExportModifier(node) || hasExportModifier(node.parent),
              metadataJson: JSON.stringify({ tsconfigPath: config.tsconfigPath }),
            });
          }
        }
        ts.forEachChild(node, visitDeclarations);
      };
      visitDeclarations(sourceFile);
    }

    const refForSymbol = (symbol: ts.Symbol | undefined) => {
      const resolvedSymbol = resolveAliasedSymbol(checker, symbol);
      if (!resolvedSymbol) {
        return {};
      }
      const symbolKey = programSymbolToKey.get(resolvedSymbol);
      if (symbolKey) {
        return { symbolKey };
      }
      let unresolvedIdentity: string | undefined;
      for (const declaration of resolvedSymbol.declarations ?? []) {
        const sourceFile = declaration.getSourceFile();
        if (!sourceFile.fileName.startsWith(repoRoot)) {
          continue;
        }
        const identity = symbolIdentityForDeclaration(repoRoot, sourceFile, declaration);
        if (!identity) {
          continue;
        }
        const identitySymbolKey =
          scopedSymbolIdentityToKey.get(scopedIdentity(config.tsconfigPath, identity)) ??
          uniqueSymbolKeyForIdentity(identity);
        if (identitySymbolKey) {
          return { symbolKey: identitySymbolKey, identity };
        }
        unresolvedIdentity ??= identity;
      }
      return unresolvedIdentity ? { identity: unresolvedIdentity } : {};
    };
    const keyForSymbol = (symbol: ts.Symbol | undefined) => refForSymbol(symbol).symbolKey;

    const addEdge = (
      sourceFile: ts.SourceFile,
      fromSymbolKey: string | undefined,
      to: ReturnType<typeof refForSymbol>,
      kind: DependencyEdgeKind,
      node: ts.Node,
    ) => {
      if (!fromSymbolKey || (!to.symbolKey && !to.identity)) {
        return;
      }
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const edgeBase = {
        fromSymbolKey,
        kind,
        sourcePath: relativePath(repoRoot, sourceFile.fileName),
        sourceStartLine: position.line + 1,
        sourceStartColumn: position.character + 1,
        metadataJson: "{}",
      } satisfies Omit<DependencyGraphEdge, "edgeKey" | "toSymbolKey">;
      if (to.symbolKey) {
        addResolvedEdge({ ...edgeBase, toSymbolKey: to.symbolKey });
      } else if (to.identity) {
        pendingEdges.push({
          ...edgeBase,
          tsconfigPath: config.tsconfigPath,
          toIdentity: to.identity,
        });
      }
    };

    const nearestOwnerKey = (node: ts.Node) => {
      let current: ts.Node | undefined = node;
      while (current) {
        const name = declarationName(current);
        if (
          name &&
          !ts.isParameter(current) &&
          (!ts.isVariableDeclaration(current) || isVariableDeclarationOwner(current))
        ) {
          const key = keyForSymbol(checker.getSymbolAtLocation(name));
          if (key) {
            return key;
          }
        }
        current = current.parent;
      }
      return undefined;
    };

    const addImportEdge = (sourceFile: ts.SourceFile, node: ts.Node) => {
      if (!ts.isImportSpecifier(node) && !ts.isNamespaceImport(node) && !ts.isImportClause(node)) {
        return false;
      }
      const localName = node.name;
      const importedName = ts.isImportSpecifier(node)
        ? (node.propertyName ?? node.name)
        : node.name;
      addEdge(
        sourceFile,
        localName ? keyForSymbol(checker.getSymbolAtLocation(localName)) : undefined,
        importedName ? refForSymbol(checker.getSymbolAtLocation(importedName)) : {},
        "import",
        node,
      );
      return true;
    };

    const addExportEdge = (sourceFile: ts.SourceFile, node: ts.Node) => {
      if (!ts.isExportSpecifier(node)) {
        return false;
      }
      const owner = nearestOwnerKey(node);
      const target = refForSymbol(checker.getSymbolAtLocation(node.propertyName ?? node.name));
      addEdge(sourceFile, owner ?? target.symbolKey, target, "export", node);
      return true;
    };

    const expressionReferenceTarget = (sourceFile: ts.SourceFile, expression: ts.Expression) =>
      checker.getSymbolAtLocation(
        ts.isPropertyAccessExpression(expression)
          ? expression.name
          : (expression.getLastToken(sourceFile) ?? expression),
      );

    const addCallOrConstructEdge = (sourceFile: ts.SourceFile, node: ts.Node) => {
      if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) {
        return false;
      }
      addEdge(
        sourceFile,
        nearestOwnerKey(node),
        refForSymbol(expressionReferenceTarget(sourceFile, node.expression)),
        ts.isCallExpression(node) ? "call" : "construct",
        node.expression,
      );
      return true;
    };

    const addHeritageOrTypeArgumentEdge = (sourceFile: ts.SourceFile, node: ts.Node) => {
      if (!ts.isExpressionWithTypeArguments(node)) {
        return false;
      }
      const kind = ts.isHeritageClause(node.parent)
        ? node.parent.token === ts.SyntaxKind.ExtendsKeyword
          ? "extends"
          : "implements"
        : "type-reference";
      addEdge(
        sourceFile,
        nearestOwnerKey(node),
        refForSymbol(expressionReferenceTarget(sourceFile, node.expression)),
        kind,
        node,
      );
      return true;
    };

    const addTypeReferenceEdge = (sourceFile: ts.SourceFile, node: ts.Node) => {
      if (!ts.isTypeReferenceNode(node)) {
        return false;
      }
      addEdge(
        sourceFile,
        nearestOwnerKey(node),
        refForSymbol(
          checker.getSymbolAtLocation(
            ts.isIdentifier(node.typeName) ? node.typeName : node.typeName.right,
          ),
        ),
        "type-reference",
        node,
      );
      return true;
    };

    const addIdentifierReferenceEdge = (sourceFile: ts.SourceFile, node: ts.Node) => {
      if (!ts.isIdentifier(node) || declarationName(node.parent)) {
        return false;
      }
      addEdge(
        sourceFile,
        nearestOwnerKey(node),
        refForSymbol(checker.getSymbolAtLocation(node)),
        "reference",
        node,
      );
      return true;
    };

    const addReferenceEdge = (sourceFile: ts.SourceFile, node: ts.Node) =>
      addImportEdge(sourceFile, node) ||
      addExportEdge(sourceFile, node) ||
      addCallOrConstructEdge(sourceFile, node) ||
      addHeritageOrTypeArgumentEdge(sourceFile, node) ||
      addTypeReferenceEdge(sourceFile, node) ||
      addIdentifierReferenceEdge(sourceFile, node);

    for (const sourceFile of sourceFiles) {
      const visitReferences = (node: ts.Node) => {
        addReferenceEdge(sourceFile, node);
        ts.forEachChild(node, visitReferences);
      };
      visitReferences(sourceFile);
    }
  }

  for (const edge of pendingEdges) {
    const scopedSymbolKey = scopedSymbolIdentityToKey.get(
      scopedIdentity(edge.tsconfigPath, edge.toIdentity),
    );
    const toSymbolKeys = scopedSymbolKey
      ? [scopedSymbolKey]
      : symbolKeysForIdentity(edge.toIdentity);
    if (toSymbolKeys.length > 1) {
      const key = scopedIdentity(edge.tsconfigPath, edge.toIdentity);
      ambiguousPendingIdentities.set(key, (ambiguousPendingIdentities.get(key) ?? 0) + 1);
    }
    for (const toSymbolKey of toSymbolKeys) {
      addResolvedEdge({ ...edge, toSymbolKey });
    }
  }
  if (ambiguousPendingIdentities.size > 0) {
    const totalEdges = [...ambiguousPendingIdentities.values()].reduce(
      (total, count) => total + count,
      0,
    );
    console.warn(
      `tiara-review dependency graph: resolved ${totalEdges} ambiguous cross-tsconfig edges across ${ambiguousPendingIdentities.size} symbol identities`,
    );
  }

  return {
    files: [...files.values()],
    symbols: [...symbols.values()],
    edges: [...edges.values()],
  };
};

type ExtractWorkerData = {
  readonly type: "tiara-review.extractDependencyGraph";
  readonly repoRoot: string;
};

type ExtractWorkerMessage =
  | { readonly ok: true; readonly graph: ExtractedDependencyGraph }
  | {
      readonly ok: false;
      readonly error: {
        readonly name: string;
        readonly message: string;
        readonly stack?: string | undefined;
      };
    };

const dependencyGraphExtractionTimeoutMillis = 5 * 60 * 1000;
const extractChildRepoRootEnv = "TIARA_REVIEW_EXTRACT_CHILD_REPO_ROOT";

const isExtractWorkerData = (data: unknown): data is ExtractWorkerData =>
  typeof data === "object" &&
  data !== null &&
  (data as { readonly type?: unknown }).type === "tiara-review.extractDependencyGraph" &&
  typeof (data as { readonly repoRoot?: unknown }).repoRoot === "string";

const isSourceRuntime = () => fileURLToPath(import.meta.url).endsWith(".ts");

const isVitestRuntime = () =>
  process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;

const packageRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const extractDependencyGraphInlineAsync = (repoRoot: string) =>
  new Promise<ExtractedDependencyGraph>((resolveGraph, reject) => {
    setImmediate(() => {
      try {
        resolveGraph(extractDependencyGraph(repoRoot));
      } catch (cause) {
        reject(cause);
      }
    });
  });

const appendCappedOutput = (current: string, chunk: Buffer | string) =>
  (current + chunk.toString()).slice(-4000);

const superviseExtractionRuntime = (input: {
  readonly attach: (handlers: {
    readonly message: (message: ExtractWorkerMessage) => void;
    readonly error: (cause: Error) => void;
    readonly close: (code: number | null) => void;
  }) => void;
  readonly stop: () => void | Promise<void>;
  readonly exitError: (code: number | null) => Error;
}) =>
  new Promise<ExtractedDependencyGraph>((resolveGraph, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      settle(() => {
        void input.stop();
        reject(
          new Error(
            `Dependency graph extraction timed out after ${dependencyGraphExtractionTimeoutMillis}ms`,
          ),
        );
      });
    }, dependencyGraphExtractionTimeoutMillis);
    input.attach({
      message: (message) => {
        if (message.ok) {
          settle(() => resolveGraph(message.graph));
        } else {
          const error = new Error(message.error.message);
          error.name = message.error.name;
          if (message.error.stack !== undefined) {
            error.stack = message.error.stack;
          }
          settle(() => reject(error));
        }
      },
      error: (cause) => settle(() => reject(cause)),
      close: (code) => {
        settle(() => reject(input.exitError(code)));
      },
    });
  });

const extractDependencyGraphInSourceChild = (repoRoot: string) => {
  let stdout = "";
  let stderr = "";
  const child = fork(fileURLToPath(import.meta.url), [], {
    cwd: packageRoot(),
    env: {
      ...process.env,
      [extractChildRepoRootEnv]: repoRoot,
    },
    execArgv: ["--import", "tsx"],
    serialization: "advanced",
    silent: true,
  });
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout = appendCappedOutput(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = appendCappedOutput(stderr, chunk);
  });
  const childOutput = () =>
    [stdout ? `stdout:\n${stdout}` : "", stderr ? `stderr:\n${stderr}` : ""]
      .filter((part) => part.length > 0)
      .join("\n");
  return superviseExtractionRuntime({
    attach: (handlers) => {
      child.once("message", (message: ExtractWorkerMessage) => handlers.message(message));
      child.once("error", handlers.error);
      child.once("close", handlers.close);
    },
    stop: () => {
      child.kill();
    },
    exitError: (code) => {
      const output = childOutput();
      return new Error(
        `Dependency graph extraction child exited with code ${code}${output ? `\n${output}` : ""}`,
      );
    },
  });
};

const extractDependencyGraphInWorker = (repoRoot: string) =>
  new Promise<ExtractedDependencyGraph>((resolveGraph, reject) => {
    if (isVitestRuntime()) {
      extractDependencyGraphInlineAsync(repoRoot).then(resolveGraph, reject);
      return;
    }
    if (isSourceRuntime()) {
      extractDependencyGraphInSourceChild(repoRoot).then(resolveGraph, reject);
      return;
    }
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        type: "tiara-review.extractDependencyGraph",
        repoRoot,
      } satisfies ExtractWorkerData,
    });
    superviseExtractionRuntime({
      attach: (handlers) => {
        worker.once("message", (message: ExtractWorkerMessage) => handlers.message(message));
        worker.once("error", handlers.error);
        worker.once("exit", handlers.close);
      },
      stop: () => {
        void worker.terminate();
      },
      exitError: (code) => new Error(`Dependency graph extraction worker exited with code ${code}`),
    }).then(resolveGraph, reject);
  });

export const extractDependencyGraphAsync = extractDependencyGraphInWorker;

if (!isMainThread && isExtractWorkerData(workerData)) {
  try {
    parentPort?.postMessage({
      ok: true,
      graph: extractDependencyGraph(workerData.repoRoot),
    } satisfies ExtractWorkerMessage);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    parentPort?.postMessage({
      ok: false,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    } satisfies ExtractWorkerMessage);
  }
}

const childRepoRoot = process.env[extractChildRepoRootEnv];
if (isMainThread && childRepoRoot) {
  try {
    process.send?.({
      ok: true,
      graph: extractDependencyGraph(childRepoRoot),
    } satisfies ExtractWorkerMessage);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    process.send?.({
      ok: false,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    } satisfies ExtractWorkerMessage);
  }
}
