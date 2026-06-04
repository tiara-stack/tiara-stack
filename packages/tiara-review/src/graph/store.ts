import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { SqlClient } from "effect/unstable/sql";
import { gitText, runGit } from "../git/checkpoint";
import { withImmediateTransaction, withSqlite } from "../db/client";
import { makeId } from "../db/repository";
import { DatabaseMigrationFailed, GitCommandFailed } from "../review/types";
import { extractDependencyGraphAsync } from "./extract";
import {
  type DependencyEdgeKind,
  type DependencyGraphEdge,
  type DependencyGraphMode,
  type DependencyGraphSymbol,
  type DependencyGraphVersion,
  type ExtractedDependencyGraph,
  DependencyGraphFailed,
  DependencyGraphVersionNotFound,
  dependencyGraphSymbolStableIdentity,
  type SymbolDependenciesResult,
  type SymbolDependentsResult,
  type SymbolLookupResult,
} from "./types";

type VersionRow = {
  readonly id: string;
  readonly repo_root: string;
  readonly branch: string | null;
  readonly checkpoint_ref: string;
  readonly checkpoint_commit: string;
  readonly base_version_id: string | null;
  readonly diff_hash: string;
  readonly mode: string;
  readonly status: string;
  readonly created_at: number;
  readonly completed_at: number | null;
  readonly lease_expires_at: number | null;
  readonly error: string | null;
};

type SymbolRow = {
  readonly symbol_key: string;
  readonly file_key: string;
  readonly name: string;
  readonly qualified_name: string;
  readonly kind: string;
  readonly path: string;
  readonly start_line: number;
  readonly start_column: number;
  readonly end_line: number;
  readonly end_column: number;
  readonly exported: number;
  readonly metadata_json: string;
};

type EdgeRow = {
  readonly edge_key: string;
  readonly from_symbol_key: string;
  readonly to_symbol_key: string;
  readonly kind: string;
  readonly source_path: string;
  readonly source_start_line: number;
  readonly source_start_column: number;
  readonly metadata_json: string;
};

type JoinedEdgeSymbolRow = EdgeRow & {
  readonly joined_symbol_key: string;
  readonly joined_file_key: string;
  readonly joined_name: string;
  readonly joined_qualified_name: string;
  readonly joined_kind: string;
  readonly joined_path: string;
  readonly joined_start_line: number;
  readonly joined_start_column: number;
  readonly joined_end_line: number;
  readonly joined_end_column: number;
  readonly joined_exported: number;
  readonly joined_metadata_json: string;
};

const now = () => Math.floor(Date.now() / 1000);
const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
const graphVersionPollIntervalMillis = 500;
const graphVersionWaitTimeoutMillis = 5 * 60 * 1000;
const graphVersionLeaseSeconds = 10 * 60;
const graphVersionHeartbeatMillis = 30 * 1000;
const graphVersionLeaseExpiredError = "Dependency graph build lease expired";
const sqliteDefaultMaxVariableNumber = 999;
const graphRecordParameterBudgetRatio = 0.9;
const versionChainCacheLimit = 256;
const versionChainCache = new Map<string, ReadonlyArray<DependencyGraphVersion>>();
const sqliteBindParameterBudgetByClient = new WeakMap<SqlClient.SqlClient, Promise<number>>();
const sqliteBindParameterBudgetFallbackReported = new WeakSet<SqlClient.SqlClient>();
const graphRecordColumns = {
  files: ["file_key", "repo_root", "path", "content_hash", "tsconfig_path"],
  symbols: [
    "symbol_key",
    "file_key",
    "name",
    "qualified_name",
    "kind",
    "path",
    "start_line",
    "start_column",
    "end_line",
    "end_column",
    "exported",
    "metadata_json",
  ],
  edges: [
    "edge_key",
    "from_symbol_key",
    "to_symbol_key",
    "kind",
    "source_path",
    "source_start_line",
    "source_start_column",
    "metadata_json",
  ],
  symbolDeltas: ["version_id", "symbol_key", "op"],
  edgeDeltas: ["version_id", "edge_key", "op"],
} as const;

const toVersion = (row: VersionRow): DependencyGraphVersion => ({
  id: row.id,
  repoRoot: row.repo_root,
  branch: row.branch,
  checkpointRef: row.checkpoint_ref,
  checkpointCommit: row.checkpoint_commit,
  baseVersionId: row.base_version_id,
  diffHash: row.diff_hash,
  mode: row.mode as DependencyGraphMode,
  status: row.status as DependencyGraphVersion["status"],
  createdAt: row.created_at,
  completedAt: row.completed_at,
  leaseExpiresAt: row.lease_expires_at,
  error: row.error,
});

const toSymbol = (row: SymbolRow): DependencyGraphSymbol => ({
  symbolKey: row.symbol_key,
  fileKey: row.file_key,
  name: row.name,
  qualifiedName: row.qualified_name,
  kind: row.kind,
  path: row.path,
  startLine: row.start_line,
  startColumn: row.start_column,
  endLine: row.end_line,
  endColumn: row.end_column,
  exported: row.exported === 1,
  metadataJson: row.metadata_json,
});

const toEdge = (row: EdgeRow): DependencyGraphEdge => ({
  edgeKey: row.edge_key,
  fromSymbolKey: row.from_symbol_key,
  toSymbolKey: row.to_symbol_key,
  kind: row.kind as DependencyEdgeKind,
  sourcePath: row.source_path,
  sourceStartLine: row.source_start_line,
  sourceStartColumn: row.source_start_column,
  metadataJson: row.metadata_json,
});

const toJoinedSymbol = (row: JoinedEdgeSymbolRow): DependencyGraphSymbol =>
  toSymbol({
    symbol_key: row.joined_symbol_key,
    file_key: row.joined_file_key,
    name: row.joined_name,
    qualified_name: row.joined_qualified_name,
    kind: row.joined_kind,
    path: row.joined_path,
    start_line: row.joined_start_line,
    start_column: row.joined_start_column,
    end_line: row.joined_end_line,
    end_column: row.joined_end_column,
    exported: row.joined_exported,
    metadata_json: row.joined_metadata_json,
  });

const joinedSymbolProjection = `
  s.symbol_key as joined_symbol_key,
  s.file_key as joined_file_key,
  s.name as joined_name,
  s.qualified_name as joined_qualified_name,
  s.kind as joined_kind,
  s.path as joined_path,
  s.start_line as joined_start_line,
  s.start_column as joined_start_column,
  s.end_line as joined_end_line,
  s.end_column as joined_end_column,
  s.exported as joined_exported,
  s.metadata_json as joined_metadata_json
`;

const loadVersion = (sql: SqlClient.SqlClient, versionId: string) =>
  sql
    .unsafe<VersionRow>(`select * from dependency_graph_versions where id = ? limit 1`, [versionId])
    .pipe(
      Effect.flatMap((rows) =>
        rows[0]
          ? Effect.succeed(toVersion(rows[0]))
          : Effect.fail(new DependencyGraphVersionNotFound({ versionId })),
      ),
    );

const loadVersionChain = (sql: SqlClient.SqlClient, versionId: string) =>
  sql
    .unsafe<VersionRow & { readonly chain_index: number }>(
      `with recursive chain(id, base_version_id, chain_index, visited) as (
         select id, base_version_id, 0, char(31) || id || char(31)
         from dependency_graph_versions
         where id = ?
         union all
         select v.id, v.base_version_id, c.chain_index + 1, c.visited || v.id || char(31)
         from dependency_graph_versions v
         join chain c on v.id = c.base_version_id
         where instr(c.visited, char(31) || v.id || char(31)) = 0
       )
       select v.*, c.chain_index
       from dependency_graph_versions v
       join chain c on c.id = v.id
       order by c.chain_index desc`,
      [versionId],
    )
    .pipe(
      Effect.flatMap((rows) =>
        Effect.gen(function* () {
          if (rows.length === 0) {
            return yield* Effect.fail(new DependencyGraphVersionNotFound({ versionId }));
          }
          const versions = rows.map(toVersion);
          const versionIds = new Set(versions.map((version) => version.id));
          const oldestVersion = versions[0]!;
          if (oldestVersion.baseVersionId && !versionIds.has(oldestVersion.baseVersionId)) {
            return yield* Effect.fail(
              new DependencyGraphVersionNotFound({ versionId: oldestVersion.baseVersionId }),
            );
          }
          return versions;
        }),
      ),
    );

const loadVersionChainCached = (sql: SqlClient.SqlClient, versionId: string) => {
  const cached = versionChainCache.get(versionId);
  if (cached) {
    versionChainCache.delete(versionId);
    versionChainCache.set(versionId, cached);
    return Effect.succeed(cached);
  }
  return loadVersionChain(sql, versionId).pipe(
    Effect.tap((chain) =>
      Effect.sync(() => {
        versionChainCache.set(versionId, chain);
        while (versionChainCache.size > versionChainCacheLimit) {
          const oldestKey = versionChainCache.keys().next().value;
          if (oldestKey === undefined) {
            break;
          }
          versionChainCache.delete(oldestKey);
        }
      }),
    ),
  );
};

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");
const escapeLike = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
const versionChainCte = (chain: ReadonlyArray<DependencyGraphVersion>) =>
  `with version_chain(version_id, chain_index) as (values ${chain.map(() => "(?, ?)").join(", ")})`;
const versionChainParams = (chain: ReadonlyArray<DependencyGraphVersion>) =>
  chain.flatMap((version, index) => [version.id, index]);
const activeSymbolPredicate = (alias: string) => `
  (
    select d.op
    from dependency_graph_symbol_deltas d
    join version_chain vc on vc.version_id = d.version_id
    where d.symbol_key = ${alias}.symbol_key
    order by vc.chain_index desc
    limit 1
  ) = 'add'
`;
const activeEdgePredicate = (alias: string) => `
  (
    select d.op
    from dependency_graph_edge_deltas d
    join version_chain vc on vc.version_id = d.version_id
    where d.edge_key = ${alias}.edge_key
    order by vc.chain_index desc
    limit 1
  ) = 'add'
`;

const loadActiveSymbolsByPaths = (
  sql: SqlClient.SqlClient,
  chain: ReadonlyArray<DependencyGraphVersion>,
  paths: ReadonlySet<string>,
) =>
  paths.size === 0
    ? Effect.succeed<ReadonlyArray<DependencyGraphSymbol>>([])
    : sql
        .unsafe<SymbolRow>(
          `${versionChainCte(chain)}
           select s.*
           from dependency_graph_symbols s
           where s.path in (${placeholders(paths.size)})
             and ${activeSymbolPredicate("s")}`,
          [...versionChainParams(chain), ...paths],
        )
        .pipe(Effect.map((rows) => rows.map(toSymbol)));

const loadActiveEdgesToSymbols = (
  sql: SqlClient.SqlClient,
  chain: ReadonlyArray<DependencyGraphVersion>,
  symbolKeys: ReadonlySet<string>,
  edgeKinds: ReadonlyArray<DependencyEdgeKind>,
) =>
  symbolKeys.size === 0 || edgeKinds.length === 0
    ? Effect.succeed<ReadonlyArray<DependencyGraphEdge>>([])
    : sql
        .unsafe<EdgeRow>(
          `${versionChainCte(chain)}
           select e.*
           from dependency_graph_edges e
           where e.kind in (${placeholders(edgeKinds.length)})
             and e.to_symbol_key in (${placeholders(symbolKeys.size)})
             and ${activeEdgePredicate("e")}`,
          [...versionChainParams(chain), ...edgeKinds, ...symbolKeys],
        )
        .pipe(Effect.map((rows) => rows.map(toEdge)));

const loadActiveEdgesForImpactedSlice = (
  sql: SqlClient.SqlClient,
  chain: ReadonlyArray<DependencyGraphVersion>,
  paths: ReadonlySet<string>,
  symbolKeys: ReadonlySet<string>,
) => {
  const ctes = [
    `version_chain(version_id, chain_index) as (values ${chain.map(() => "(?, ?)").join(", ")})`,
  ];
  const clauses: Array<string> = [];
  const parameters: Array<number | string> = [...versionChainParams(chain)];
  if (symbolKeys.size > 0) {
    const impactedSymbolKeyValues = Array.from({ length: symbolKeys.size }, () => "(?)").join(", ");
    ctes.push(`impacted_symbol_keys(symbol_key) as (values ${impactedSymbolKeyValues})`);
    parameters.push(...symbolKeys);
    clauses.push(`exists (
      select 1
      from impacted_symbol_keys isk
      where isk.symbol_key = e.from_symbol_key
         or isk.symbol_key = e.to_symbol_key
    )`);
  }
  if (paths.size > 0) {
    clauses.push(`e.source_path in (${placeholders(paths.size)})`);
    parameters.push(...paths);
  }
  return clauses.length === 0
    ? Effect.succeed<ReadonlyArray<DependencyGraphEdge>>([])
    : sql
        .unsafe<EdgeRow>(
          `with ${ctes.join(", ")}
           select e.*
           from dependency_graph_edges e
           where (${clauses.join(" or ")})
             and ${activeEdgePredicate("e")}`,
          parameters,
        )
        .pipe(Effect.map((rows) => rows.map(toEdge)));
};

const loadIncrementalPriorSlice = (
  sql: SqlClient.SqlClient,
  versionId: string,
  changedFiles: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const chain = yield* loadVersionChainCached(sql, versionId);
    const changedSourcePaths = new Set(changedFiles.filter(isTsSourcePath));
    const changedSymbols = yield* loadActiveSymbolsByPaths(sql, chain, changedSourcePaths);
    const paths = new Set(changedSourcePaths);
    const symbolKeys = new Set(changedSymbols.map((symbol) => symbol.symbolKey));
    const searchedSymbolKeys = new Set<string>();
    while (true) {
      const frontier = [...symbolKeys].filter((symbolKey) => !searchedSymbolKeys.has(symbolKey));
      if (frontier.length === 0) {
        break;
      }
      for (const symbolKey of frontier) {
        searchedSymbolKeys.add(symbolKey);
      }
      const inboundEdges = yield* loadActiveEdgesToSymbols(sql, chain, new Set(frontier), [
        "import",
        "export",
      ]);
      const newPaths = new Set<string>();
      for (const edge of inboundEdges) {
        if (!paths.has(edge.sourcePath)) {
          paths.add(edge.sourcePath);
          newPaths.add(edge.sourcePath);
        }
      }
      if (newPaths.size > 0) {
        const expandedSymbols = yield* loadActiveSymbolsByPaths(sql, chain, newPaths);
        for (const symbol of expandedSymbols) {
          symbolKeys.add(symbol.symbolKey);
        }
      }
    }
    const symbols = yield* loadActiveSymbolsByPaths(sql, chain, paths);
    const finalSymbolKeys = new Set(symbols.map((symbol) => symbol.symbolKey));
    const edges = yield* loadActiveEdgesForImpactedSlice(sql, chain, paths, finalSymbolKeys);
    return { paths, symbols, edges };
  });

const changedFilesBetween = (repoRoot: string, fromCommit: string, toCommit: string) =>
  gitText(repoRoot, ["diff", "--name-status", "--find-renames", fromCommit, toCommit]).pipe(
    Effect.map((output) =>
      output
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          const parts = line.split("\t");
          const status = parts[0] ?? "";
          if (status.startsWith("R")) {
            return [parts[1], parts[2]].filter((path): path is string => Boolean(path));
          }
          return parts[1] ? [parts[1]] : [];
        }),
    ),
  );

const isTsSourcePath = (path: string) =>
  /\.(?:ts|tsx|mts|cts)$/.test(path) && !path.endsWith(".d.ts");

const requiresFullRebuild = (changedFiles: ReadonlyArray<string>) =>
  changedFiles.some(
    (path) =>
      path.endsWith("tsconfig.json") ||
      path.endsWith("package.json") ||
      path === "pnpm-lock.yaml" ||
      path === "pnpm-workspace.yaml",
  );

const commitExists = (repoRoot: string, commit: string) =>
  runGit(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]).pipe(
    Effect.as(true),
    Effect.catch((cause) =>
      cause instanceof GitCommandFailed && (cause.exitCode === 1 || cause.exitCode === 128)
        ? Effect.succeed(false)
        : Effect.fail(cause),
    ),
  );

const isShallowRepository = (repoRoot: string) =>
  gitText(repoRoot, ["rev-parse", "--is-shallow-repository"]).pipe(
    Effect.map((output) => output.trim() === "true"),
    Effect.catch((cause) =>
      cause instanceof GitCommandFailed ? Effect.succeed(false) : Effect.fail(cause),
    ),
  );

const hasMergeBase = (repoRoot: string, leftCommit: string, rightCommit: string) =>
  gitText(repoRoot, ["merge-base", "--all", leftCommit, rightCommit]).pipe(
    Effect.map((output) => output.trim().length > 0),
    Effect.catch((cause) =>
      cause instanceof GitCommandFailed && cause.exitCode === 1
        ? Effect.succeed(false)
        : Effect.fail(cause),
    ),
  );

const isAncestorCommit = (repoRoot: string, ancestorCommit: string, checkpointCommit: string) =>
  runGit(repoRoot, ["merge-base", "--is-ancestor", ancestorCommit, checkpointCommit]).pipe(
    Effect.retry({
      schedule: Schedule.recurs(1),
      while: (cause) => cause instanceof GitCommandFailed && cause.exitCode === 128,
    }),
    Effect.as(true),
    Effect.catch((cause) =>
      Effect.gen(function* () {
        if (cause instanceof GitCommandFailed && cause.exitCode === 1) {
          return false;
        }
        if (cause instanceof GitCommandFailed && cause.exitCode === 128) {
          const ancestorExists = yield* commitExists(repoRoot, ancestorCommit);
          const checkpointExists = yield* commitExists(repoRoot, checkpointCommit);
          if (!ancestorExists) {
            return false;
          }
          if (!checkpointExists) {
            return yield* Effect.fail(
              new DependencyGraphFailed({
                message: `Checkpoint commit is not available in this repository: ${checkpointCommit}`,
                cause,
              }),
            );
          }
          const shallowRepository = yield* isShallowRepository(repoRoot);
          const mergeBaseAvailable = shallowRepository
            ? yield* hasMergeBase(repoRoot, ancestorCommit, checkpointCommit)
            : true;
          if (!shallowRepository || mergeBaseAvailable) {
            return yield* Effect.fail(
              new DependencyGraphFailed({
                message: `Unable to determine dependency graph commit ancestry for ${ancestorCommit}..${checkpointCommit}`,
                cause,
              }),
            );
          }
          yield* Effect.logWarning(
            JSON.stringify({
              event: "dependency_graph_ancestry_unavailable",
              ancestorCommit,
              checkpointCommit,
              reason: cause.stderr || cause.stdout,
            }),
          );
          return false;
        }
        return yield* Effect.fail(cause);
      }),
    ),
  );

const validateCheckpointCommit = (repoRoot: string, checkpointCommit: string) =>
  commitExists(repoRoot, checkpointCommit).pipe(
    Effect.flatMap((exists) =>
      exists
        ? Effect.void
        : Effect.fail(
            new DependencyGraphFailed({
              message: `Checkpoint commit is not available in this repository: ${checkpointCommit}`,
            }),
          ),
    ),
  );

const firstReachablePriorVersion = (
  repoRoot: string,
  checkpointCommit: string,
  candidates: ReadonlyArray<VersionRow>,
) =>
  Effect.gen(function* () {
    for (const candidate of candidates) {
      const version = toVersion(candidate);
      const candidateExists = yield* commitExists(repoRoot, version.checkpointCommit);
      if (!candidateExists) {
        continue;
      }
      if (yield* isAncestorCommit(repoRoot, version.checkpointCommit, checkpointCommit)) {
        return version;
      }
    }
    return null;
  });

const graphFingerprint = (graph: ExtractedDependencyGraph) =>
  sha256(
    JSON.stringify({
      files: graph.files
        .map((file) => [file.path, file.contentHash])
        .sort((left, right) => left.join("\0").localeCompare(right.join("\0"))),
      symbols: graph.symbols
        .map((symbol) => symbol.symbolKey)
        .sort((left, right) => left.localeCompare(right)),
      edges: graph.edges
        .map((edge) => edge.edgeKey)
        .sort((left, right) => left.localeCompare(right)),
    }),
  );

const chunksOf = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> => {
  const chunks: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

type SqliteBindParameterBudgetProbe = {
  readonly budget: number;
  readonly cacheable: boolean;
};

const sqliteBindParameterBudget = (variableLimit: number) =>
  Math.max(1, Math.floor(variableLimit * graphRecordParameterBudgetRatio));

const nestedErrorValues = (cause: unknown): ReadonlyArray<unknown> =>
  typeof cause === "object" && cause !== null
    ? [
        (cause as { readonly cause?: unknown }).cause,
        (cause as { readonly error?: unknown }).error,
        (cause as { readonly originalError?: unknown }).originalError,
      ].filter((value) => value !== undefined)
    : [];

const sqliteErrorCode = (cause: unknown): string | null => {
  const pending = [cause];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    pending.push(...nestedErrorValues(current));
  }
  return null;
};

const sqliteErrorText = (cause: unknown): string => {
  const values: Array<string> = [String(cause)];
  const pending: Array<unknown> = [...nestedErrorValues(cause)];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.shift();
    values.push(String(current));
    if (typeof current !== "object" || current === null || visited.has(current)) {
      continue;
    }
    visited.add(current);
    pending.push(...nestedErrorValues(current));
  }
  return values.join(" ").toLowerCase();
};

const sqliteCompileOptionsProbeUnavailable = (cause: unknown) => {
  const code = sqliteErrorCode(cause);
  const message = sqliteErrorText(cause);
  const mentionsCompileOptions =
    message.includes("compile_options") || message.includes("pragma compile");
  if ((code === "SQLITE_AUTH" || code === "SQLITE_NOTFOUND") && mentionsCompileOptions) {
    return true;
  }
  return (
    mentionsCompileOptions &&
    (message.includes("not authorized") ||
      message.includes("unsupported") ||
      message.includes("unavailable") ||
      message.includes("unknown") ||
      message.includes("no such"))
  );
};

const sqliteBindParameterBudgetFallback = (
  sql: SqlClient.SqlClient,
  reason: "missing-option" | "probe-unavailable",
  cause?: unknown,
): SqliteBindParameterBudgetProbe => {
  if (!sqliteBindParameterBudgetFallbackReported.has(sql)) {
    sqliteBindParameterBudgetFallbackReported.add(sql);
    console.warn(
      reason === "missing-option"
        ? `SQLite MAX_VARIABLE_NUMBER compile option not reported; using fallback ${sqliteDefaultMaxVariableNumber}`
        : `SQLite compile option metadata probe unavailable; using fallback ${sqliteDefaultMaxVariableNumber}`,
      cause,
    );
  }
  return {
    budget: sqliteBindParameterBudget(sqliteDefaultMaxVariableNumber),
    cacheable: reason === "missing-option",
  };
};

const readSqliteBindParameterBudget = (sql: SqlClient.SqlClient) =>
  sql.unsafe<{ readonly compile_options: string }>(`pragma compile_options`).pipe(
    Effect.map((rows): SqliteBindParameterBudgetProbe => {
      const maxVariableNumber = rows
        .map((row) => /^MAX_VARIABLE_NUMBER=(\d+)$/.exec(row.compile_options)?.[1])
        .find((value): value is string => value !== undefined);
      return maxVariableNumber === undefined
        ? sqliteBindParameterBudgetFallback(sql, "missing-option")
        : {
            budget: sqliteBindParameterBudget(Number(maxVariableNumber)),
            cacheable: true,
          };
    }),
    Effect.catch((cause) =>
      sqliteCompileOptionsProbeUnavailable(cause)
        ? Effect.succeed(sqliteBindParameterBudgetFallback(sql, "probe-unavailable", cause))
        : Effect.fail(cause),
    ),
  );

const loadSqliteBindParameterBudget = (sql: SqlClient.SqlClient) =>
  Effect.tryPromise({
    try: () => {
      const cached = sqliteBindParameterBudgetByClient.get(sql);
      if (cached) {
        return cached;
      }
      const pending = Effect.runPromise(readSqliteBindParameterBudget(sql))
        .then((result) => {
          if (!result.cacheable) {
            sqliteBindParameterBudgetByClient.delete(sql);
          }
          return result.budget;
        })
        .catch((cause) => {
          sqliteBindParameterBudgetByClient.delete(sql);
          throw cause;
        });
      sqliteBindParameterBudgetByClient.set(sql, pending);
      return pending;
    },
    catch: (cause) => cause,
  });

const graphRecordChunkSize = (parameterBudget: number, columnsPerRow: number) =>
  Math.max(1, Math.floor(parameterBudget / columnsPerRow));

const rowPlaceholders = (rowCount: number, columnCount: number) =>
  Array.from({ length: rowCount }, () => `(${placeholders(columnCount)})`).join(", ");

const columnList = (columns: ReadonlyArray<string>) => columns.join(", ");

const insertGraphRecords = (
  sql: SqlClient.SqlClient,
  graph: ExtractedDependencyGraph,
  versionId: string,
  addSymbolKeys: ReadonlySet<string>,
  removeSymbolKeys: ReadonlySet<string>,
  addEdgeKeys: ReadonlySet<string>,
  removeEdgeKeys: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const parameterBudget = yield* loadSqliteBindParameterBudget(sql);
    for (const files of chunksOf(
      graph.files,
      graphRecordChunkSize(parameterBudget, graphRecordColumns.files.length),
    )) {
      yield* sql.unsafe(
        `
        insert or ignore into dependency_graph_files (
          ${columnList(graphRecordColumns.files)}
        ) values ${rowPlaceholders(files.length, graphRecordColumns.files.length)}
      `,
        files.flatMap((file) => [
          file.fileKey,
          file.repoRoot,
          file.path,
          file.contentHash,
          file.tsconfigPath,
        ]),
      );
    }
    for (const symbols of chunksOf(
      graph.symbols,
      graphRecordChunkSize(parameterBudget, graphRecordColumns.symbols.length),
    )) {
      yield* sql.unsafe(
        `
        insert into dependency_graph_symbols (
          ${columnList(graphRecordColumns.symbols)}
        ) values ${rowPlaceholders(symbols.length, graphRecordColumns.symbols.length)}
        on conflict(symbol_key) do update set
          file_key = excluded.file_key,
          name = excluded.name,
          qualified_name = excluded.qualified_name,
          kind = excluded.kind,
          path = excluded.path,
          start_line = excluded.start_line,
          start_column = excluded.start_column,
          end_line = excluded.end_line,
          end_column = excluded.end_column,
          exported = excluded.exported,
          metadata_json = excluded.metadata_json
      `,
        symbols.flatMap((symbol) => [
          symbol.symbolKey,
          symbol.fileKey,
          symbol.name,
          symbol.qualifiedName,
          symbol.kind,
          symbol.path,
          symbol.startLine,
          symbol.startColumn,
          symbol.endLine,
          symbol.endColumn,
          symbol.exported ? 1 : 0,
          symbol.metadataJson,
        ]),
      );
    }
    for (const edges of chunksOf(
      graph.edges,
      graphRecordChunkSize(parameterBudget, graphRecordColumns.edges.length),
    )) {
      yield* sql.unsafe(
        `
        insert into dependency_graph_edges (
          ${columnList(graphRecordColumns.edges)}
        ) values ${rowPlaceholders(edges.length, graphRecordColumns.edges.length)}
        on conflict(edge_key) do update set
          from_symbol_key = excluded.from_symbol_key,
          to_symbol_key = excluded.to_symbol_key,
          kind = excluded.kind,
          source_path = excluded.source_path,
          source_start_line = excluded.source_start_line,
          source_start_column = excluded.source_start_column,
          metadata_json = excluded.metadata_json
      `,
        edges.flatMap((edge) => [
          edge.edgeKey,
          edge.fromSymbolKey,
          edge.toSymbolKey,
          edge.kind,
          edge.sourcePath,
          edge.sourceStartLine,
          edge.sourceStartColumn,
          edge.metadataJson,
        ]),
      );
    }
    for (const symbolKeys of chunksOf(
      [...removeSymbolKeys],
      graphRecordChunkSize(parameterBudget, graphRecordColumns.symbolDeltas.length),
    )) {
      yield* sql.unsafe(
        `
        insert or replace into dependency_graph_symbol_deltas (${columnList(graphRecordColumns.symbolDeltas)})
        values ${rowPlaceholders(symbolKeys.length, graphRecordColumns.symbolDeltas.length)}
      `,
        symbolKeys.flatMap((symbolKey) => [versionId, symbolKey, "remove"]),
      );
    }
    for (const symbolKeys of chunksOf(
      [...addSymbolKeys],
      graphRecordChunkSize(parameterBudget, graphRecordColumns.symbolDeltas.length),
    )) {
      yield* sql.unsafe(
        `
        insert or replace into dependency_graph_symbol_deltas (${columnList(graphRecordColumns.symbolDeltas)})
        values ${rowPlaceholders(symbolKeys.length, graphRecordColumns.symbolDeltas.length)}
      `,
        symbolKeys.flatMap((symbolKey) => [versionId, symbolKey, "add"]),
      );
    }
    for (const edgeKeys of chunksOf(
      [...removeEdgeKeys],
      graphRecordChunkSize(parameterBudget, graphRecordColumns.edgeDeltas.length),
    )) {
      yield* sql.unsafe(
        `
        insert or replace into dependency_graph_edge_deltas (${columnList(graphRecordColumns.edgeDeltas)})
        values ${rowPlaceholders(edgeKeys.length, graphRecordColumns.edgeDeltas.length)}
      `,
        edgeKeys.flatMap((edgeKey) => [versionId, edgeKey, "remove"]),
      );
    }
    for (const edgeKeys of chunksOf(
      [...addEdgeKeys],
      graphRecordChunkSize(parameterBudget, graphRecordColumns.edgeDeltas.length),
    )) {
      yield* sql.unsafe(
        `
        insert or replace into dependency_graph_edge_deltas (${columnList(graphRecordColumns.edgeDeltas)})
        values ${rowPlaceholders(edgeKeys.length, graphRecordColumns.edgeDeltas.length)}
      `,
        edgeKeys.flatMap((edgeKey) => [versionId, edgeKey, "add"]),
      );
    }
  });

const pruneUnreachableGraphRecords = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`
      delete from dependency_graph_edge_deltas
      where edge_key in (
        select edge_key
        from dependency_graph_edge_deltas
        group by edge_key
        having sum(case when op = 'add' then 1 else 0 end) = 0
      )
    `);
    yield* sql.unsafe(`
      delete from dependency_graph_edges
      where edge_key not in (
        select edge_key from dependency_graph_edge_deltas
      )
    `);
    yield* sql.unsafe(`
      delete from dependency_graph_symbol_deltas
      where symbol_key in (
        select symbol_key
        from dependency_graph_symbol_deltas
        group by symbol_key
        having sum(case when op = 'add' then 1 else 0 end) = 0
      )
    `);
    yield* sql.unsafe(`
      delete from dependency_graph_symbols
      where symbol_key not in (
        select symbol_key from dependency_graph_symbol_deltas
      )
    `);
    yield* sql.unsafe(`
      delete from dependency_graph_files
      where not exists (
        select 1
        from dependency_graph_symbols s
        where s.file_key = dependency_graph_files.file_key
      )
    `);
  });

const sleepMillis = (ms: number) =>
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

const graphVersionLeaseExpiresAt = () => now() + graphVersionLeaseSeconds;

const refreshGraphVersionLease = (dbPath: string, versionId: string) =>
  withSqlite(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        update dependency_graph_versions
        set lease_expires_at = ${graphVersionLeaseExpiresAt()}
        where id = ${versionId}
          and status = 'running'
      `;
    }),
  );

const startGraphVersionLeaseHeartbeat = (dbPath: string, versionId: string) => {
  let stopped = false;
  let reportedFailure = false;
  let pendingRefresh = Promise.resolve();
  const refresh = () => {
    pendingRefresh = pendingRefresh
      .then(() =>
        stopped ? undefined : Effect.runPromise(refreshGraphVersionLease(dbPath, versionId)),
      )
      .catch((cause) => {
        if (!reportedFailure) {
          reportedFailure = true;
          console.warn(`Dependency graph lease heartbeat failed for version ${versionId}`, cause);
        }
      });
  };
  const heartbeat = setInterval(refresh, graphVersionHeartbeatMillis);
  refresh();
  return () => {
    stopped = true;
    clearInterval(heartbeat);
    return pendingRefresh;
  };
};

// This persisted marker is part of the retry protocol for waiters that observe
// a failed row after another caller expired an abandoned lease.
const isLeaseExpiredGraphVersion = (version: DependencyGraphVersion) =>
  version.status === "failed" && version.error === graphVersionLeaseExpiredError;

const expireRunningGraphVersion = (sql: SqlClient.SqlClient, version: DependencyGraphVersion) =>
  sql`
    update dependency_graph_versions
    set status = 'failed',
        completed_at = ${now()},
        lease_expires_at = null,
        error = ${graphVersionLeaseExpiredError}
    where id = ${version.id}
      and status = 'running'
      and (lease_expires_at is null or lease_expires_at <= ${now()})
  `;

const waitForGraphVersion = (sql: SqlClient.SqlClient, versionId: string) =>
  Effect.gen(function* () {
    const waitStartedAt = Date.now();
    while (true) {
      const version = yield* loadVersion(sql, versionId);
      if (version.status === "completed") {
        return version;
      }
      if (version.status === "failed") {
        if (isLeaseExpiredGraphVersion(version)) {
          return null;
        }
        return yield* Effect.fail(
          new DependencyGraphFailed({
            message: `Dependency graph build failed for version ${versionId}`,
            cause: version.error,
          }),
        );
      }
      const leaseExpiresAt = version.leaseExpiresAt;
      if (leaseExpiresAt === undefined || leaseExpiresAt === null || leaseExpiresAt <= now()) {
        yield* expireRunningGraphVersion(sql, version);
        const expiredVersion = yield* loadVersion(sql, versionId);
        if (expiredVersion.status === "failed") {
          return null;
        }
      }
      if (Date.now() - waitStartedAt >= graphVersionWaitTimeoutMillis) {
        return yield* Effect.fail(
          new DependencyGraphFailed({
            message: `Timed out waiting for dependency graph version ${versionId}`,
          }),
        );
      }
      yield* sleepMillis(graphVersionPollIntervalMillis);
    }
  });

export const ensureDependencyGraphVersion = (input: {
  readonly repoRoot: string;
  readonly branch: string | null;
  readonly checkpointRef: string;
  readonly checkpointCommit: string;
  readonly diffHash: string;
  readonly dbPath: string;
}): Effect.Effect<DependencyGraphVersion, DependencyGraphFailed | DatabaseMigrationFailed> =>
  withSqlite(
    input.dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* validateCheckpointCommit(input.repoRoot, input.checkpointCommit);

      const priorRows = yield* sql.unsafe<VersionRow>(
        `select *
         from dependency_graph_versions
         where repo_root = ?
           and (branch = ? or (branch is null and ? is null))
           and status = 'completed'
         order by completed_at desc, created_at desc
         limit 50`,
        [input.repoRoot, input.branch, input.branch],
      );
      const prior = yield* firstReachablePriorVersion(
        input.repoRoot,
        input.checkpointCommit,
        priorRows,
      );
      const changedFiles = prior
        ? yield* changedFilesBetween(input.repoRoot, prior.checkpointCommit, input.checkpointCommit)
        : [];
      const mode: DependencyGraphMode =
        prior && !requiresFullRebuild(changedFiles) ? "incremental" : "full";
      const priorSlice =
        mode === "incremental" && prior
          ? yield* loadIncrementalPriorSlice(sql, prior.id, changedFiles)
          : null;
      const versionId = makeId();
      const startedAt = now();
      const leaseExpiresAt = graphVersionLeaseExpiresAt();
      const claim = yield* withImmediateTransaction(
        sql,
        Effect.gen(function* () {
          yield* sql`
            update dependency_graph_versions
            set status = 'failed',
                completed_at = ${now()},
                lease_expires_at = null,
                error = ${graphVersionLeaseExpiredError}
            where repo_root = ${input.repoRoot}
              and checkpoint_commit = ${input.checkpointCommit}
              and status = 'running'
              and (lease_expires_at is null or lease_expires_at <= ${now()})
          `;
          const existing = yield* sql.unsafe<VersionRow>(
            `select *
             from dependency_graph_versions
             where repo_root = ?
               and checkpoint_commit = ?
               and status in ('completed', 'running')
             order by case status when 'completed' then 0 else 1 end, created_at desc
             limit 1`,
            [input.repoRoot, input.checkpointCommit],
          );
          const existingVersion = existing[0] ? toVersion(existing[0]) : null;
          if (existingVersion?.status === "completed") {
            return { _tag: "existing" as const, version: existingVersion };
          }
          if (existingVersion) {
            return { _tag: "existing" as const, version: existingVersion };
          }
          yield* sql`
            insert into dependency_graph_versions (
              id, repo_root, branch, checkpoint_ref, checkpoint_commit, base_version_id,
              diff_hash, mode, status, created_at, completed_at, error
            ) values (
              ${versionId}, ${input.repoRoot}, ${input.branch}, ${input.checkpointRef}, ${input.checkpointCommit},
              ${mode === "incremental" ? prior?.id : null}, ${input.diffHash}, ${mode}, 'running',
              ${startedAt}, null, null
            )
          `;
          yield* sql`
            update dependency_graph_versions
            set lease_expires_at = ${leaseExpiresAt}
            where id = ${versionId}
          `;
          return { _tag: "claimed" as const, versionId };
        }),
      );
      if (claim._tag === "existing") {
        if (claim.version.status === "completed") {
          return claim.version;
        }
        const waitedVersion = yield* waitForGraphVersion(sql, claim.version.id);
        return waitedVersion ?? (yield* ensureDependencyGraphVersion(input));
      }

      const stopLeaseHeartbeat = startGraphVersionLeaseHeartbeat(input.dbPath, versionId);
      const graphExit = yield* Effect.exit(
        Effect.tryPromise({
          try: () => extractDependencyGraphAsync(input.repoRoot),
          catch: (cause) =>
            new DependencyGraphFailed({ message: "Failed to extract dependency graph", cause }),
        }).pipe(Effect.ensuring(Effect.promise(stopLeaseHeartbeat))),
      );
      if (graphExit._tag === "Failure") {
        yield* sql`
          update dependency_graph_versions
          set status = 'failed',
              completed_at = ${now()},
              lease_expires_at = null,
              error = ${String(graphExit.cause)}
          where id = ${versionId}
            and status = 'running'
        `;
        return yield* Effect.failCause(graphExit.cause);
      }
      const graph = graphExit.value;
      const priorSymbols = priorSlice?.symbols ?? [];
      const priorEdges = priorSlice?.edges ?? [];
      const paths = mode === "full" ? null : (priorSlice?.paths ?? new Set<string>());
      const newSymbols =
        paths === null ? graph.symbols : graph.symbols.filter((symbol) => paths.has(symbol.path));
      const newSymbolKeySet = new Set(newSymbols.map((symbol) => symbol.symbolKey));
      const priorSymbolsToRemove =
        paths === null ? [] : priorSymbols.filter((symbol) => paths.has(symbol.path));
      const impactedSymbolIdentities = new Set([
        ...newSymbols.map(dependencyGraphSymbolStableIdentity),
        ...priorSymbolsToRemove.map(dependencyGraphSymbolStableIdentity),
      ]);
      const graphSymbolPathByKey = new Map(
        graph.symbols.map((symbol) => [symbol.symbolKey, symbol.path] as const),
      );
      const graphSymbolIdentityByKey = new Map(
        graph.symbols.map(
          (symbol) => [symbol.symbolKey, dependencyGraphSymbolStableIdentity(symbol)] as const,
        ),
      );
      const edgeTouchesImpactedPath = (edge: DependencyGraphEdge) =>
        paths !== null &&
        (paths.has(edge.sourcePath) ||
          paths.has(graphSymbolPathByKey.get(edge.fromSymbolKey) ?? "") ||
          paths.has(graphSymbolPathByKey.get(edge.toSymbolKey) ?? "") ||
          impactedSymbolIdentities.has(graphSymbolIdentityByKey.get(edge.fromSymbolKey) ?? "") ||
          impactedSymbolIdentities.has(graphSymbolIdentityByKey.get(edge.toSymbolKey) ?? ""));
      const newEdges =
        paths === null
          ? graph.edges
          : graph.edges.filter(
              (edge) =>
                edgeTouchesImpactedPath(edge) ||
                newSymbolKeySet.has(edge.fromSymbolKey) ||
                newSymbolKeySet.has(edge.toSymbolKey),
            );
      const priorSymbolRemoveKeySet = new Set(
        priorSymbolsToRemove.map((symbol) => symbol.symbolKey),
      );
      const priorEdgesToRemove =
        paths === null
          ? []
          : priorEdges.filter(
              (edge) =>
                paths.has(edge.sourcePath) ||
                priorSymbolRemoveKeySet.has(edge.fromSymbolKey) ||
                priorSymbolRemoveKeySet.has(edge.toSymbolKey),
            );

      yield* withImmediateTransaction(
        sql,
        Effect.gen(function* () {
          const activeClaim = yield* sql.unsafe<{ readonly id: string }>(
            `select id
             from dependency_graph_versions
             where id = ?
               and status = 'running'
             limit 1`,
            [versionId],
          );
          if (activeClaim.length === 0) {
            return yield* Effect.fail(
              new DependencyGraphFailed({
                message: `Dependency graph build lease expired before completing version ${versionId}`,
              }),
            );
          }
          yield* sql`
            update dependency_graph_versions
            set lease_expires_at = ${graphVersionLeaseExpiresAt()}
            where id = ${versionId}
              and status = 'running'
          `;
          yield* insertGraphRecords(
            sql,
            {
              files: graph.files.filter((file) => paths === null || paths.has(file.path)),
              symbols: newSymbols,
              edges: newEdges,
            },
            versionId,
            newSymbolKeySet,
            priorSymbolRemoveKeySet,
            new Set(newEdges.map((edge) => edge.edgeKey)),
            new Set(priorEdgesToRemove.map((edge) => edge.edgeKey)),
          );
          yield* sql`
            update dependency_graph_versions
            set status = 'completed',
                completed_at = ${now()},
                lease_expires_at = null,
                diff_hash = ${input.diffHash || graphFingerprint(graph)}
            where id = ${versionId}
              and status = 'running'
          `;
        }),
      );
      const pruneExit = yield* Effect.exit(pruneUnreachableGraphRecords(sql));
      if (pruneExit._tag === "Failure") {
        console.warn(
          `Dependency graph record pruning failed for version ${versionId}`,
          pruneExit.cause,
        );
      }
      return yield* loadVersion(sql, versionId);
    }).pipe(
      Effect.catch((cause) =>
        Effect.fail(
          cause instanceof DependencyGraphFailed
            ? cause
            : new DependencyGraphFailed({ message: "Failed to build dependency graph", cause }),
        ),
      ),
    ),
  );

const loadActiveSymbolByKey = (
  sql: SqlClient.SqlClient,
  chain: ReadonlyArray<DependencyGraphVersion>,
  symbolKey: string,
) =>
  sql
    .unsafe<SymbolRow>(
      `${versionChainCte(chain)}
       select s.*
       from dependency_graph_symbols s
       where s.symbol_key = ?
         and ${activeSymbolPredicate("s")}
       limit 1`,
      [...versionChainParams(chain), symbolKey],
    )
    .pipe(Effect.map((rows) => (rows[0] ? toSymbol(rows[0]) : null)));

export const lookupDependencyGraphSymbolEffect = (input: {
  readonly versionId: string;
  readonly name?: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly limit?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const chain = yield* loadVersionChainCached(sql, input.versionId);
    const conditions = [activeSymbolPredicate("s")];
    const parameters: Array<number | string> = [...versionChainParams(chain)];
    if (input.name) {
      conditions.push(
        "(s.name = ? or s.qualified_name = ? or s.qualified_name like ? escape '\\')",
      );
      parameters.push(input.name, input.name, `%.${escapeLike(input.name)}`);
    }
    if (input.file) {
      conditions.push("s.path = ?");
      parameters.push(input.file);
    }
    if (input.line) {
      conditions.push("s.start_line <= ? and s.end_line >= ?");
      parameters.push(input.line, input.line);
      if (input.column) {
        conditions.push(
          "((s.start_line < ? or s.start_column <= ?) and (s.end_line > ? or s.end_column >= ?))",
        );
        parameters.push(input.line, input.column, input.line, input.column);
      }
    } else if (input.column) {
      return yield* Effect.fail(
        new DependencyGraphFailed({
          message: "Symbol lookup column requires line",
        }),
      );
    }
    parameters.push(input.limit ?? 20);
    const symbols = yield* sql.unsafe<SymbolRow>(
      `${versionChainCte(chain)}
	         select s.*
	         from dependency_graph_symbols s
	         where ${conditions.join("\n           and ")}
	         order by s.path asc, s.start_line asc
	         limit ?`,
      parameters,
    );
    return {
      versionId: chain[chain.length - 1]!.id,
      symbols: symbols.map(toSymbol),
    } satisfies SymbolLookupResult;
  });

export const lookupDependencyGraphSymbol = (
  input: Parameters<typeof lookupDependencyGraphSymbolEffect>[0] & { readonly dbPath: string },
) => withSqlite(input.dbPath, lookupDependencyGraphSymbolEffect(input));

export const getSymbolDependenciesEffect = (input: {
  readonly versionId: string;
  readonly symbolKey: string;
  readonly edgeKinds?: ReadonlyArray<DependencyEdgeKind>;
  readonly limit?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const chain = yield* loadVersionChainCached(sql, input.versionId);
    const edgeKindFilter = input.edgeKinds?.length
      ? `and e.kind in (${placeholders(input.edgeKinds.length)})`
      : "";
    const parameters: Array<number | string> = [
      ...versionChainParams(chain),
      input.symbolKey,
      ...(input.edgeKinds ?? []),
      input.limit ?? 100,
    ];
    const edgeRows = yield* sql.unsafe<JoinedEdgeSymbolRow>(
      `${versionChainCte(chain)}
         select e.*, ${joinedSymbolProjection}
         from dependency_graph_edges e
         join dependency_graph_symbols s on s.symbol_key = e.to_symbol_key
	         where e.from_symbol_key = ?
	           ${edgeKindFilter}
	           and ${activeEdgePredicate("e")}
	           and ${activeSymbolPredicate("s")}
	         limit ?`,
      parameters,
    );
    const symbol = yield* loadActiveSymbolByKey(sql, chain, input.symbolKey);
    const edges = edgeRows.map((row) => ({
      ...toEdge(row),
      target: toJoinedSymbol(row),
    }));
    return {
      versionId: chain[chain.length - 1]!.id,
      symbol,
      edges,
    } satisfies SymbolDependenciesResult;
  });

export const getSymbolDependencies = (
  input: Parameters<typeof getSymbolDependenciesEffect>[0] & { readonly dbPath: string },
) => withSqlite(input.dbPath, getSymbolDependenciesEffect(input));

export const getSymbolDependentsEffect = (input: {
  readonly versionId: string;
  readonly symbolKey: string;
  readonly edgeKinds?: ReadonlyArray<DependencyEdgeKind>;
  readonly limit?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const chain = yield* loadVersionChainCached(sql, input.versionId);
    const edgeKindFilter = input.edgeKinds?.length
      ? `and e.kind in (${placeholders(input.edgeKinds.length)})`
      : "";
    const parameters: Array<number | string> = [
      ...versionChainParams(chain),
      input.symbolKey,
      ...(input.edgeKinds ?? []),
      input.limit ?? 100,
    ];
    const edgeRows = yield* sql.unsafe<JoinedEdgeSymbolRow>(
      `${versionChainCte(chain)}
         select e.*, ${joinedSymbolProjection}
         from dependency_graph_edges e
         join dependency_graph_symbols s on s.symbol_key = e.from_symbol_key
	         where e.to_symbol_key = ?
	           ${edgeKindFilter}
	           and ${activeEdgePredicate("e")}
	           and ${activeSymbolPredicate("s")}
	         limit ?`,
      parameters,
    );
    const symbol = yield* loadActiveSymbolByKey(sql, chain, input.symbolKey);
    const edges = edgeRows.map((row) => ({
      ...toEdge(row),
      source: toJoinedSymbol(row),
    }));
    return {
      versionId: chain[chain.length - 1]!.id,
      symbol,
      edges,
    } satisfies SymbolDependentsResult;
  });

export const getSymbolDependents = (
  input: Parameters<typeof getSymbolDependentsEffect>[0] & { readonly dbPath: string },
) => withSqlite(input.dbPath, getSymbolDependentsEffect(input));
