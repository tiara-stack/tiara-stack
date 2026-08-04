import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Match, Predicate, Schema } from "effect";
import ts from "typescript";
import type {
  BoundaryAudit,
  BoundaryException,
  BoundaryPolicy,
  BoundaryViolation,
  PackageRole,
} from "./types";

interface PackageManifest {
  readonly name: string;
  readonly exports?: ExportValue;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

type ExportValue = string | null | readonly ExportValue[] | ExportConditions;

interface ExportConditions {
  readonly [condition: string]: ExportValue;
}

interface WorkspacePackage {
  readonly directory: string;
  readonly manifest: PackageManifest;
}

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const sheetPackagePattern = /^(?:@[^/]+\/)?sheet-/;
const contractOrClientRoles = {
  client: true,
  contract: true,
  foundation: false,
  implementation: false,
  runtime: false,
} satisfies Record<PackageRole, boolean>;

const ExportValueSchema: Schema.Codec<ExportValue> = Schema.suspend(
  (): Schema.Codec<ExportValue> =>
    Schema.Union([
      Schema.String,
      Schema.Null,
      Schema.Array(ExportValueSchema),
      Schema.Record(Schema.String, ExportValueSchema),
    ]),
);
const DependenciesSchema = Schema.Record(Schema.String, Schema.String);
const PackageManifestSchema = Schema.Struct({
  name: Schema.String,
  exports: Schema.optionalKey(ExportValueSchema),
  dependencies: Schema.optionalKey(DependenciesSchema),
  optionalDependencies: Schema.optionalKey(DependenciesSchema),
  peerDependencies: Schema.optionalKey(DependenciesSchema),
});

const violationKey = (
  value: Pick<BoundaryViolation | BoundaryException, "code" | "package" | "path" | "target">,
) => [value.code, value.package, value.target ?? "", value.path ?? ""].join("|");

const compareViolations = (left: BoundaryViolation, right: BoundaryViolation) => {
  const leftKey = violationKey(left);
  const rightKey = violationKey(right);
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? -1 : 1;
};

const readManifest = (manifestPath: string): PackageManifest => {
  try {
    return Schema.decodeUnknownSync(PackageManifestSchema)(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
  } catch (cause) {
    throw new Error(`Invalid package manifest at ${manifestPath}`, { cause });
  }
};

const readWorkspacePackages = (repositoryRoot: string): ReadonlyMap<string, WorkspacePackage> => {
  const packagesDirectory = path.join(repositoryRoot, "packages");
  const entries = existsSync(packagesDirectory)
    ? readdirSync(packagesDirectory, { withFileTypes: true })
    : [];

  return new Map(
    entries.flatMap((entry): readonly [string, WorkspacePackage][] => {
      const directory = path.join(packagesDirectory, entry.name);
      const manifestPath = path.join(directory, "package.json");
      if (!entry.isDirectory() || !existsSync(manifestPath)) return [];

      const manifest = readManifest(manifestPath);
      return [[manifest.name, { directory, manifest }]];
    }),
  );
};

const runtimeDependencies = (manifest: PackageManifest): Readonly<Record<string, string>> => ({
  ...manifest.dependencies,
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
});

const isContractOrClient = (role: PackageRole) => contractOrClientRoles[role];

const dependencyViolations = (
  workspacePackages: ReadonlyMap<string, WorkspacePackage>,
  policy: BoundaryPolicy,
  dependencyPackageNames: ReadonlySet<string>,
): BoundaryViolation[] => {
  const deployableRuntimes = new Set(policy.deployableRuntimes);
  const gatewayCapabilities = new Set(policy.gatewayCapabilities);
  const violations: BoundaryViolation[] = [];

  for (const [packageName, workspacePackage] of workspacePackages) {
    const dependencies = Object.keys(runtimeDependencies(workspacePackage.manifest));
    const boundary = policy.packages[packageName];

    if (boundary === undefined) {
      // Governed packages use their explicit allowlist. This combination check prevents an
      // unclassified package from recreating the gateway by accumulating capability clients.
      const capabilities = dependencies.filter((dependency) => gatewayCapabilities.has(dependency));
      if (capabilities.length > 1) {
        const target = capabilities.sort().join(",");
        violations.push({
          code: "gateway-capability-combination",
          package: packageName,
          target,
          message: `${packageName} combines gateway-shaped capabilities: ${target}`,
        });
      }
      continue;
    }

    const allowedDependencies = new Set(boundary.allowedSheetDependencies);
    for (const dependency of dependencies.filter((name) => dependencyPackageNames.has(name))) {
      if (allowedDependencies.has(dependency)) continue;

      const code =
        isContractOrClient(boundary.role) && deployableRuntimes.has(dependency)
          ? "deployable-runtime-dependency"
          : "forbidden-sheet-dependency";
      violations.push({
        code,
        package: packageName,
        target: dependency,
        message: `${packageName} may not depend on ${dependency}`,
      });
    }
  }

  return violations;
};

const defaultExportConditions = ["development", "source", "import", "default", "types"];
const browserExportConditions = ["browser", ...defaultExportConditions];
const noExcludedExportConditions = new Set<string>();
const serverOnlyExportConditions = new Set(["node", "require", "deno", "bun"]);
const isExportArray = (value: ExportValue): value is readonly ExportValue[] => Array.isArray(value);

const selectExportTarget = (
  value: ExportValue,
  conditions: readonly string[] = defaultExportConditions,
  excludedConditions: ReadonlySet<string> = noExcludedExportConditions,
): string | undefined => {
  if (Predicate.isString(value)) return value;
  if (Predicate.isNull(value)) return undefined;
  if (isExportArray(value)) {
    return value
      .map((candidate) => selectExportTarget(candidate, conditions, excludedConditions))
      .find(Predicate.isNotUndefined);
  }

  for (const condition of conditions) {
    if (excludedConditions.has(condition)) continue;
    const candidate = value[condition];
    if (candidate === undefined) continue;
    const selected = selectExportTarget(candidate, conditions, excludedConditions);
    if (selected !== undefined) return selected;
  }

  if (excludedConditions.size > 0) return undefined;

  return Object.entries(value)
    .filter(([condition]) => !excludedConditions.has(condition))
    .map(([, candidate]) => selectExportTarget(candidate, conditions, excludedConditions))
    .find(Predicate.isNotUndefined);
};

const normalizedExports = (manifest: PackageManifest): Readonly<Record<string, ExportValue>> => {
  const exports = manifest.exports;
  if (exports === undefined || Predicate.isNull(exports)) return {};
  if (Predicate.isString(exports) || isExportArray(exports)) return { ".": exports };
  return Object.keys(exports).some((key) => key.startsWith(".")) ? exports : { ".": exports };
};

const exportTargets = (value: ExportValue): string[] => {
  if (Predicate.isString(value)) return [value];
  if (Predicate.isNull(value)) return [];
  return Object.values(value).flatMap(exportTargets);
};

const wildcardExportViolations = (workspacePackage: WorkspacePackage): BoundaryViolation[] =>
  Object.entries(normalizedExports(workspacePackage.manifest)).flatMap(
    ([exportPath, exportValue]) => {
      const hasWildcardTarget = exportTargets(exportValue).some((target) => target.includes("*"));
      if (!exportPath.includes("*") && !hasWildcardTarget) return [];

      return [
        {
          code: "wildcard-export",
          package: workspacePackage.manifest.name,
          target: exportPath,
          message: `${workspacePackage.manifest.name} uses wildcard package export ${exportPath}`,
        },
      ];
    },
  );

const productionSourceFiles = (directory: string): string[] => {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(entryPath);
    if (!entry.isFile() || !sourceExtensions.includes(path.extname(entry.name))) return [];
    if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return [entryPath];
  });
};

type ExportAnalyzer = (filePath: string) => string[] | undefined;

const optionalSpecifier = (specifier: string | undefined): string[] =>
  specifier === undefined ? [] : [specifier];

type WrappedExpression =
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.TypeAssertion
  | ts.SatisfiesExpression
  | ts.NonNullExpression;

const isWrappedExpression = (node: ts.Node): node is WrappedExpression =>
  Predicate.some<ts.Node>([
    ts.isParenthesizedExpression,
    ts.isAsExpression,
    ts.isTypeAssertionExpression,
    ts.isSatisfiesExpression,
    ts.isNonNullExpression,
  ])(node);

const directlyExposedImportSpecifiers = (
  expression: ts.Expression,
  checker: ts.TypeChecker,
  importSpecifiers: ReadonlyMap<ts.Symbol, string>,
): string[] =>
  Match.value(expression).pipe(
    Match.when(ts.isIdentifier, (identifier) => {
      const symbol = checker.getSymbolAtLocation(identifier);
      return optionalSpecifier(symbol === undefined ? undefined : importSpecifiers.get(symbol));
    }),
    Match.when(
      Predicate.or(ts.isPropertyAccessExpression, ts.isElementAccessExpression),
      (access) => directlyExposedImportSpecifiers(access.expression, checker, importSpecifiers),
    ),
    Match.when(ts.isObjectLiteralExpression, (object) =>
      object.properties.flatMap((property) =>
        Match.value(property).pipe(
          Match.when(ts.isShorthandPropertyAssignment, (shorthand) => {
            const symbol = checker.getShorthandAssignmentValueSymbol(shorthand);
            return optionalSpecifier(
              symbol === undefined ? undefined : importSpecifiers.get(symbol),
            );
          }),
          Match.when(ts.isPropertyAssignment, (assignment) =>
            directlyExposedImportSpecifiers(assignment.initializer, checker, importSpecifiers),
          ),
          Match.when(ts.isSpreadAssignment, (spread) =>
            directlyExposedImportSpecifiers(spread.expression, checker, importSpecifiers),
          ),
          Match.orElse(() => []),
        ),
      ),
    ),
    Match.when(ts.isArrayLiteralExpression, (array) =>
      array.elements.flatMap((element) =>
        ts.isSpreadElement(element)
          ? directlyExposedImportSpecifiers(element.expression, checker, importSpecifiers)
          : ts.isOmittedExpression(element)
            ? []
            : directlyExposedImportSpecifiers(element, checker, importSpecifiers),
      ),
    ),
    Match.when(isWrappedExpression, (wrapped) =>
      directlyExposedImportSpecifiers(wrapped.expression, checker, importSpecifiers),
    ),
    Match.orElse(() => []),
  );

const hasExportModifier = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
    false);

const exportedExpressions = (statement: ts.Statement): ts.Expression[] => {
  if (ts.isExportAssignment(statement)) return [statement.expression];
  if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) =>
    declaration.initializer === undefined ? [] : [declaration.initializer],
  );
};

const exportedSpecifiersForStatement = (
  statement: ts.Statement,
  checker: ts.TypeChecker,
  importSpecifiers: ReadonlyMap<ts.Symbol, string>,
): string[] => {
  // Type-only exports still republish another package's public concepts and can expose
  // server-owned API shapes to browser consumers, so they intentionally remain in the audit.
  if (ts.isExportDeclaration(statement)) {
    if (statement.moduleSpecifier !== undefined) {
      return ts.isStringLiteralLike(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : [];
    }
    if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      return statement.exportClause.elements.flatMap((element) => {
        const symbol = checker.getExportSpecifierLocalTargetSymbol(element);
        const specifier = symbol === undefined ? undefined : importSpecifiers.get(symbol);
        return specifier === undefined ? [] : [specifier];
      });
    }
  }

  return exportedExpressions(statement).flatMap((expression) =>
    directlyExposedImportSpecifiers(expression, checker, importSpecifiers),
  );
};

const importBindingNames = (clause: ts.ImportClause): ts.Identifier[] => {
  const defaultBinding = clause.name === undefined ? [] : [clause.name];
  const namedBindings = clause.namedBindings;
  if (namedBindings === undefined) return defaultBinding;
  if (ts.isNamespaceImport(namedBindings)) return [...defaultBinding, namedBindings.name];
  return [...defaultBinding, ...namedBindings.elements.map((element) => element.name)];
};

const importedSymbols = (
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): readonly (readonly [ts.Symbol, string])[] =>
  source.statements.flatMap((statement): readonly (readonly [ts.Symbol, string])[] => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.importClause === undefined
    ) {
      return [];
    }
    const specifier = statement.moduleSpecifier.text;
    return importBindingNames(statement.importClause).flatMap((name) => {
      const symbol = checker.getSymbolAtLocation(name);
      return symbol === undefined ? [] : [[symbol, specifier]];
    });
  });

const createExportAnalyzer = (sourceFiles: readonly string[]): ExportAnalyzer => {
  const program = ts.createProgram({
    rootNames: [...sourceFiles],
    options: {
      allowJs: true,
      checkJs: false,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.Latest,
    },
  });
  const rootPaths = new Set(sourceFiles.map((sourceFile) => path.resolve(sourceFile)));
  const sourcesByPath = new Map(
    program
      .getSourceFiles()
      .map((sourceFile) => [path.resolve(sourceFile.fileName), sourceFile] as const)
      .filter(([resolvedPath]) => rootPaths.has(resolvedPath)),
  );
  const syntacticErrors = [...sourcesByPath.values()].flatMap((source) =>
    program
      .getSyntacticDiagnostics(source)
      .map(
        (diagnostic) =>
          `${source.fileName}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
      ),
  );
  if (syntacticErrors.length > 0) {
    throw new Error(`Unable to parse audited sources: ${syntacticErrors.join("; ")}`);
  }

  const checker = program.getTypeChecker();
  const importSpecifiers = new Map(
    [...sourcesByPath.values()].flatMap((source) => importedSymbols(source, checker)),
  );

  return (filePath) => {
    const source = sourcesByPath.get(path.resolve(filePath));
    if (source === undefined) return undefined;
    return source.statements.flatMap((statement) =>
      exportedSpecifiersForStatement(statement, checker, importSpecifiers),
    );
  };
};

const packageOwner = (specifier: string, packageNames: readonly string[]) =>
  packageNames.find(
    (packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`),
  );

const crossPackageReexportViolations = (
  repositoryRoot: string,
  workspacePackage: WorkspacePackage,
  workspacePackages: ReadonlyMap<string, WorkspacePackage>,
  packageNames: readonly string[],
  sourceFiles: readonly string[],
  exportAnalyzer: ExportAnalyzer,
): BoundaryViolation[] =>
  sourceFiles.flatMap((filePath): BoundaryViolation[] => {
    const specifiers = exportAnalyzer(filePath);
    if (specifiers === undefined) {
      const relativePath = path.relative(repositoryRoot, filePath).split(path.sep).join("/");
      return [
        {
          code: "source-analysis-unresolved",
          package: workspacePackage.manifest.name,
          path: relativePath,
          message: `${workspacePackage.manifest.name} source ${relativePath} was not analyzed`,
        },
      ];
    }
    return specifiers.flatMap((specifier) => {
      const relativeTarget = specifier.startsWith(".")
        ? resolveSourceModule(filePath, specifier)
        : undefined;
      const owner =
        relativeTarget === undefined
          ? packageOwner(specifier, packageNames)
          : [...workspacePackages].find(([, candidate]) => {
              const packageRoot = `${candidate.directory}${path.sep}`;
              return relativeTarget.startsWith(packageRoot);
            })?.[0];
      if (owner === undefined || owner === workspacePackage.manifest.name) return [];

      const relativePath = path.relative(repositoryRoot, filePath).split(path.sep).join("/");
      const target = relativeTarget === undefined ? specifier : owner;
      return [
        {
          code: "cross-package-reexport",
          package: workspacePackage.manifest.name,
          target,
          path: relativePath,
          message: `${workspacePackage.manifest.name} re-exports ${target} from ${relativePath}`,
        },
      ];
    });
  });

function resolveSourceModule(fromFile: string, specifier: string): string | undefined {
  const unresolved = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    unresolved,
    ...sourceExtensions.map((extension) => `${unresolved}${extension}`),
    ...sourceExtensions.map((extension) => path.join(unresolved, `index${extension}`)),
  ];
  return candidates.find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile());
}

const sourcePathFromExportTarget = (
  workspacePackage: WorkspacePackage,
  target: string,
): string | undefined => {
  const normalizedTarget = target
    .replace(/^\.\/dist\/(?:(?:browser|cjs|commonjs|es|esm|node|types)\/)?/, "")
    .replace(/\.d\.[cm]?ts$/, "");
  const withoutExtension = normalizedTarget.replace(/\.[cm]?[jt]sx?$/, "");
  // src/entry.ts is a synthetic directory anchor. It is never read; it keeps nested dist targets
  // aligned with their source paths without producing false browser-entry-unresolved violations.
  const sourcePath = resolveSourceModule(
    path.join(workspacePackage.directory, "src", "entry.ts"),
    `./${withoutExtension}`,
  );
  if (sourcePath !== undefined) return sourcePath;

  const sourceRoot = `${path.join(workspacePackage.directory, "src")}${path.sep}`;
  const directPath = path.resolve(workspacePackage.directory, target);
  return directPath.startsWith(sourceRoot) &&
    statSync(directPath, { throwIfNoEntry: false })?.isFile()
    ? directPath
    : undefined;
};

const isServerSpecifier = (specifier: string) =>
  specifier
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[./\\_-]/)
    .filter(Boolean)
    .includes("server");

const serverExportsFromEntry = (
  entryFile: string,
  exportAnalyzer: ExportAnalyzer,
): {
  readonly serverExports: readonly { file: string; specifier: string }[];
  readonly unresolvedFiles: readonly string[];
} => {
  const visited = new Set<string>();
  const serverExports: { file: string; specifier: string }[] = [];
  const unresolvedFiles: string[] = [];

  const visit = (filePath: string) => {
    if (visited.has(filePath)) return;
    visited.add(filePath);

    const specifiers = exportAnalyzer(filePath);
    if (specifiers === undefined) {
      unresolvedFiles.push(filePath);
      return;
    }
    for (const specifier of specifiers) {
      if (isServerSpecifier(specifier)) serverExports.push({ file: filePath, specifier });
      if (!specifier.startsWith(".")) continue;
      const target = resolveSourceModule(filePath, specifier);
      if (target !== undefined) visit(target);
    }
  };

  visit(entryFile);
  return { serverExports, unresolvedFiles };
};

const browserExportViolations = (
  repositoryRoot: string,
  workspacePackage: WorkspacePackage,
  browserEntrypoints: readonly string[],
  exportAnalyzer: ExportAnalyzer,
): BoundaryViolation[] => {
  const exports = normalizedExports(workspacePackage.manifest);
  return browserEntrypoints.flatMap((entrypoint): BoundaryViolation[] => {
    const exportValue = exports[entrypoint];
    const exportTarget =
      exportValue === undefined
        ? undefined
        : selectExportTarget(exportValue, browserExportConditions, serverOnlyExportConditions);
    const entryFile =
      exportTarget === undefined
        ? undefined
        : sourcePathFromExportTarget(workspacePackage, exportTarget);

    if (entryFile === undefined) {
      return [
        {
          code: "browser-entry-unresolved",
          package: workspacePackage.manifest.name,
          target: entrypoint,
          message: `${workspacePackage.manifest.name} browser entry ${entrypoint} has no source file`,
        },
      ];
    }

    const analysis = serverExportsFromEntry(entryFile, exportAnalyzer);
    return [
      ...analysis.unresolvedFiles.map((file): BoundaryViolation => {
        const relativePath = path.relative(repositoryRoot, file).split(path.sep).join("/");
        return {
          code: "source-analysis-unresolved",
          package: workspacePackage.manifest.name,
          target: entrypoint,
          path: relativePath,
          message: `${workspacePackage.manifest.name} browser exports reach unanalyzed source ${relativePath}`,
        };
      }),
      ...analysis.serverExports.map(
        ({ file, specifier }): BoundaryViolation => ({
          code: "browser-server-export",
          package: workspacePackage.manifest.name,
          target: specifier,
          path: path.relative(repositoryRoot, file).split(path.sep).join("/"),
          message: `${workspacePackage.manifest.name} browser exports expose ${specifier}`,
        }),
      ),
    ];
  });
};

const rawViolations = (
  repositoryRoot: string,
  workspacePackages: ReadonlyMap<string, WorkspacePackage>,
  policy: BoundaryPolicy,
): BoundaryViolation[] => {
  const packageNames = [
    ...new Set([
      ...workspacePackages.keys(),
      ...Object.keys(policy.packages),
      ...policy.legacyPackages,
    ]),
  ].sort((left, right) => right.length - left.length);
  const dependencyPackageNames = new Set([
    ...Object.keys(policy.packages),
    ...policy.legacyPackages,
    ...policy.deployableRuntimes,
    ...policy.gatewayCapabilities,
    ...[...workspacePackages.keys()].filter((packageName) => sheetPackagePattern.test(packageName)),
  ]);
  const sourceFilesByPackage = new Map(
    Object.keys(policy.packages).flatMap((packageName) => {
      const workspacePackage = workspacePackages.get(packageName);
      return workspacePackage === undefined
        ? []
        : [
            [
              packageName,
              productionSourceFiles(path.join(workspacePackage.directory, "src")),
            ] as const,
          ];
    }),
  );
  const exportAnalyzer = createExportAnalyzer([...sourceFilesByPackage.values()].flat());

  const violations = dependencyViolations(workspacePackages, policy, dependencyPackageNames);

  for (const legacyPackage of policy.legacyPackages) {
    if (!workspacePackages.has(legacyPackage)) continue;
    violations.push({
      code: "legacy-package-present",
      package: legacyPackage,
      message: `${legacyPackage} remains as an explicitly transitional package`,
    });
  }

  for (const [packageName, boundary] of Object.entries(policy.packages)) {
    const workspacePackage = workspacePackages.get(packageName);
    // Expansion packages enter the target policy before their directories are created. They start
    // participating automatically when landed, while absent targets remain valid rollout state.
    if (workspacePackage === undefined) continue;

    violations.push(...wildcardExportViolations(workspacePackage));
    violations.push(
      ...crossPackageReexportViolations(
        repositoryRoot,
        workspacePackage,
        workspacePackages,
        packageNames,
        sourceFilesByPackage.get(packageName) ?? [],
        exportAnalyzer,
      ),
    );
    if (boundary.browserEntrypoints !== undefined) {
      violations.push(
        ...browserExportViolations(
          repositoryRoot,
          workspacePackage,
          boundary.browserEntrypoints,
          exportAnalyzer,
        ),
      );
    }
  }

  return [
    ...new Map(violations.map((violation) => [violationKey(violation), violation])).values(),
  ].sort(compareViolations);
};

const exceptionViolations = (
  exceptions: readonly BoundaryException[],
  activeViolationKeys: ReadonlySet<string>,
): BoundaryViolation[] => {
  const seen = new Set<string>();
  const reportedDuplicates = new Set<string>();
  const violations: BoundaryViolation[] = [];

  for (const exception of exceptions) {
    const key = violationKey(exception);
    const isDuplicate = seen.has(key);
    if (isDuplicate && !reportedDuplicates.has(key)) {
      violations.push({
        code: "duplicate-exception",
        package: exception.package,
        target: key,
        message: `Boundary exception ${key} is duplicated`,
      });
      reportedDuplicates.add(key);
    }
    seen.add(key);
    if (isDuplicate) continue;

    if (!hasValidExceptionMetadata(exception)) {
      violations.push({
        code: "invalid-exception",
        package: exception.package,
        target: key,
        message: `Boundary exception ${key} needs a reason and removal condition`,
      });
    }
    if (!activeViolationKeys.has(key)) {
      violations.push({
        code: "stale-exception",
        package: exception.package,
        target: key,
        message: `Boundary exception ${key} is stale and must be removed`,
      });
    }
  }

  return violations;
};

const hasValidExceptionMetadata = (exception: BoundaryException) =>
  exception.reason.trim().length > 0 && exception.removeWhen.trim().length > 0;

export const auditSheetPackageBoundaries = (
  repositoryRoot: string,
  policy: BoundaryPolicy,
): BoundaryAudit => {
  const workspacePackages = readWorkspacePackages(repositoryRoot);
  const active = rawViolations(repositoryRoot, workspacePackages, policy);
  const activeKeys = new Set(active.map(violationKey));
  const exceptionKeys = new Set(
    policy.exceptions.filter(hasValidExceptionMetadata).map(violationKey),
  );
  const suppressed = active.filter((violation) => exceptionKeys.has(violationKey(violation)));
  const violations = [
    ...active.filter((violation) => !exceptionKeys.has(violationKey(violation))),
    ...exceptionViolations(policy.exceptions, activeKeys),
  ].sort(compareViolations);

  return { violations, suppressed };
};
