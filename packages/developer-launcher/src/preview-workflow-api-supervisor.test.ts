import { NodeFileSystem, NodeHttpClient, NodeServices } from "@effect/platform-node";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/unstable/sql";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";
import { it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pack } from "msgpackr";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { TestClock } from "effect/testing";
import {
  sheetDbMigrationArtifactSources,
  sheetDbMigrationArtifacts,
} from "sheet-db-schema/migrations";
import { startLongLivedProcess } from "./executor";
import {
  makePreviewSessionController,
  previewSupervisorLeaseMs,
  PreviewSessionError,
  type PreviewSession,
} from "./preview-sessions";
import type { ConnectedPreviewConfig } from "./connected-preview";
import { previewSharedWorkflowGroupTarget } from "./preview-shared-workflow";
import { sheetWorkflowContractCatalogDigest } from "sheet-workflows/catalog-identity";
import {
  PreviewWorkflowApiHostError,
  makePreviewWorkflowApiSupervisorAdapters,
  previewWorkflowApiRegisteredMigrationsMatch,
  previewWorkflowApiSourceRevisionFromFiles,
  previewWorkflowApiSourceSnapshot,
  previewWorkflowApiSourceRoots,
  stagePreviewWorkflowApiCandidate,
  type PreviewWorkflowApiRuntimeArtifactAttestations,
  type PreviewWorkflowApiRouteRemovalInput,
} from "./preview-workflow-api-host";
import {
  makePreviewWorkflowApiSupervisor,
  makePreviewWorkflowApiSupervisorError,
  PreviewWorkflowApiSupervisorError,
  previewWorkflowApiCredentialMatchesDatabaseTarget,
  previewWorkflowApiDatabaseEndpointIdentity,
  previewWorkflowApiProcessRequest,
  stopFailedPreviewWorkflowApiSupervisorSession,
  type PreviewWorkflowApiProcess,
  type PreviewWorkflowApiReadiness,
} from "./preview-workflow-api-supervisor";

const digest = (char: string): `sha256:${string}` => `sha256:${char.repeat(64)}`;
const endpoint = "https://workflow-api.dev.tiara-stack.moe";
const databaseEndpoint = "postgres://workflows.dev.tiara-stack.moe/tiara";
const databaseEndpointIdentity =
  previewWorkflowApiDatabaseEndpointIdentity(databaseEndpoint) ?? digest("f");
const apiDigest = digest("b");
const manifestDigest = digest("a");
const contractDigest: `sha256:${string}` = sheetWorkflowContractCatalogDigest;
const schemaDigest = digest("d");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sheetWorkflowsRequire = createRequire(
  path.join(repositoryRoot, "packages/sheet-workflows/package.json"),
);
const nodePostgresRequire = createRequire(sheetWorkflowsRequire.resolve("@effect/sql-pg"));
type NodePostgresConnectionParameters = new (connectionString: string) => {
  readonly ssl: unknown;
};
const nodePostgresConnectionParameters: unknown = nodePostgresRequire(
  "pg/lib/connection-parameters",
);
const isNodePostgresConnectionParameters = (
  value: unknown,
): value is NodePostgresConnectionParameters => typeof value === "function";
if (!isNodePostgresConnectionParameters(nodePostgresConnectionParameters))
  throw new Error("node-postgres ConnectionParameters is unavailable through PgClient");
const NodePostgresConnectionParameters = nodePostgresConnectionParameters;
const workspacePackageManifestSchema = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const writeWorkspaceDependencyLinks = (fileSystem: FileSystem.FileSystem, checkout: string) =>
  Effect.gen(function* () {
    const pending = ["sheet-workflows"];
    const visited = new Set<string>();
    const createdLinks = new Set<string>();
    while (pending.length > 0) {
      const packageName = pending.pop()!;
      if (visited.has(packageName)) continue;
      visited.add(packageName);
      const manifestPath = path.join(checkout, "packages", packageName, "package.json");
      const manifestContents: unknown = JSON.parse(yield* fileSystem.readFileString(manifestPath));
      const manifest = Schema.decodeUnknownSync(workspacePackageManifestSchema)(manifestContents);
      const dependencies = [
        ...Object.entries(manifest.dependencies ?? {}),
        ...Object.entries(manifest.optionalDependencies ?? {}),
        ...Object.entries(manifest.peerDependencies ?? {}),
      ];
      for (const [dependencyName, version] of dependencies) {
        if (!version.startsWith("workspace:")) continue;
        const link = path.join(checkout, "packages", packageName, "node_modules", dependencyName);
        if (!createdLinks.has(link)) {
          yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
          const target = path.join(checkout, "packages", dependencyName);
          yield* fileSystem.symlink(path.relative(path.dirname(link), target), link);
          createdLinks.add(link);
        }
        pending.push(dependencyName);
      }
    }
  });

type WorkflowApiFixtureMigration = {
  readonly id: number;
  readonly relativePath: string;
  readonly source: string;
  readonly digest: string;
};

type WorkflowApiSourceFixture = {
  readonly checkout: string;
  readonly storeDirectory: string;
  readonly trustedRuntimeArtifactAttestations: PreviewWorkflowApiRuntimeArtifactAttestations;
  readonly authSource: string;
  readonly dependencySource: string;
  readonly dependencyBinSource: string;
  readonly migrationPath: string;
  readonly migrationSources: ReadonlyArray<WorkflowApiFixtureMigration>;
};

const candidateDependencyIntegrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
const tsxIntegrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;

type WorkflowApiFixturePackageIndex = {
  readonly algo: string;
  readonly files: Readonly<
    Record<string, { readonly digest: string; readonly size: number; readonly mode: number }>
  >;
  readonly manifest: { readonly name: string; readonly version: string };
};

const workflowApiFixtureRuntimeDigest = (
  files: Readonly<
    Record<string, { readonly digest: string; readonly size: number; readonly mode: number }>
  >,
  executablePaths: ReadonlySet<string> = new Set(),
) => {
  const digest = createHash("sha256");
  const update = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    digest.update(length).update(bytes);
  };
  update("tiara-preview-package-runtime-files-v1");
  for (const relativePath of Object.keys(files).sort()) {
    const file = files[relativePath]!;
    update(relativePath);
    update(file.digest);
    update(String(file.size));
    update(String(executablePaths.has(relativePath) ? file.mode | 0o111 : file.mode));
  }
  return `sha256:${digest.digest("hex")}`;
};

const workflowApiFixturePackageIndex = (
  fileSystem: FileSystem.FileSystem,
  storeDirectory: string,
  packageRoot: string,
  name: string,
  version: string,
) =>
  Effect.gen(function* () {
    const files: Record<
      string,
      { readonly digest: string; readonly size: number; readonly mode: number }
    > = {};
    const visit = (directory: string, prefix: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const children = yield* fileSystem.readDirectory(directory);
        yield* Effect.forEach([...children].sort(), (child) =>
          Effect.gen(function* () {
            if (child === "node_modules" || child === ".bin") return;
            const absolute = path.join(directory, child);
            const relativePath = prefix.length === 0 ? child : `${prefix}/${child}`;
            const info = yield* fileSystem.stat(absolute);
            if (info.type === "Directory") return yield* visit(absolute, relativePath);
            const bytes = yield* fileSystem.readFile(absolute);
            const digest = createHash("sha512").update(bytes).digest("hex");
            const storePath = path.join(
              storeDirectory,
              "files",
              digest.slice(0, 2),
              digest.slice(2),
            );
            yield* fileSystem.makeDirectory(path.dirname(storePath), { recursive: true });
            yield* fileSystem.writeFile(storePath, bytes);
            files[relativePath] = {
              digest,
              size: bytes.byteLength,
              mode: info.mode & 0o777,
            };
          }),
        );
      });
    yield* visit(packageRoot, "");
    return {
      algo: "sha512",
      files,
      manifest: { name, version },
    };
  });

const writeWorkflowApiPnpmStoreIndex = (
  fileSystem: FileSystem.FileSystem,
  storeDirectory: string,
  checkout: string,
) =>
  Effect.gen(function* () {
    const packages = yield* Effect.forEach(
      [
        {
          name: "candidate-dependency",
          version: "1.0.0",
          integrity: candidateDependencyIntegrity,
          packageRoot: path.join(
            checkout,
            "node_modules/.pnpm/candidate-dependency@1.0.0/node_modules/candidate-dependency",
          ),
        },
        {
          name: "tsx",
          version: "4.22.3",
          integrity: tsxIntegrity,
          packageRoot: path.join(checkout, "node_modules/.pnpm/tsx@4.22.3/node_modules/tsx"),
        },
      ],
      (packageInfo) =>
        Effect.map(
          workflowApiFixturePackageIndex(
            fileSystem,
            storeDirectory,
            packageInfo.packageRoot,
            packageInfo.name,
            packageInfo.version,
          ),
          (index) => ({ ...packageInfo, index }),
        ),
      { concurrency: 1 },
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      yield* sql`CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID`;
      yield* Effect.forEach(
        packages,
        ({ integrity, name, version, index }) =>
          sql`INSERT INTO package_index (key, data) VALUES (${`${integrity}\t${name}@${version}`}, ${pack(index)})`,
      );
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          filename: path.join(storeDirectory, "index.db"),
          disableWAL: true,
        }),
      ),
    );
    return packages;
  });

const updateWorkflowApiPnpmStoreIndex = (
  storeDirectory: string,
  packageInfo: {
    readonly integrity: string;
    readonly name: string;
    readonly version: string;
    readonly index: WorkflowApiFixturePackageIndex;
  },
) =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      yield* sql`INSERT INTO package_index (key, data) VALUES (${`${packageInfo.integrity}\t${packageInfo.name}@${packageInfo.version}`}, ${pack(packageInfo.index)}) ON CONFLICT(key) DO UPDATE SET data = excluded.data`;
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          filename: path.join(storeDirectory, "index.db"),
          disableWAL: true,
        }),
      ),
    );
  });

const writeWorkflowApiSourceRoots = (fileSystem: FileSystem.FileSystem, checkout: string) =>
  Effect.gen(function* () {
    const storeDirectory = `${checkout}-pnpm-store`;
    yield* fileSystem.makeDirectory(storeDirectory, { recursive: true });
    for (const root of previewWorkflowApiSourceRoots) {
      const target = path.resolve(checkout, root);
      if (path.extname(root) !== "") {
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        const packageName = root.match(/^packages\/([^/]+)\/package\.json$/)?.[1];
        let contents: string;
        if (root === "package.json") {
          contents = JSON.stringify({
            name: "workflow-api-fixture",
            devDependencies: { tsx: "4.22.3" },
          });
        } else if (packageName === "sheet-workflows") {
          contents = JSON.stringify({
            name: packageName,
            dependencies: {
              "sheet-auth": "workspace:*",
              "candidate-dependency": "1.0.0",
            },
          });
        } else if (packageName === "sheet-auth") {
          contents = JSON.stringify({
            name: packageName,
            exports: {
              "./oauth-resource-authorization": {
                development: "./src/oauth-resource-authorization.mjs",
                default: "./src/oauth-resource-authorization.mjs",
              },
            },
          });
        } else if (packageName === undefined) {
          contents = "{}\n";
        } else {
          contents = JSON.stringify({ name: packageName });
        }
        yield* fileSystem.writeFileString(target, contents);
      } else {
        yield* fileSystem.makeDirectory(target, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(target, "source.ts"),
          "export const source = 1;\n",
        );
      }
    }
    yield* fileSystem.makeDirectory(path.join(checkout, "node_modules/.pnpm"), { recursive: true });
    yield* fileSystem.makeDirectory(path.join(checkout, "node_modules/.bin"), { recursive: true });
    const lockfile =
      `lockfileVersion: '9.0'\n` +
      `importers:\n` +
      `  .:\n` +
      `    devDependencies:\n` +
      `      tsx:\n` +
      `        specifier: 4.22.3\n` +
      `        version: 4.22.3\n` +
      `  packages/sheet-workflows:\n` +
      `    dependencies:\n` +
      `      sheet-auth:\n` +
      `        specifier: workspace:*\n` +
      `        version: link:../sheet-auth\n` +
      `      candidate-dependency:\n` +
      `        specifier: 1.0.0\n` +
      `        version: 1.0.0\n` +
      `  packages/sheet-auth: {}\n` +
      `packages:\n` +
      `  candidate-dependency@1.0.0:\n` +
      `    resolution:\n` +
      `      integrity: ${candidateDependencyIntegrity}\n` +
      `  tsx@4.22.3:\n` +
      `    resolution:\n` +
      `      integrity: ${tsxIntegrity}\n` +
      `snapshots:\n` +
      `  candidate-dependency@1.0.0: {}\n` +
      `  tsx@4.22.3: {}\n`;
    yield* fileSystem.writeFileString(path.join(checkout, "pnpm-lock.yaml"), lockfile);
    yield* fileSystem.writeFileString(
      path.join(checkout, "node_modules/.pnpm/lock.yaml"),
      lockfile,
    );
    yield* fileSystem.writeFileString(
      path.join(checkout, "node_modules/.modules.yaml"),
      JSON.stringify({
        storeDir: storeDirectory,
        virtualStoreDir: ".pnpm",
        virtualStoreDirMaxLength: 120,
      }),
    );

    const tsxPackageRoot = path.join(checkout, "node_modules/.pnpm/tsx@4.22.3/node_modules/tsx");
    yield* fileSystem.makeDirectory(path.join(tsxPackageRoot, "dist"), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(tsxPackageRoot, "package.json"),
      '{"name":"tsx","version":"4.22.3","bin":"dist/cli.mjs"}\n',
    );
    yield* fileSystem.writeFileString(
      path.join(tsxPackageRoot, "dist/cli.mjs"),
      "process.exit(0);\n",
    );
    yield* fileSystem.chmod(path.join(tsxPackageRoot, "dist/cli.mjs"), 0o755);
    yield* fileSystem.writeFileString(path.join(tsxPackageRoot, "dist/loader.mjs"), "export {};\n");
    const tsxLink = path.join(checkout, "node_modules/tsx");
    yield* fileSystem.symlink(path.relative(path.dirname(tsxLink), tsxPackageRoot), tsxLink);
    const dependencySource = path.join(
      checkout,
      "node_modules/.pnpm/candidate-dependency@1.0.0/node_modules/candidate-dependency/index.mjs",
    );
    const dependencyPackageRoot = path.dirname(dependencySource);
    yield* fileSystem.makeDirectory(dependencyPackageRoot, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(dependencyPackageRoot, "package.json"),
      '{"name":"candidate-dependency","version":"1.0.0","type":"module","exports":"./index.mjs"}\n',
    );
    yield* fileSystem.writeFileString(dependencySource, "export const revision = 1;\n");
    const workflowDependencyLink = path.join(
      checkout,
      "packages/sheet-workflows/node_modules/candidate-dependency",
    );
    yield* fileSystem.makeDirectory(path.dirname(workflowDependencyLink), { recursive: true });
    yield* fileSystem.symlink(
      path.relative(path.dirname(workflowDependencyLink), dependencyPackageRoot),
      workflowDependencyLink,
    );
    const dependencyBinSource = path.join(
      checkout,
      "node_modules/.pnpm/candidate-bin@1.0.0/node_modules/candidate-bin/bin.mjs",
    );
    const dependencyBinRoot = path.dirname(dependencyBinSource);
    yield* fileSystem.makeDirectory(dependencyBinRoot, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(dependencyBinRoot, "package.json"),
      '{"name":"candidate-bin","version":"1.0.0","type":"module"}\n',
    );
    yield* fileSystem.writeFileString(dependencyBinSource, "export const binRevision = 1;\n");
    const binLink = path.join(checkout, "node_modules/.bin/candidate-bin");
    yield* fileSystem.symlink(path.relative(path.dirname(binLink), dependencyBinSource), binLink);
    yield* writeWorkspaceDependencyLinks(fileSystem, checkout);
    const packageIndexes = yield* writeWorkflowApiPnpmStoreIndex(
      fileSystem,
      storeDirectory,
      checkout,
    );
    const packageAttestations = Object.fromEntries(
      packageIndexes.map(({ integrity, name, version, index }) => [
        `${name}@${version}`,
        {
          integrity,
          runtimeDigest: workflowApiFixtureRuntimeDigest(
            index.files,
            name === "tsx" ? new Set(["dist/cli.mjs"]) : new Set(),
          ),
        },
      ]),
    );
    yield* fileSystem.writeFileString(
      path.join(checkout, "preview-workflow-api-runtime-attestations.json"),
      '{"schemaVersion":1,"packages":{}}\n',
    );
    yield* fileSystem.writeFileString(
      path.join(checkout, ".env"),
      "SHEET_BOT_BASE_URL=https://untracked.invalid\n",
    );
    return {
      storeDirectory,
      trustedRuntimeArtifactAttestations: {
        schemaVersion: 1,
        packages: packageAttestations,
      } satisfies PreviewWorkflowApiRuntimeArtifactAttestations,
    };
  });

const makeWorkflowApiFixtureMigrations = (): ReadonlyArray<WorkflowApiFixtureMigration> =>
  sheetDbMigrationArtifacts.map(([id, , , relativePath]) => {
    const source = `export const migration = ${id};\n`;
    return {
      id,
      relativePath,
      source,
      digest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    };
  });

const writeWorkflowApiMigrationFixture = (
  fileSystem: FileSystem.FileSystem,
  checkout: string,
  migrations: ReadonlyArray<WorkflowApiFixtureMigration>,
) =>
  Effect.gen(function* () {
    for (const migration of migrations) {
      const target = path.resolve(checkout, migration.relativePath);
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      yield* fileSystem.writeFileString(target, migration.source);
    }
    yield* fileSystem.writeFileString(
      path.resolve(checkout, "packages/sheet-db-schema/src/migration-artifact-manifest.json"),
      `${JSON.stringify({
        sources: migrations.map(({ relativePath, digest }) => [relativePath, digest]),
      })}\n`,
    );
  });

const makeWorkflowApiSourceFixture = (fileSystem: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "workflow-api-source-" });
    const { storeDirectory, trustedRuntimeArtifactAttestations } =
      yield* writeWorkflowApiSourceRoots(fileSystem, checkout);
    const migrationSources = makeWorkflowApiFixtureMigrations();
    yield* writeWorkflowApiMigrationFixture(fileSystem, checkout, migrationSources);
    const authSource = path.join(
      checkout,
      "packages/sheet-auth/src/oauth-resource-authorization.mjs",
    );
    yield* fileSystem.writeFileString(authSource, "export const policyRevision = 1;\n");
    const dependencySource = path.join(
      checkout,
      "node_modules/.pnpm/candidate-dependency@1.0.0/node_modules/candidate-dependency/index.mjs",
    );
    const dependencyBinSource = path.join(
      checkout,
      "node_modules/.pnpm/candidate-bin@1.0.0/node_modules/candidate-bin/bin.mjs",
    );
    return {
      checkout,
      storeDirectory,
      trustedRuntimeArtifactAttestations,
      authSource,
      dependencySource,
      dependencyBinSource,
      migrationPath: migrationSources[0]!.relativePath,
      migrationSources,
    } satisfies WorkflowApiSourceFixture;
  });

const previewWorkflowApiFixtureSourceSnapshot = (
  fileSystem: FileSystem.FileSystem,
  fixture: WorkflowApiSourceFixture,
  trustedRuntimeArtifactAttestations = fixture.trustedRuntimeArtifactAttestations,
) =>
  previewWorkflowApiSourceSnapshot(
    fileSystem,
    fixture.checkout,
    trustedRuntimeArtifactAttestations,
  );

const stageWorkflowApiFixtureCandidate = (
  fileSystem: FileSystem.FileSystem,
  fixture: WorkflowApiSourceFixture,
  expectedRevision: string,
  expectedSchemaArtifactDigest: string,
  trustedRuntimeArtifactAttestations = fixture.trustedRuntimeArtifactAttestations,
) =>
  stagePreviewWorkflowApiCandidate(
    fileSystem,
    fixture.checkout,
    expectedRevision,
    expectedSchemaArtifactDigest,
    trustedRuntimeArtifactAttestations,
  );

const runtimeSourceMutations: ReadonlyArray<readonly [string, string]> = [
  ["packages/sheet-workflows/package.json", "update package exports"],
  ["packages/effect-zero-workflow/package.json", "update package exports"],
  ["packages/effect-zero-workflow/src/store.ts", "export const storeRevision = 2;\n"],
  ["packages/effect-zero/package.json", "update package exports"],
  ["packages/effect-zero/src/index.ts", "export const effectZeroRevision = 2;\n"],
  ["packages/effect-sql-kit/package.json", "update package exports"],
  ["packages/effect-sql-kit/src/index.ts", "export const effectSqlKitRevision = 2;\n"],
  ["packages/sheet-db-schema/src/admission/source.ts", "export const admission = 2;\n"],
  ["packages/sheet-zero-server/src/workflows.ts", "export const routeRevision = 2;\n"],
  ["packages/sheet-bot-api/src/index.ts", "export const botRevision = 2;\n"],
  ["packages/sheet-domain/src/index.ts", "export const domainRevision = 2;\n"],
  ["packages/sheet-message-content/src/text.ts", "export const contentRevision = 2;\n"],
  ["packages/typhoon-core/src/config/index.ts", "export const configRevision = 2;\n"],
  ["packages/typhoon-zero/src/schema/index.ts", "export const schemaRevision = 2;\n"],
  ["packages/effect-sql-schema/src/index.mts", "export const sqlSchemaRevision = 2;\n"],
  ["pnpm-lock.yaml", "append lock comment"],
];

const applyRuntimeSourceMutations = (fileSystem: FileSystem.FileSystem, checkout: string) =>
  Effect.gen(function* () {
    for (const [relativePath, contents] of runtimeSourceMutations) {
      expect(
        previewWorkflowApiSourceRoots.some(
          (sourceRoot) => relativePath === sourceRoot || relativePath.startsWith(`${sourceRoot}/`),
        ),
        relativePath,
      ).toBe(true);
      const target = path.resolve(checkout, relativePath);
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      if (relativePath.endsWith("package.json")) {
        const manifest = Schema.decodeUnknownSync(
          Schema.Struct({
            name: Schema.String,
            dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
            optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
            devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
            peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
            exports: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
          }),
        )(JSON.parse(yield* fileSystem.readFileString(target)));
        yield* fileSystem.writeFileString(
          target,
          JSON.stringify({
            ...manifest,
            exports: { ...manifest.exports, "./identity-test": "./identity-test.ts" },
          }),
        );
      } else if (relativePath === "pnpm-lock.yaml") {
        const updatedLock = `${yield* fileSystem.readFileString(target)}\n# runtime identity mutation\n`;
        yield* fileSystem.writeFileString(target, updatedLock);
        yield* fileSystem.writeFileString(
          path.join(checkout, "node_modules/.pnpm/lock.yaml"),
          updatedLock,
        );
      } else {
        yield* fileSystem.writeFileString(target, contents);
      }
    }
  });

const expectInvalidWorkspaceLink = (
  fileSystem: FileSystem.FileSystem,
  fixture: WorkflowApiSourceFixture,
  target: string,
  revision: string,
  schemaArtifactDigest: string,
) =>
  Effect.gen(function* () {
    const link = path.join(fixture.checkout, "packages/sheet-workflows/node_modules/sheet-auth");
    yield* fileSystem.remove(link);
    yield* fileSystem.symlink(target, link);
    const staged = yield* Effect.exit(
      stageWorkflowApiFixtureCandidate(fileSystem, fixture, revision, schemaArtifactDigest),
    );
    expect(Exit.isFailure(staged)).toBe(true);
    if (Exit.isFailure(staged)) {
      const error = Option.getOrUndefined(Cause.findErrorOption(staged.cause));
      expect(error).toMatchObject({ phase: expect.stringContaining("workspace-dependency-link") });
    }
  });

const runCandidatePackageNameImport = (
  fileSystem: FileSystem.FileSystem,
  candidate: string,
  authSource: string,
  dependencySource: string,
  expectedDependencyRevision = "1",
) =>
  Effect.gen(function* () {
    expect(yield* fileSystem.exists(path.join(candidate, ".env"))).toBe(false);
    const stagedSource = path.join(
      candidate,
      "packages/sheet-auth/src/oauth-resource-authorization.mjs",
    );
    expect(yield* fileSystem.readFileString(stagedSource)).toBe(
      "export const policyRevision = 1;\n",
    );
    yield* fileSystem.writeFileString(authSource, "export const policyRevision = 2;\n");
    const entry = path.join(candidate, "packages/sheet-workflows/candidate-entry.mjs");
    yield* fileSystem.writeFileString(
      entry,
      "await new Promise((resolve) => setTimeout(resolve, 200));\n" +
        'const { policyRevision } = await import("sheet-auth/oauth-resource-authorization");\n' +
        'const { revision } = await import("candidate-dependency");\n' +
        "console.log(`${policyRevision}:${revision}`);\n",
    );
    const child = yield* Effect.tryPromise({
      try: () =>
        startLongLivedProcess({
          command: process.execPath,
          args: ["--conditions=development", entry],
          cwd: path.join(candidate, "packages/sheet-workflows"),
          env: { NODE_OPTIONS: "" },
          environmentInheritance: "web-preview",
          timeoutMs: 10_000,
          kind: "dependency-check",
          readOnly: true,
          output: "capture",
        }),
      catch: (cause) => cause,
    });
    const result = yield* Effect.tryPromise({
      try: () => child.exited,
      catch: (cause) => cause,
    });
    yield* fileSystem.writeFileString(authSource, "export const policyRevision = 1;\n");
    yield* fileSystem.writeFileString(dependencySource, "export const revision = 2;\n");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout?.trim()).toBe(`1:${expectedDependencyRevision}`);
  });

const group = {
  sessionId: "123e4567-e89b-42d3-a456-426614174000",
  generation: 1,
  groupId: "workflow-execution" as const,
  endpoint,
  databaseEndpointIdentity,
  stateIdentity: "shared-workflow-state",
  deployedManifestDigest: manifestDigest,
  schemaArtifactDigest: schemaDigest,
  apiArtifactDigest: apiDigest,
  workflowContractCatalogDigest: contractDigest,
};
const workflowTarget = previewSharedWorkflowGroupTarget(group);
const config: ConnectedPreviewConfig = {
  schemaVersion: 1,
  environment: "tiara-stack-dev",
  profile: "connected-preview-dev-v1",
  owner: "owner",
  roles: ["sheet-workflows-api"],
  hostListeners: [
    {
      role: "sheet-workflows-api",
      host: "127.0.0.1",
      port: 43123,
      processId: "workflow-api",
    },
  ],
  identities: {
    sourceRevision: "revision-a",
    artifactDigests: { "sheet-workflows-api": apiDigest },
    deployedManifestDigest: manifestDigest,
    schemaArtifactDigest: schemaDigest,
    workflowContractCatalogDigest: contractDigest,
    catalogVersion: 1,
  },
  environmentFileInputs: [],
  groups: [
    {
      id: "application-zero",
      ownership: "reused",
      endpoint: "https://zero.dev.tiara-stack.moe",
      stateIdentity: "shared-zero-state",
      deployedManifestDigest: manifestDigest,
      schemaArtifactDigest: schemaDigest,
    },
    {
      id: "auth",
      ownership: "reused",
      endpoint: "https://auth.dev.tiara-stack.moe",
      stateIdentity: "shared-auth-state",
      deployedManifestDigest: manifestDigest,
      schemaArtifactDigest: schemaDigest,
    },
    {
      id: "workflow-execution",
      ownership: "reused",
      endpoint,
      stateIdentity: group.stateIdentity,
      deployedManifestDigest: manifestDigest,
      schemaArtifactDigest: schemaDigest,
      workflowContractCatalogDigest: contractDigest,
    },
  ],
  changes: [
    {
      role: "sheet-workflows-api",
      contract: "workflow.enqueue",
      classification: "compatible",
      sourceRevision: "revision-a",
      artifactDigest: apiDigest,
      deployedManifestDigest: manifestDigest,
      catalogVersion: 1,
    },
    {
      role: "sheet-workflows-api",
      contract: "workflow.execution",
      classification: "compatible",
      sourceRevision: "revision-a",
      artifactDigest: apiDigest,
      deployedManifestDigest: manifestDigest,
      catalogVersion: 1,
    },
  ],
  credentialReferences: {
    "sheet-workflows-api": {
      "workflow-database": "secret://tiara-stack-dev/workflows/database",
      "internal-oauth-client": "secret://tiara-stack-dev/workflows/oauth",
      "workload-identity": "secret://tiara-stack-dev/workflows/identity",
    },
  },
  sharedExecution: "producer-only",
};

const readiness = (
  sessionId: string,
  generation: number,
  revision: string,
  catalogDigest = contractDigest,
  groupTarget = workflowTarget,
): PreviewWorkflowApiReadiness => ({
  sessionId,
  generation,
  revision,
  endpoint,
  workflowGroupTarget: groupTarget,
  apiArtifactDigest: apiDigest,
  deployedManifestDigest: manifestDigest,
  schemaArtifactDigest: schemaDigest,
  workflowContractCatalogDigest: catalogDigest,
  role: "producer",
  producerOnly: true,
  workflowRunner: false,
  reconciliationConsumer: false,
  autonomousTriggers: [],
  smokeEnqueue: false,
});

const withController = <A, E, R>(run: (now: { value: number }) => Effect.Effect<A, E, R>) => {
  const now = { value: 1_000_000 };
  return run(now).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        NodeFileSystem.layer,
      ),
    ),
  );
};

const makeHostProcessHarness = (
  now: { readonly value: number },
  assertAuthorityCurrent?: () => Effect.Effect<void, PreviewWorkflowApiHostError>,
  failFirstKill = true,
  httpClientOverride?: HttpClient.HttpClient,
) =>
  Effect.gen(function* () {
    const controller = yield* makePreviewSessionController(() => now.value);
    const fileSystem = yield* FileSystem.FileSystem;
    const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
    const source = {
      checkout: fixture.checkout,
      snapshot: yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture),
    };
    const sourceSnapshot = source.snapshot;
    const runtimeRevision = sourceSnapshot.revision;
    const created = yield* controller.create({
      owner: "owner",
      checkout: source.checkout,
      manifests: { "sheet-workflows-api": apiDigest },
      requestedRevision: runtimeRevision,
    });
    const runtimeGroup = {
      ...group,
      sessionId: created.session.id,
      schemaArtifactDigest: sourceSnapshot.schemaArtifactDigest,
    };
    const runtimeConfig: ConnectedPreviewConfig = {
      ...config,
      identities: {
        ...config.identities,
        sourceRevision: runtimeRevision,
        schemaArtifactDigest: sourceSnapshot.schemaArtifactDigest,
      },
      groups: config.groups.map((candidate) =>
        candidate.id === "workflow-execution"
          ? { ...candidate, schemaArtifactDigest: sourceSnapshot.schemaArtifactDigest }
          : candidate,
      ),
    };
    const calls = {
      databaseTargetResolves: 0,
      credentialResolves: 0,
      childStarts: 0,
      originResolutions: 0,
      routePublications: 0,
      routeAuthorityGuardSupplied: false,
      killCalls: 0,
      childNodeOptions: undefined as string | undefined,
      childWorkingDirectory: undefined as string | undefined,
      resolverDatabaseEndpoint: databaseEndpoint,
    };
    const running = {
      pid: 123,
      exited: Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      kill: async () => {
        calls.killCalls += 1;
        if (calls.killCalls === 1 && failFirstKill)
          throw new Error("termination was not confirmed");
      },
    };
    const adapters = yield* makePreviewWorkflowApiSupervisorAdapters({
      trustedRuntimeArtifactAttestations: fixture.trustedRuntimeArtifactAttestations,
      credentialProvider: {
        ...(assertAuthorityCurrent === undefined ? {} : { assertCurrent: assertAuthorityCurrent }),
        resolveDatabaseTarget: () => {
          calls.databaseTargetResolves += 1;
          return Effect.succeed({
            stateIdentity: runtimeGroup.stateIdentity,
            deployedManifestDigest: runtimeGroup.deployedManifestDigest,
            schemaArtifactDigest: runtimeGroup.schemaArtifactDigest,
            workflowContractCatalogDigest: runtimeGroup.workflowContractCatalogDigest,
            endpoint: calls.resolverDatabaseEndpoint,
          });
        },
        resolve: () => {
          calls.credentialResolves += 1;
          return Effect.succeed({
            authIssuer: "https://auth.dev.tiara-stack.moe",
            environment: {
              POSTGRES_URL:
                "postgres://preview:secret@workflows.dev.tiara-stack.moe/tiara?sslmode=verify-full",
              SHEET_AUTH_OAUTH_CLIENT_ID: "preview-workflow-api",
              SHEET_AUTH_OAUTH_CLIENT_SECRET: "secret-value",
              SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS: "preview-workflow-api",
              SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "preview-bot-gateway",
            },
          });
        },
      },
      route: {
        applicationOrigin: () => {
          calls.originResolutions += 1;
          return Effect.succeed(endpoint);
        },
        publish: (input) => {
          calls.routePublications += 1;
          calls.routeAuthorityGuardSupplied = input.assertAuthorityCurrent !== undefined;
          return Effect.succeed(endpoint);
        },
        remove: () => Effect.void,
      },
      processStarter: async (request) => {
        calls.childStarts += 1;
        calls.childNodeOptions = request.env.NODE_OPTIONS;
        calls.childWorkingDirectory = request.cwd;
        return running;
      },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeFileSystem.layer,
          httpClientOverride === undefined
            ? NodeHttpClient.layerNodeHttp
            : Layer.succeed(HttpClient.HttpClient, httpClientOverride),
        ),
      ),
    );
    return {
      fileSystem,
      controller,
      source,
      runtimeRevision,
      created,
      runtimeGroup,
      runtimeConfig,
      adapters,
      calls,
    };
  });

it.effect("bounds a stalled candidate readiness request and stops its owned process", () =>
  TestClock.testClockWith((testClock) =>
    withController(({ value }) =>
      Effect.gen(function* () {
        let requests = 0;
        const firstRequest = yield* Deferred.make<void>();
        const stalledHttpClient = HttpClient.make(() =>
          Effect.sync(() => {
            requests += 1;
          }).pipe(
            Effect.andThen(Deferred.succeed(firstRequest, undefined)),
            Effect.andThen(Effect.never),
          ),
        );
        const harness = yield* makeHostProcessHarness(
          { value },
          undefined,
          false,
          stalledHttpClient,
        );
        const supervisor = makePreviewWorkflowApiSupervisor(harness.adapters);
        const running = yield* Effect.forkChild(
          supervisor.run({
            checkout: harness.source.checkout,
            session: harness.created.session,
            ownerIdentity: harness.created.ownerIdentity,
            supervisorIdentity: harness.created.supervisorIdentity,
            config: harness.runtimeConfig,
            group: {
              ...harness.runtimeGroup,
              generation: harness.created.session.generation,
            },
            controller: harness.controller,
          }),
        );

        yield* Deferred.await(firstRequest);
        for (let attempt = 0; attempt < 20 && running.pollUnsafe() === undefined; attempt += 1) {
          yield* testClock.adjust(Duration.seconds(2));
          yield* Effect.yieldNow;
          yield* testClock.adjust(Duration.millis(250));
          yield* Effect.yieldNow;
        }
        const exit = yield* Fiber.await(running);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(requests).toBeGreaterThan(1);
        expect(requests).toBeLessThan(20);
        expect(harness.calls.killCalls).toBe(1);
        expect((yield* harness.controller.status(harness.created.session.id)).phase).toBe("ended");
      }),
    ),
  ),
);

it.effect("renews the exact producer lease before source scan and through initial readiness", () =>
  TestClock.testClockWith((testClock) =>
    Effect.gen(function* () {
      let nowValue = 1_000_000;
      const now = {
        get value() {
          return nowValue;
        },
      };
      const controller = yield* makePreviewSessionController(() => now.value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: "revision-a",
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      const runtimeGroup = {
        ...group,
        sessionId: created.session.id,
        generation: created.session.generation,
      };
      const runtimeTarget = previewSharedWorkflowGroupTarget(runtimeGroup);
      const process: PreviewWorkflowApiProcess = {
        id: "controlled-lease-readiness-process",
        endpoint,
        opaque: "controlled-lease-readiness-process",
      };
      const sourceScanStarted = yield* Deferred.make<void>();
      const finishSourceScan = yield* Deferred.make<void>();
      const candidateProbeStarted = yield* Deferred.make<void>();
      const finishCandidateProbe = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      let candidateProbes = 0;
      let sourceScans = 0;
      const adapters = {
        currentSourceRevision: () =>
          Effect.gen(function* () {
            sourceScans += 1;
            if (sourceScans === 1) {
              yield* Deferred.succeed(sourceScanStarted, undefined);
              yield* Deferred.await(finishSourceScan);
            }
            return "revision-a";
          }),
        assertAuthorityCurrent: () => Effect.void,
        startProcess: () => Effect.succeed(process),
        probe: ({ session, revision }: { session: PreviewSession; revision: string }) =>
          Effect.gen(function* () {
            candidateProbes += 1;
            if (candidateProbes === 1) {
              yield* Deferred.succeed(candidateProbeStarted, undefined);
              yield* Deferred.await(finishCandidateProbe);
            }
            return readiness(
              session.id,
              session.generation,
              revision,
              contractDigest,
              runtimeTarget,
            );
          }),
        probePublishedRoute: ({
          session,
          revision,
        }: {
          session: PreviewSession;
          revision: string;
        }) =>
          Effect.succeed(
            readiness(session.id, session.generation, revision, contractDigest, runtimeTarget),
          ),
        sourceRevisions: () => Stream.never,
        publishRoute: () => Effect.succeed(endpoint),
        removeRoute: () => Effect.void,
        awaitExit: () => Effect.never,
        stopProcess: () => Effect.void,
      };
      const supervisor = makePreviewWorkflowApiSupervisor(adapters);
      const fiber = yield* Effect.forkChild(
        supervisor.run({
          checkout: "/checkout",
          session: created.session,
          ownerIdentity: created.ownerIdentity,
          supervisorIdentity: created.supervisorIdentity,
          config,
          group: runtimeGroup,
          controller,
          onReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
        }),
      );

      yield* Deferred.await(sourceScanStarted);
      yield* TestClock.adjust(Duration.seconds(20));
      nowValue = testClock.currentTimeMillisUnsafe() + 1_000_000;
      yield* Effect.yieldNow;
      const whileScanning = yield* controller.status(created.session.id);
      expect(whileScanning.phase).toBe("pending");
      expect(whileScanning.activeRevision).toBeNull();
      expect(whileScanning.leaseDeadline).toBeGreaterThan(nowValue);

      yield* Deferred.succeed(finishSourceScan, undefined);
      yield* Deferred.await(candidateProbeStarted);
      yield* TestClock.adjust(Duration.seconds(20));
      nowValue = testClock.currentTimeMillisUnsafe() + 1_000_000;
      yield* Effect.yieldNow;
      const whileReady = yield* controller.status(created.session.id);
      expect(whileReady.activeRevision).toBeNull();
      expect(whileReady.leaseDeadline).toBeGreaterThan(nowValue);
      const renewal = yield* Effect.result(
        controller.resume(created.session.id, created.ownerIdentity, created.supervisorIdentity),
      );
      expect(Result.isFailure(renewal)).toBe(true);
      if (Result.isFailure(renewal))
        expect(renewal.failure.reason).toBe("supervisor-already-active");

      yield* Deferred.succeed(finishCandidateProbe, undefined);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Effect.yieldNow;
      const readinessCompleted = yield* Effect.raceFirst(
        Deferred.await(ready).pipe(Effect.as(true)),
        Fiber.await(fiber).pipe(Effect.as(false)),
      );
      const earlyExit = fiber.pollUnsafe();
      const earlyFailure =
        earlyExit !== undefined && Exit.isFailure(earlyExit)
          ? Option.getOrUndefined(Cause.findErrorOption(earlyExit.cause))
          : undefined;
      expect(readinessCompleted, JSON.stringify(earlyFailure)).toBe(true);
      const active = yield* controller.status(created.session.id);
      expect(active.phase).toBe("active");
      expect(active.activeRevision).toBe("revision-a");

      yield* controller.stop(created.session.id, created.ownerIdentity, created.session.generation);
      const ended = yield* Fiber.await(fiber);
      expect(Exit.isFailure(ended)).toBe(true);
      const lastRenewedAt = (yield* controller.status(created.session.id)).lastRenewedAt;
      yield* TestClock.adjust(Duration.seconds(30));
      nowValue = testClock.currentTimeMillisUnsafe() + 1_000_000;
      yield* Effect.yieldNow;
      expect((yield* controller.status(created.session.id)).lastRenewedAt).toBe(lastRenewedAt);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteClient.layer({ filename: ":memory:" }),
          NodeServices.layer,
          NodeFileSystem.layer,
        ),
      ),
    ),
  ),
);

it.effect("fails and interrupts pending startup when an exact-generation renewal fails", () =>
  TestClock.testClockWith((_testClock) =>
    withController(({ value }) =>
      Effect.gen(function* () {
        const harness = yield* makeHostProcessHarness({ value });
        let heartbeatCalls = 0;
        const controller = {
          ...harness.controller,
          heartbeat: (id: string, identity: string, generation: number) => {
            heartbeatCalls += 1;
            return heartbeatCalls === 1
              ? harness.controller.heartbeat(id, identity, generation)
              : Effect.fail(new PreviewSessionError({ reason: "lease-expired-or-fenced" }));
          },
        };
        const supervisor = makePreviewWorkflowApiSupervisor(harness.adapters);
        const useStarted = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          supervisor.withSessionLease(
            {
              session: harness.created.session,
              ownerIdentity: harness.created.ownerIdentity,
              supervisorIdentity: harness.created.supervisorIdentity,
              controller,
            },
            Effect.gen(function* () {
              yield* Deferred.succeed(useStarted, undefined);
              return yield* Effect.never;
            }),
          ),
        );

        yield* Deferred.await(useStarted);
        yield* TestClock.adjust(Duration.seconds(15));
        yield* Effect.yieldNow;
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(heartbeatCalls).toBe(2);
        if (Exit.isFailure(exit))
          expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
            reason: "session-fenced",
          });

        yield* TestClock.adjust(Duration.seconds(30));
        yield* Effect.yieldNow;
        expect(heartbeatCalls).toBe(2);
        expect((yield* harness.controller.status(harness.created.session.id)).generation).toBe(
          harness.created.session.generation,
        );
      }),
    ),
  ),
);

it.effect("stops renewal when an interrupted startup leaves the lease scope", () =>
  TestClock.testClockWith((_testClock) =>
    withController(({ value }) =>
      Effect.gen(function* () {
        const harness = yield* makeHostProcessHarness({ value });
        let heartbeatCalls = 0;
        const controller = {
          ...harness.controller,
          heartbeat: (id: string, identity: string, generation: number) => {
            heartbeatCalls += 1;
            return harness.controller.heartbeat(id, identity, generation);
          },
        };
        const supervisor = makePreviewWorkflowApiSupervisor(harness.adapters);
        const useStarted = yield* Deferred.make<void>();
        const interruptUse = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          supervisor.withSessionLease(
            {
              session: harness.created.session,
              ownerIdentity: harness.created.ownerIdentity,
              supervisorIdentity: harness.created.supervisorIdentity,
              controller,
            },
            Effect.gen(function* () {
              yield* Deferred.succeed(useStarted, undefined);
              yield* Deferred.await(interruptUse);
              return yield* Effect.interrupt;
            }),
          ),
        );

        yield* Deferred.await(useStarted);
        yield* Deferred.succeed(interruptUse, undefined);
        const interrupted = yield* Fiber.await(fiber);
        expect(Exit.isFailure(interrupted)).toBe(true);
        const renewalsAtExit = heartbeatCalls;
        yield* TestClock.adjust(Duration.seconds(30));
        yield* Effect.yieldNow;
        expect(heartbeatCalls).toBe(renewalsAtExit);
      }),
    ),
  ),
);

it.effect("stops the old lease scope when its session generation is resumed", () =>
  TestClock.testClockWith((_testClock) =>
    withController((now) =>
      Effect.gen(function* () {
        const harness = yield* makeHostProcessHarness(now);
        let heartbeatCalls = 0;
        const controller = {
          ...harness.controller,
          heartbeat: (id: string, identity: string, generation: number) => {
            heartbeatCalls += 1;
            return harness.controller.heartbeat(id, identity, generation);
          },
        };
        const supervisor = makePreviewWorkflowApiSupervisor(harness.adapters);
        const useStarted = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          supervisor.withSessionLease(
            {
              session: harness.created.session,
              ownerIdentity: harness.created.ownerIdentity,
              supervisorIdentity: harness.created.supervisorIdentity,
              controller,
            },
            Effect.gen(function* () {
              yield* Deferred.succeed(useStarted, undefined);
              return yield* Effect.never;
            }),
          ),
        );

        yield* Deferred.await(useStarted);
        now.value += previewSupervisorLeaseMs + 1;
        const resumed = yield* harness.controller.resume(
          harness.created.session.id,
          harness.created.ownerIdentity,
          harness.created.supervisorIdentity,
        );
        expect(resumed.session.generation).toBe(harness.created.session.generation + 1);
        const oldLeaseExit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(oldLeaseExit)).toBe(true);
        const renewalsAtFence = heartbeatCalls;
        expect(renewalsAtFence).toBeGreaterThanOrEqual(1);
        const current = yield* harness.controller.status(harness.created.session.id);
        expect(current.generation).toBe(resumed.session.generation);
        expect(current.endedAt).toBeNull();

        yield* TestClock.adjust(Duration.seconds(30));
        yield* Effect.yieldNow;
        expect(heartbeatCalls).toBe(renewalsAtFence);
        expect((yield* harness.controller.status(harness.created.session.id)).generation).toBe(
          resumed.session.generation,
        );
      }),
    ),
  ),
);

it.effect("fences an active producer session when its signed authority expires", () =>
  TestClock.testClockWith((testClock) =>
    Effect.gen(function* () {
      const now = () => testClock.currentTimeMillisUnsafe() + 1_000_000;
      const authorityExpiresAt = now() + 1_000;
      const controller = yield* makePreviewSessionController(now);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: "revision-a",
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      const process: PreviewWorkflowApiProcess = {
        id: "authority-expiry-process",
        endpoint,
        opaque: "owned-process",
      };
      const processExited = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const candidateReady = yield* Deferred.make<void>();
      const routeReady = yield* Deferred.make<void>();
      const acceptedSharedJobs = new Set(["already-accepted-job"]);
      const routeRevisions: string[] = [];
      const stoppedProcesses: string[] = [];
      let candidateProbes = 0;
      let routeProbes = 0;
      const assertAuthorityCurrent = () =>
        now() < authorityExpiresAt
          ? Effect.void
          : Effect.fail(
              new PreviewWorkflowApiSupervisorError({
                reason: "workflow-api-authority-expired",
              }),
            );
      const supervisorAdapters = {
        authorityExpiresAt,
        authorityNow: now,
        assertAuthorityCurrent,
        currentSourceRevision: () => Effect.succeed("revision-a"),
        startProcess: () => Effect.succeed(process),
        probe: ({
          session,
          revision,
        }: {
          readonly session: PreviewSession;
          readonly revision: string;
        }) =>
          Effect.gen(function* () {
            candidateProbes += 1;
            if (candidateProbes === 1) yield* Deferred.succeed(candidateReady, undefined);
            return readiness(session.id, session.generation, revision);
          }),
        probePublishedRoute: ({
          session,
          revision,
        }: {
          readonly session: PreviewSession;
          readonly revision: string;
        }) =>
          Effect.gen(function* () {
            routeProbes += 1;
            if (routeProbes === 1) yield* Deferred.succeed(routeReady, undefined);
            return readiness(session.id, session.generation, revision);
          }),
        sourceRevisions: () => Stream.never,
        publishRoute: ({ revision }: { readonly revision: string }) =>
          Effect.sync(() => {
            routeRevisions.push(revision);
            return endpoint;
          }),
        removeRoute: () =>
          Effect.sync(() => {
            routeRevisions.pop();
          }),
        awaitExit: () => Deferred.await(processExited),
        stopProcess: (owned: PreviewWorkflowApiProcess) =>
          Effect.gen(function* () {
            stoppedProcesses.push(owned.id);
            yield* Deferred.succeed(processExited, undefined);
          }),
      };
      const supervisor = makePreviewWorkflowApiSupervisor(supervisorAdapters);
      const fiber = yield* Effect.forkChild(
        supervisor.run({
          checkout: "/checkout",
          session: created.session,
          ownerIdentity: created.ownerIdentity,
          supervisorIdentity: created.supervisorIdentity,
          config,
          group: {
            ...group,
            sessionId: created.session.id,
            generation: created.session.generation,
          },
          controller,
          onReady: () => Deferred.succeed(ready, undefined),
        }),
      );

      yield* Deferred.await(candidateReady);
      yield* TestClock.adjust(Duration.millis(250));
      yield* Deferred.await(routeReady);
      yield* TestClock.adjust(Duration.millis(250));
      yield* Deferred.await(ready);
      expect((yield* controller.status(created.session.id)).phase).toBe("active");
      expect(routeRevisions).toEqual(["revision-a"]);
      expect(acceptedSharedJobs.has("already-accepted-job")).toBe(true);

      yield* TestClock.adjust(Duration.millis(authorityExpiresAt - now()));
      yield* Effect.yieldNow;
      const completion = fiber.pollUnsafe();
      expect(completion).not.toBeUndefined();
      if (completion !== undefined) expect(Exit.isFailure(completion)).toBe(true);
      expect(routeRevisions).toEqual([]);
      expect(stoppedProcesses).toEqual([process.id]);
      expect((yield* controller.status(created.session.id)).phase).toBe("ended");
      expect(acceptedSharedJobs.has("already-accepted-job")).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
      ),
    ),
  ),
);

it.effect("revalidates signed authority after asynchronous session activation", () =>
  TestClock.testClockWith((testClock) =>
    Effect.gen(function* () {
      const now = () => testClock.currentTimeMillisUnsafe() + 1_000_000;
      const authorityExpiresAt = now() + 1_000;
      const controller = yield* makePreviewSessionController(now);
      const activationStarted = yield* Deferred.make<void>();
      const allowActivation = yield* Deferred.make<void>();
      const candidateReady = yield* Deferred.make<void>();
      const routeReady = yield* Deferred.make<void>();
      let candidateProbes = 0;
      let routeProbes = 0;
      const delayedController = {
        ...controller,
        activate: (
          sessionId: string,
          generation: number,
          supervisorIdentity: string,
          revision: string,
        ) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(activationStarted, undefined);
            yield* Deferred.await(allowActivation);
            return yield* controller.activate(sessionId, generation, supervisorIdentity, revision);
          }),
      };
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: "revision-a",
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      const process: PreviewWorkflowApiProcess = {
        id: "activation-expiry-process",
        endpoint,
        opaque: "owned-process",
      };
      const routeRevisions: string[] = [];
      const stoppedProcesses: string[] = [];
      const assertAuthorityCurrent = () =>
        now() < authorityExpiresAt
          ? Effect.void
          : Effect.fail(
              new PreviewWorkflowApiSupervisorError({
                reason: "workflow-api-authority-expired",
              }),
            );
      const supervisor = makePreviewWorkflowApiSupervisor({
        authorityExpiresAt,
        authorityNow: now,
        assertAuthorityCurrent,
        currentSourceRevision: () => Effect.succeed("revision-a"),
        startProcess: () => Effect.succeed(process),
        probe: ({ session, revision }) =>
          Effect.gen(function* () {
            candidateProbes += 1;
            if (candidateProbes === 1) yield* Deferred.succeed(candidateReady, undefined);
            return readiness(session.id, session.generation, revision);
          }),
        probePublishedRoute: ({ session, revision }) =>
          Effect.gen(function* () {
            routeProbes += 1;
            if (routeProbes === 1) yield* Deferred.succeed(routeReady, undefined);
            return readiness(session.id, session.generation, revision);
          }),
        sourceRevisions: () => Stream.never,
        publishRoute: ({ revision }) =>
          Effect.sync(() => {
            routeRevisions.push(revision);
            return endpoint;
          }),
        removeRoute: ({ expectedRevision: revision }) =>
          Effect.sync(() => {
            const index = routeRevisions.lastIndexOf(revision);
            if (index >= 0) routeRevisions.splice(index, 1);
          }),
        awaitExit: () => Effect.never,
        stopProcess: (owned) =>
          Effect.sync(() => {
            stoppedProcesses.push(owned.id);
          }),
      });
      const running = yield* Effect.forkChild(
        supervisor.run({
          checkout: created.session.checkout,
          session: created.session,
          ownerIdentity: created.ownerIdentity,
          supervisorIdentity: created.supervisorIdentity,
          config,
          group: {
            ...group,
            sessionId: created.session.id,
            generation: created.session.generation,
          },
          controller: delayedController,
        }),
      );

      yield* Deferred.await(candidateReady);
      yield* TestClock.adjust(Duration.millis(250));
      yield* Deferred.await(routeReady);
      yield* TestClock.adjust(Duration.millis(250));
      yield* Deferred.await(activationStarted);
      yield* TestClock.adjust(Duration.millis(authorityExpiresAt - now()));
      yield* Deferred.succeed(allowActivation, undefined);
      const exit = yield* Fiber.await(running);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(routeRevisions).toEqual([]);
      expect(stoppedProcesses).toEqual([process.id]);
      expect((yield* controller.status(created.session.id)).phase).toBe("ended");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
      ),
    ),
  ),
);

it.effect("interrupts bounded readiness after retaining the exact started process", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "readiness-interruption-owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: "revision-a",
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      const process: PreviewWorkflowApiProcess = {
        id: "readiness-interruption-process",
        endpoint,
        opaque: "owned-process",
      };
      const readinessStarted = yield* Deferred.make<void>();
      const removals: {
        readonly sessionId: string;
        readonly generation: number;
        readonly ownerIdentity: string;
        readonly expectedRevision: string;
      }[] = [];
      const stopped: string[] = [];
      let publications = 0;
      const supervisor = makePreviewWorkflowApiSupervisor({
        currentSourceRevision: () => Effect.succeed("revision-a"),
        startProcess: () => Effect.succeed(process),
        probe: () =>
          Deferred.succeed(readinessStarted, undefined).pipe(Effect.andThen(Effect.never)),
        probePublishedRoute: () => Effect.succeed({}),
        sourceRevisions: () => Stream.never,
        publishRoute: () =>
          Effect.sync(() => {
            publications += 1;
            return endpoint;
          }),
        removeRoute: (input) => Effect.sync(() => removals.push(input)),
        awaitExit: () => Effect.never,
        stopProcess: (owned) => Effect.sync(() => stopped.push(owned.id)),
      });
      const running = yield* Effect.forkChild(
        supervisor.run({
          checkout: created.session.checkout,
          session: created.session,
          ownerIdentity: created.ownerIdentity,
          supervisorIdentity: created.supervisorIdentity,
          config,
          group: {
            ...group,
            sessionId: created.session.id,
            generation: created.session.generation,
          },
          controller,
        }),
      );

      yield* Deferred.await(readinessStarted);
      yield* Fiber.interrupt(running);
      const exit = yield* Fiber.await(running);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(publications).toBe(0);
      expect(stopped).toEqual([process.id]);
      expect(removals).toEqual([
        {
          sessionId: created.session.id,
          generation: created.session.generation,
          ownerIdentity: created.ownerIdentity,
          expectedRevision: "revision-a",
        },
      ]);
      expect((yield* controller.status(created.session.id)).phase).toBe("ended");
    }),
  ),
);

it.effect("interrupts a pending route publication while retaining exact process cleanup", () =>
  TestClock.testClockWith((testClock) =>
    withController(({ value }) =>
      Effect.gen(function* () {
        const controller = yield* makePreviewSessionController(() => value);
        const created = yield* controller.create({
          owner: "route-publication-interruption-owner",
          checkout: "/checkout",
          manifests: { "sheet-workflows-api": apiDigest },
          requestedRevision: "revision-a",
          groups: ["workflow-execution"],
          endpoints: [endpoint],
          targets: [workflowTarget],
        });
        const process: PreviewWorkflowApiProcess = {
          id: "route-publication-interruption-process",
          endpoint,
          opaque: "owned-process",
        };
        const publicationStarted = yield* Deferred.make<void>();
        const removals: {
          readonly sessionId: string;
          readonly generation: number;
          readonly ownerIdentity: string;
          readonly expectedRevision: string;
        }[] = [];
        const stopped: string[] = [];
        const firstCandidateProbe = yield* Deferred.make<void>();
        const secondCandidateProbe = yield* Deferred.make<void>();
        let candidateProbeCount = 0;
        const supervisor = makePreviewWorkflowApiSupervisor({
          currentSourceRevision: () => Effect.succeed("revision-a"),
          startProcess: () => Effect.succeed(process),
          probe: ({ session, revision }) =>
            Effect.gen(function* () {
              candidateProbeCount += 1;
              if (candidateProbeCount === 1)
                yield* Deferred.succeed(firstCandidateProbe, undefined);
              if (candidateProbeCount === 2)
                yield* Deferred.succeed(secondCandidateProbe, undefined);
              return readiness(session.id, session.generation, revision);
            }),
          probePublishedRoute: () => Effect.succeed({}),
          sourceRevisions: () => Stream.never,
          publishRoute: () =>
            Deferred.succeed(publicationStarted, undefined).pipe(Effect.andThen(Effect.never)),
          removeRoute: (input) => Effect.sync(() => removals.push(input)),
          awaitExit: () => Effect.never,
          stopProcess: (owned) => Effect.sync(() => stopped.push(owned.id)),
        });
        const running = yield* Effect.forkChild(
          supervisor.run({
            checkout: created.session.checkout,
            session: created.session,
            ownerIdentity: created.ownerIdentity,
            supervisorIdentity: created.supervisorIdentity,
            config,
            group: {
              ...group,
              sessionId: created.session.id,
              generation: created.session.generation,
            },
            controller,
          }),
        );

        yield* Deferred.await(firstCandidateProbe);
        yield* testClock.adjust(Duration.millis(250));
        yield* Effect.yieldNow;
        yield* Deferred.await(secondCandidateProbe);
        yield* Deferred.await(publicationStarted);
        yield* Fiber.interrupt(running);
        const exit = yield* Fiber.await(running);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(removals).toEqual([
          {
            sessionId: created.session.id,
            generation: created.session.generation,
            ownerIdentity: created.ownerIdentity,
            expectedRevision: "revision-a",
          },
        ]);
        expect(stopped).toEqual([process.id]);
        expect((yield* controller.status(created.session.id)).phase).toBe("ended");
      }),
    ),
  ),
);

it.effect("does not let an expired supervisor cleanup fence a resumed generation", () =>
  TestClock.testClockWith((testClock) =>
    Effect.gen(function* () {
      const now = () => testClock.currentTimeMillisUnsafe() + 1_000_000;
      const authorityExpiresAt = now() + 1_000;
      const controller = yield* makePreviewSessionController(now);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: "revision-a",
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      const process: PreviewWorkflowApiProcess = {
        id: "old-generation-process",
        endpoint,
        opaque: "old-process",
      };
      const processExited = yield* Deferred.make<void>();
      const candidateReady = yield* Deferred.make<void>();
      const routeReady = yield* Deferred.make<void>();
      const activeSessionReady = yield* Deferred.make<void>();
      const routeCleanupStarted = yield* Deferred.make<void>();
      const allowRouteCleanup = yield* Deferred.make<void>();
      const acceptedSharedJobs = new Set(["already-accepted-job"]);
      const removed: Array<{ generation: number; revision: string }> = [];
      const stoppedProcesses: string[] = [];
      let routeOwnerGeneration = created.session.generation;
      let candidateProbes = 0;
      let routeProbes = 0;
      const supervisorAdapters = {
        authorityExpiresAt,
        authorityNow: now,
        assertAuthorityCurrent: () =>
          now() < authorityExpiresAt
            ? Effect.void
            : Effect.fail(
                new PreviewWorkflowApiSupervisorError({
                  reason: "workflow-api-authority-expired",
                }),
              ),
        currentSourceRevision: () => Effect.succeed("revision-a"),
        startProcess: () => Effect.succeed(process),
        probe: ({
          session,
          revision,
        }: {
          readonly session: PreviewSession;
          readonly revision: string;
        }) =>
          Effect.gen(function* () {
            candidateProbes += 1;
            if (candidateProbes === 1) yield* Deferred.succeed(candidateReady, undefined);
            return readiness(session.id, session.generation, revision);
          }),
        probePublishedRoute: ({
          session,
          revision,
        }: {
          readonly session: PreviewSession;
          readonly revision: string;
        }) =>
          Effect.gen(function* () {
            routeProbes += 1;
            if (routeProbes === 1) yield* Deferred.succeed(routeReady, undefined);
            return readiness(session.id, session.generation, revision);
          }),
        sourceRevisions: () => Stream.never,
        publishRoute: () => Effect.succeed(endpoint),
        removeRoute: ({
          sessionId,
          generation,
          expectedRevision: revision,
        }: PreviewWorkflowApiRouteRemovalInput) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(routeCleanupStarted, undefined);
            yield* Deferred.await(allowRouteCleanup);
            if (routeOwnerGeneration !== generation)
              return yield* Effect.fail(
                new PreviewWorkflowApiSupervisorError({
                  reason: "workflow-api-route-removal-failed",
                  sessionId,
                  generation,
                  requestedRevision: revision,
                }),
              );
            removed.push({ generation, revision });
            routeOwnerGeneration = -1;
          }),
        awaitExit: () => Deferred.await(processExited),
        stopProcess: (owned: PreviewWorkflowApiProcess) =>
          Effect.gen(function* () {
            stoppedProcesses.push(owned.id);
            yield* Deferred.succeed(processExited, undefined);
          }),
      };
      const supervisor = makePreviewWorkflowApiSupervisor(supervisorAdapters);
      const fiber = yield* Effect.forkChild(
        supervisor.run({
          checkout: "/checkout",
          session: created.session,
          ownerIdentity: created.ownerIdentity,
          supervisorIdentity: created.supervisorIdentity,
          config,
          group: {
            ...group,
            sessionId: created.session.id,
            generation: created.session.generation,
          },
          controller,
          onReady: () => Deferred.succeed(activeSessionReady, undefined),
        }),
      );

      yield* Deferred.await(candidateReady);
      yield* TestClock.adjust(Duration.millis(250));
      yield* Deferred.await(routeReady);
      yield* TestClock.adjust(Duration.millis(250));
      yield* Deferred.await(activeSessionReady);
      const expiryAdvance = yield* Effect.forkChild(
        TestClock.adjust(Duration.millis(authorityExpiresAt - now())),
      );
      yield* Deferred.await(routeCleanupStarted);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE preview_sessions SET supervisor_lease_until=${now()}
        WHERE id=${created.session.id} AND generation=${created.session.generation}`;
      const resumed = yield* controller.resume(created.session.id, created.ownerIdentity);
      routeOwnerGeneration = resumed.session.generation;
      expect(resumed.session.generation).toBe(created.session.generation + 1);
      yield* Deferred.succeed(allowRouteCleanup, undefined);
      yield* Fiber.join(expiryAdvance);
      const cleanupExit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(cleanupExit)).toBe(true);
      expect(removed).toEqual([]);
      expect(routeOwnerGeneration).toBe(resumed.session.generation);
      expect(stoppedProcesses).toEqual([process.id]);
      const current = yield* controller.status(created.session.id);
      expect(current.generation).toBe(resumed.session.generation);
      expect(current.phase).not.toBe("ended");
      expect(acceptedSharedJobs.has("already-accepted-job")).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
      ),
    ),
  ),
);

it.live("retains the exact host process handle until termination is confirmed", () =>
  withController(({ value }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const {
          fileSystem,
          source,
          runtimeRevision,
          created,
          runtimeGroup,
          runtimeConfig,
          adapters,
          calls,
        } = yield* makeHostProcessHarness({ value });
        const process = yield* adapters.startProcess({
          checkout: source.checkout,
          session: created.session,
          revision: runtimeRevision,
          config: runtimeConfig,
          group: runtimeGroup,
        });
        expect(calls.childWorkingDirectory).toBeDefined();
        expect(calls.childWorkingDirectory).not.toBe(source.checkout);
        expect(yield* fileSystem.exists(path.join(calls.childWorkingDirectory!, ".env"))).toBe(
          false,
        );

        const failedStop = yield* Effect.exit(adapters.stopProcess(process));
        expect(Exit.isFailure(failedStop)).toBe(true);
        expect(yield* fileSystem.exists(calls.childWorkingDirectory!)).toBe(true);
        const confirmedStop = yield* Effect.exit(adapters.stopProcess(process));
        expect(Exit.isSuccess(confirmedStop)).toBe(true);
        expect(yield* fileSystem.exists(calls.childWorkingDirectory!)).toBe(false);
        expect(calls.killCalls).toBe(2);
        expect(calls.credentialResolves).toBe(1);
        expect(calls.databaseTargetResolves).toBe(1);
        expect(calls.childStarts).toBe(1);
        expect(calls.originResolutions).toBe(1);
        expect(calls.routePublications).toBe(0);
        expect(calls.childNodeOptions).toBe("--conditions=development");
      }),
    ),
  ),
);

it.live("rejects stale source and incompatible schema before downstream host calls", () =>
  withController(({ value }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { source, runtimeRevision, created, runtimeGroup, runtimeConfig, adapters, calls } =
          yield* makeHostProcessHarness({ value });
        const staleSource = yield* Effect.exit(
          adapters.startProcess({
            checkout: source.checkout,
            session: created.session,
            revision: "stale-source-revision",
            config: runtimeConfig,
            group: runtimeGroup,
          }),
        );
        expect(Exit.isFailure(staleSource)).toBe(true);
        if (Exit.isFailure(staleSource)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(staleSource.cause));
          expect(error).toMatchObject({ reason: "revision-failed" });
        }
        const incompatibleSchema = yield* Effect.exit(
          adapters.startProcess({
            checkout: source.checkout,
            session: created.session,
            revision: runtimeRevision,
            config: runtimeConfig,
            group: { ...runtimeGroup, schemaArtifactDigest: digest("e") },
          }),
        );
        expect(Exit.isFailure(incompatibleSchema)).toBe(true);
        if (Exit.isFailure(incompatibleSchema)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(incompatibleSchema.cause));
          expect(error).toMatchObject({ reason: "workflow-schema-artifact-incompatible" });
        }
        expect(calls.databaseTargetResolves).toBe(0);
        expect(calls.credentialResolves).toBe(0);
        expect(calls.childStarts).toBe(0);
        expect(calls.originResolutions).toBe(0);
        expect(calls.routePublications).toBe(0);
      }),
    ),
  ),
);

it.live(
  "rejects an expired authority before a long-running source revision resolves a target or starts",
  () =>
    withController((clock) =>
      Effect.scoped(
        Effect.gen(function* () {
          const expiresAt = clock.value + 60_000;
          const assertAuthorityCurrent = () =>
            clock.value < expiresAt
              ? Effect.void
              : Effect.fail(
                  new PreviewWorkflowApiHostError({
                    reason: "workflow-api-authority-expired",
                  }),
                );
          const {
            fileSystem,
            controller,
            source,
            runtimeRevision,
            created,
            runtimeGroup,
            runtimeConfig,
            adapters,
            calls,
          } = yield* makeHostProcessHarness(clock, assertAuthorityCurrent, false);
          const initial = yield* adapters.startProcess({
            checkout: source.checkout,
            session: created.session,
            revision: runtimeRevision,
            config: runtimeConfig,
            group: runtimeGroup,
          });
          expect(calls.databaseTargetResolves).toBe(1);
          expect(calls.credentialResolves).toBe(1);
          expect(calls.childStarts).toBe(1);
          yield* adapters.publishRoute({
            session: created.session,
            ownerIdentity: created.ownerIdentity,
            revision: runtimeRevision,
            group: runtimeGroup,
            endpoint: initial.endpoint,
            controller,
          });
          expect(calls.routePublications).toBe(1);
          expect(calls.routeAuthorityGuardSupplied).toBe(true);
          yield* adapters.stopProcess(initial);

          const sourceFile = path.join(source.checkout, "packages/sheet-workflows/src/source.ts");
          const originalSource = yield* fileSystem.readFileString(sourceFile);
          yield* fileSystem.writeFileString(
            sourceFile,
            `${originalSource}\n// compatible source revision after authority expiry\n`,
          );
          const revision = yield* adapters.currentSourceRevision(source.checkout);
          expect(revision).not.toBe(runtimeRevision);
          clock.value = expiresAt;
          const blockedRevision = yield* Effect.exit(
            adapters.startProcess({
              checkout: source.checkout,
              session: created.session,
              revision,
              config: runtimeConfig,
              group: runtimeGroup,
            }),
          );
          expect(Exit.isFailure(blockedRevision)).toBe(true);
          if (Exit.isFailure(blockedRevision)) {
            const error = Option.getOrUndefined(Cause.findErrorOption(blockedRevision.cause));
            expect(error).toMatchObject({ reason: "workflow-api-credentials-unavailable" });
          }
          expect(calls.databaseTargetResolves).toBe(1);
          expect(calls.credentialResolves).toBe(1);
          expect(calls.childStarts).toBe(1);
          expect(calls.originResolutions).toBe(1);
          expect(calls.routePublications).toBe(1);
          expect(calls.killCalls).toBe(1);
        }),
      ),
    ),
);

it.live("rejects unapproved database targets before credentials or downstream host calls", () =>
  withController(({ value }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { source, runtimeRevision, created, runtimeGroup, runtimeConfig, adapters, calls } =
          yield* makeHostProcessHarness({ value });
        const rejectedEndpoints = [
          "postgres://db.external.example/tiara",
          "postgres://alternate.dev.tiara-stack.moe/tiara",
          "postgres://workflows.dev.tiara-stack.moe/alternate",
        ];
        for (const [index, rejectedEndpoint] of rejectedEndpoints.entries()) {
          calls.resolverDatabaseEndpoint = rejectedEndpoint;
          const rejectedTarget = yield* Effect.exit(
            adapters.startProcess({
              checkout: source.checkout,
              session: created.session,
              revision: runtimeRevision,
              config: runtimeConfig,
              group: runtimeGroup,
            }),
          );
          expect(Exit.isFailure(rejectedTarget)).toBe(true);
          if (Exit.isFailure(rejectedTarget)) {
            const error = Option.getOrUndefined(Cause.findErrorOption(rejectedTarget.cause));
            expect(error).toMatchObject({ reason: "workflow-database-target-incompatible" });
          }
          expect(calls.databaseTargetResolves).toBe(index + 1);
          expect(calls.credentialResolves).toBe(0);
          expect(calls.childStarts).toBe(0);
          expect(calls.originResolutions).toBe(0);
          expect(calls.routePublications).toBe(0);
        }
      }),
    ),
  ),
);

it.live(
  "restarts on source edits, waits for matching readiness, and stops only its API process",
  () =>
    withController(({ value }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const controller = yield* makePreviewSessionController(() => value);
          const created = yield* controller.create({
            owner: "owner",
            checkout: "/checkout",
            manifests: { "sheet-workflows-api": apiDigest },
            requestedRevision: "revision-a",
            groups: ["workflow-execution"],
            endpoints: [endpoint],
            targets: [workflowTarget],
          });
          const started: string[] = [];
          const stopped: string[] = [];
          const published: string[] = [];
          const probed: string[] = [];
          const routeProbed: string[] = [];
          const readyRevision = yield* Deferred.make<void>();
          let currentRevision = "revision-a";
          const processSignals = new Map<
            string,
            {
              readonly awaitExit: () => Effect.Effect<void>;
              readonly signalExit: () => Effect.Effect<void>;
            }
          >();
          let processNumber = 0;
          const processFor = (revision: string): PreviewWorkflowApiProcess => ({
            id: `${++processNumber}:${revision}`,
            endpoint,
            opaque: revision,
          });
          const supervisor = makePreviewWorkflowApiSupervisor({
            currentSourceRevision: () => Effect.succeed(currentRevision),
            startProcess: ({ revision }) =>
              Effect.gen(function* () {
                started.push(revision);
                const process = processFor(revision);
                const exited = yield* Deferred.make<void>();
                processSignals.set(process.id, {
                  awaitExit: () => Deferred.await(exited),
                  signalExit: () => Deferred.succeed(exited, undefined),
                });
                return process;
              }),
            probe: ({ session, revision }) =>
              Effect.sync(() => {
                probed.push(revision);
                return readiness(session.id, session.generation, revision);
              }),
            probePublishedRoute: ({ session, revision }) =>
              Effect.sync(() => {
                routeProbed.push(revision);
                return readiness(session.id, session.generation, revision);
              }),
            sourceRevisions: () =>
              Stream.concat(
                Stream.make("revision-a"),
                Stream.concat(
                  Stream.fromEffect(
                    Effect.sync(() => {
                      currentRevision = "revision-b";
                      return currentRevision;
                    }),
                  ),
                  Stream.never,
                ),
              ),
            publishRoute: ({ revision }) =>
              Effect.sync(() => {
                published.push(revision);
              }).pipe(Effect.as(endpoint)),
            removeRoute: ({ generation }) =>
              Effect.sync(() => {
                published.push(`removed:${generation}`);
              }),
            awaitExit: (process) => {
              const signal = processSignals.get(process.id);
              return signal === undefined
                ? Effect.die(new Error(`No process exit signal for ${process.id}`))
                : signal.awaitExit();
            },
            stopProcess: (process) => {
              const signal = processSignals.get(process.id);
              return Effect.sync(() => {
                stopped.push(process.id);
              }).pipe(
                Effect.andThen(
                  signal === undefined
                    ? Effect.die(new Error(`No process exit signal for ${process.id}`))
                    : signal.signalExit(),
                ),
              );
            },
          });
          const run = supervisor.run({
            checkout: "/checkout",
            session: created.session,
            ownerIdentity: created.ownerIdentity,
            supervisorIdentity: created.supervisorIdentity,
            config,
            group,
            controller,
            onReady: (session) => {
              if (session.activeRevision === "revision-b")
                return Deferred.succeed(readyRevision, undefined);
              return Effect.void;
            },
          });
          const fiber = yield* Effect.forkChild(run);
          yield* Deferred.await(readyRevision);
          const session = yield* controller.status(created.session.id);

          expect(session.phase).toBe("active");
          expect(session.requestedRevision).toBe("revision-b");
          expect(session.activeRevision).toBe("revision-b");
          expect(started).toEqual(["revision-a", "revision-b"]);
          expect(probed).toEqual(["revision-a", "revision-a", "revision-b", "revision-b"]);
          expect(routeProbed).toEqual(["revision-a", "revision-a", "revision-b", "revision-b"]);
          expect(published).toEqual(["revision-a", "removed:1", "revision-b"]);

          yield* Fiber.interrupt(fiber);
          expect(stopped).toEqual(["1:revision-a", "2:revision-b"]);
          expect((yield* controller.status(created.session.id)).phase).toBe("ended");
        }),
      ),
    ),
);

it.live("keeps the source watcher alive after a pre-spawn revision failure", () =>
  withController(({ value }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* makePreviewSessionController(() => value);
        const created = yield* controller.create({
          owner: "owner",
          checkout: "/checkout",
          manifests: { "sheet-workflows-api": apiDigest },
          requestedRevision: "revision-a",
          groups: ["workflow-execution"],
          endpoints: [endpoint],
          targets: [workflowTarget],
        });
        const sessionGroup = {
          ...group,
          sessionId: created.session.id,
          generation: created.session.generation,
        };
        const started: string[] = [];
        const stopped: string[] = [];
        const published: string[] = [];
        let publishedEndpoint: string | undefined;
        const probed: string[] = [];
        const routeProbed: string[] = [];
        const readyRevisions: Array<string | null> = [];
        const readyAgain = yield* Deferred.make<void>();
        const continueWithValidRevision = yield* Deferred.make<void>();
        let processNumber = 0;
        let currentRevision = "revision-a";
        const processExits = new Map<string, Deferred.Deferred<void>>();
        const supervisor = makePreviewWorkflowApiSupervisor({
          currentSourceRevision: () => Effect.succeed(currentRevision),
          startProcess: ({ revision }) => {
            started.push(revision);
            if (revision === "revision-b")
              return Effect.fail(
                new PreviewWorkflowApiSupervisorError({
                  reason: "workflow-source-unavailable",
                }),
              );
            processNumber += 1;
            return Effect.gen(function* () {
              const process = {
                id: `process-${processNumber}:${revision}`,
                endpoint,
                opaque: revision,
              };
              processExits.set(process.id, yield* Deferred.make<void>());
              return process;
            });
          },
          probe: ({ session, revision }) =>
            Effect.sync(() => {
              probed.push(revision);
              return readiness(session.id, session.generation, revision);
            }),
          probePublishedRoute: ({ session, revision }) =>
            Effect.sync(() => {
              routeProbed.push(revision);
              return readiness(session.id, session.generation, revision);
            }),
          sourceRevisions: () =>
            Stream.concat(
              Stream.make("revision-a", "revision-b"),
              Stream.concat(
                Stream.fromEffect(
                  Deferred.await(continueWithValidRevision).pipe(Effect.as("revision-c")),
                ),
                Stream.never,
              ),
            ),
          publishRoute: ({ revision }) =>
            Effect.sync(() => {
              published.push(revision);
              publishedEndpoint = endpoint;
              return endpoint;
            }),
          removeRoute: () =>
            Effect.sync(() => {
              published.push("removed");
              publishedEndpoint = undefined;
            }),
          awaitExit: (process) => {
            const exited = processExits.get(process.id);
            return exited === undefined ? Effect.void : Deferred.await(exited);
          },
          stopProcess: (process) =>
            Effect.sync(() => stopped.push(process.id)).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  const exited = processExits.get(process.id);
                  return exited === undefined ? Effect.void : Deferred.succeed(exited, undefined);
                }),
              ),
            ),
        });
        const fiber = yield* Effect.forkChild(
          supervisor.run({
            checkout: "/checkout",
            session: created.session,
            ownerIdentity: created.ownerIdentity,
            supervisorIdentity: created.supervisorIdentity,
            config,
            group: sessionGroup,
            controller,
            onReady: (session) => {
              readyRevisions.push(session.activeRevision);
              return session.activeRevision === "revision-c"
                ? Deferred.succeed(readyAgain, undefined)
                : Effect.void;
            },
          }),
        );

        let attempts = 0;
        while (!started.includes("revision-b") && attempts < 100) {
          yield* Effect.sleep(Duration.millis(10));
          attempts += 1;
        }
        expect(started).toContain("revision-b");
        yield* Effect.sleep(Duration.millis(20));
        const failedEdit = yield* controller.status(created.session.id);
        expect(failedEdit.phase).toBe("starting");
        expect(failedEdit.requestedRevision).toBe("revision-b");
        expect(failedEdit.activeRevision).toBe("revision-a");
        expect(started).toEqual(["revision-a", "revision-b"]);
        expect(published).toEqual(["revision-a", "removed"]);
        currentRevision = "revision-c";
        yield* Deferred.succeed(continueWithValidRevision, undefined);
        attempts = 0;
        while (!started.includes("revision-c") && attempts < 100) {
          yield* Effect.sleep(Duration.millis(10));
          attempts += 1;
        }
        expect(started).toContain("revision-c");
        attempts = 0;
        while (!readyRevisions.includes("revision-c") && attempts < 100) {
          yield* Effect.sleep(Duration.millis(10));
          attempts += 1;
        }
        expect(
          readyRevisions,
          JSON.stringify({ started, published, probed, routeProbed }),
        ).toContain("revision-c");
        const recovered = yield* controller.status(created.session.id);
        expect(recovered.phase).toBe("active");
        expect(recovered.requestedRevision).toBe("revision-c");
        expect(recovered.activeRevision).toBe("revision-c");
        expect(started).toEqual(["revision-a", "revision-b", "revision-c"]);
        expect(published).toContain("revision-c");
        expect(publishedEndpoint).toBe(endpoint);

        yield* Fiber.interrupt(fiber);
        expect(stopped).toEqual(["process-1:revision-a", "process-2:revision-c"]);
        expect((yield* controller.status(created.session.id)).phase).toBe("ended");
      }),
    ),
  ),
);

it.live("fences the active session when the current process exits unexpectedly", () =>
  withController(({ value }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* makePreviewSessionController(() => value);
        const created = yield* controller.create({
          owner: "owner",
          checkout: "/checkout",
          manifests: { "sheet-workflows-api": apiDigest },
          requestedRevision: "revision-a",
          groups: ["workflow-execution"],
          endpoints: [endpoint],
          targets: [workflowTarget],
        });
        const process: PreviewWorkflowApiProcess = { id: "current", endpoint, opaque: null };
        const ready = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<void>();
        const stopped: string[] = [];
        const removedRoutes: string[] = [];
        const supervisor = makePreviewWorkflowApiSupervisor({
          currentSourceRevision: () => Effect.succeed("revision-a"),
          startProcess: () => Effect.succeed(process),
          probe: ({ session, revision }) =>
            Effect.succeed(readiness(session.id, session.generation, revision)),
          probePublishedRoute: ({ session, revision }) =>
            Effect.succeed(readiness(session.id, session.generation, revision)),
          sourceRevisions: () => Stream.never,
          publishRoute: () => Effect.succeed(endpoint),
          removeRoute: ({ sessionId }) =>
            Effect.sync(() => {
              removedRoutes.push(sessionId);
            }),
          awaitExit: () => Deferred.await(exited),
          stopProcess: (ownedProcess) =>
            Effect.sync(() => {
              stopped.push(ownedProcess.id);
            }),
        });
        const fiber = yield* Effect.forkChild(
          supervisor.run({
            checkout: "/checkout",
            session: created.session,
            ownerIdentity: created.ownerIdentity,
            supervisorIdentity: created.supervisorIdentity,
            config,
            group,
            controller,
            onReady: () => Deferred.succeed(ready, undefined),
          }),
        );

        yield* Deferred.await(ready);
        yield* Deferred.succeed(exited, undefined);
        const completion = yield* Fiber.await(fiber);
        expect(Exit.isFailure(completion)).toBe(true);
        if (Exit.isFailure(completion)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(completion.cause));
          expect(error).toMatchObject({ reason: "process-exited" });
        }
        expect(removedRoutes).toEqual([created.session.id]);
        expect(stopped).toEqual([process.id]);
        expect((yield* controller.status(created.session.id)).phase).toBe("ended");
      }),
    ),
  ),
);

it.live("refuses to activate when the source changes during startup readiness", () =>
  withController(({ value }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* makePreviewSessionController(() => value);
        const created = yield* controller.create({
          owner: "owner",
          checkout: "/checkout",
          manifests: { "sheet-workflows-api": apiDigest },
          requestedRevision: "revision-a",
          groups: ["workflow-execution"],
          endpoints: [endpoint],
          targets: [workflowTarget],
        });
        const process: PreviewWorkflowApiProcess = {
          id: "revision-race",
          endpoint,
          opaque: "revision-race",
        };
        let revisionReads = 0;
        let routeProbes = 0;
        let readyCallback = false;
        const removed: string[] = [];
        const stopped: string[] = [];
        const supervisor = makePreviewWorkflowApiSupervisor({
          currentSourceRevision: () => {
            revisionReads += 1;
            return Effect.succeed(revisionReads < 3 ? "revision-a" : "revision-b");
          },
          startProcess: () => Effect.succeed(process),
          probe: ({ session, revision }) =>
            Effect.succeed(readiness(session.id, session.generation, revision)),
          probePublishedRoute: ({ session, revision }) =>
            Effect.sync(() => {
              routeProbes += 1;
              return readiness(session.id, session.generation, revision);
            }),
          sourceRevisions: () => Stream.never,
          publishRoute: () => Effect.succeed(endpoint),
          removeRoute: ({ sessionId }) =>
            Effect.sync(() => {
              removed.push(sessionId);
            }),
          awaitExit: () => Effect.never,
          stopProcess: (ownedProcess) =>
            Effect.sync(() => {
              stopped.push(ownedProcess.id);
            }),
        });

        const result = yield* Effect.exit(
          supervisor.run({
            checkout: "/checkout",
            session: created.session,
            ownerIdentity: created.ownerIdentity,
            supervisorIdentity: created.supervisorIdentity,
            config,
            group: { ...group, sessionId: created.session.id },
            controller,
            onReady: () =>
              Effect.sync(() => {
                readyCallback = true;
              }),
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toMatchObject({ reason: "revision-failed" });
        }
        expect(revisionReads).toBe(3);
        expect(routeProbes).toBe(2);
        expect(readyCallback).toBe(false);
        expect(removed).toEqual([created.session.id]);
        expect(stopped).toEqual([process.id]);
        expect((yield* controller.status(created.session.id)).phase).toBe("ended");
      }),
    ),
  ),
);

it.live("blocks a source revision when its second catalog readiness check is stale", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: "revision-a",
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      const started: string[] = [];
      const stopped: string[] = [];
      const published: string[] = [];
      const revisionFailure = yield* Deferred.make<void>();
      let probeCount = 0;
      let processNumber = 0;
      const processFor = (revision: string): PreviewWorkflowApiProcess => ({
        id: `${++processNumber}:${revision}`,
        endpoint,
        opaque: revision,
      });
      const supervisor = makePreviewWorkflowApiSupervisor({
        currentSourceRevision: () => Effect.succeed("revision-a"),
        startProcess: ({ revision }) =>
          Effect.sync(() => {
            started.push(revision);
            return processFor(revision);
          }),
        probe: ({ session, revision }) =>
          Effect.sync(() => {
            probeCount += 1;
            const evidence = readiness(session.id, session.generation, revision);
            return probeCount === 4
              ? { ...evidence, workflowContractCatalogDigest: digest("e") }
              : evidence;
          }),
        probePublishedRoute: ({ session, revision }) =>
          Effect.succeed(readiness(session.id, session.generation, revision)),
        sourceRevisions: () => Stream.concat(Stream.make("revision-a", "revision-b"), Stream.never),
        publishRoute: ({ revision }) =>
          Effect.sync(() => {
            published.push(revision);
            return endpoint;
          }),
        removeRoute: () => Effect.void,
        awaitExit: () => Effect.never,
        stopProcess: (process) =>
          Effect.sync(() => stopped.push(process.id)).pipe(
            Effect.andThen(
              process.id.endsWith(":revision-b")
                ? Deferred.succeed(revisionFailure, undefined)
                : Effect.void,
            ),
          ),
      });
      const fiber = yield* Effect.forkChild(
        supervisor.run({
          checkout: "/checkout",
          session: created.session,
          ownerIdentity: created.ownerIdentity,
          supervisorIdentity: created.supervisorIdentity,
          config,
          group,
          controller,
        }),
      );

      yield* Deferred.await(revisionFailure);
      const blocked = yield* controller.status(created.session.id);
      expect(blocked.phase).toBe("starting");
      expect(blocked.requestedRevision).toBe("revision-b");
      expect(blocked.activeRevision).toBe("revision-a");
      expect(started).toEqual(["revision-a", "revision-b"]);
      expect(probeCount).toBe(4);
      expect(published).toEqual(["revision-a"]);
      expect(stopped).toContain("2:revision-b");

      yield* Fiber.interrupt(fiber);
      expect((yield* controller.status(created.session.id)).phase).toBe("ended");
    }),
  ),
);

it.live("revalidates a reverted active revision when the failed edit left no process", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: "revision-a",
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      const started: string[] = [];
      const published: string[] = [];
      const stopped: string[] = [];
      const readyTwice = yield* Deferred.make<void>();
      let processNumber = 0;
      let readyCount = 0;
      let probeCount = 0;
      const supervisor = makePreviewWorkflowApiSupervisor({
        currentSourceRevision: () => Effect.succeed("revision-a"),
        startProcess: ({ revision }) =>
          Effect.sync(() => {
            started.push(revision);
            processNumber += 1;
            return { id: `process-${processNumber}`, endpoint, opaque: processNumber };
          }),
        probe: ({ session, revision }) =>
          Effect.sync(() => {
            probeCount += 1;
            const evidence = readiness(session.id, session.generation, revision);
            return revision === "revision-b"
              ? { ...evidence, workflowContractCatalogDigest: digest("e") }
              : evidence;
          }),
        probePublishedRoute: ({ session, revision }) =>
          Effect.succeed(readiness(session.id, session.generation, revision)),
        sourceRevisions: () =>
          Stream.concat(Stream.make("revision-a", "revision-b", "revision-a"), Stream.never),
        publishRoute: ({ revision }) =>
          Effect.sync(() => {
            published.push(revision);
            return endpoint;
          }),
        removeRoute: () => Effect.void,
        awaitExit: () => Effect.never,
        stopProcess: (process) => Effect.sync(() => stopped.push(process.id)),
      });
      const fiber = yield* Effect.forkChild(
        supervisor.run({
          checkout: "/checkout",
          session: created.session,
          ownerIdentity: created.ownerIdentity,
          supervisorIdentity: created.supervisorIdentity,
          config,
          group,
          controller,
          onReady: () => {
            readyCount += 1;
            return readyCount === 2 ? Deferred.succeed(readyTwice, undefined) : Effect.void;
          },
        }),
      );

      yield* Deferred.await(readyTwice);
      const active = yield* controller.status(created.session.id);
      expect(started).toEqual(["revision-a", "revision-b", "revision-a"]);
      expect(published).toEqual(["revision-a", "revision-a"]);
      expect(probeCount).toBe(5);
      expect(stopped).toContain("process-2");
      expect(active.phase).toBe("active");
      expect(active.requestedRevision).toBe("revision-a");
      expect(active.activeRevision).toBe("revision-a");

      yield* Fiber.interrupt(fiber);
      expect((yield* controller.status(created.session.id)).phase).toBe("ended");
    }),
  ),
);

it.live("keeps the session inactive when the published route fails a repeated identity check", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: "revision-a",
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      let routeProbeCount = 0;
      const removed: string[] = [];
      const stopped: string[] = [];
      const supervisor = makePreviewWorkflowApiSupervisor({
        currentSourceRevision: () => Effect.succeed("revision-a"),
        startProcess: () => Effect.succeed({ id: "route-gated", endpoint, opaque: "route-gated" }),
        probe: ({ session, revision }) =>
          Effect.succeed(readiness(session.id, session.generation, revision)),
        probePublishedRoute: ({ session, revision }) =>
          Effect.sync(() => {
            routeProbeCount += 1;
            const evidence = readiness(session.id, session.generation, revision);
            return routeProbeCount === 2
              ? { ...evidence, schemaArtifactDigest: digest("e") }
              : evidence;
          }),
        sourceRevisions: () => Stream.never,
        publishRoute: () => Effect.succeed(endpoint),
        removeRoute: ({ generation }) => Effect.sync(() => removed.push(String(generation))),
        awaitExit: () => Effect.never,
        stopProcess: (process) => Effect.sync(() => stopped.push(process.id)),
      });

      const exit = yield* Effect.exit(
        supervisor.run({
          checkout: "/checkout",
          session: created.session,
          ownerIdentity: created.ownerIdentity,
          supervisorIdentity: created.supervisorIdentity,
          config,
          group: { ...group, sessionId: created.session.id },
          controller,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(routeProbeCount).toBe(2);
      expect((yield* controller.status(created.session.id)).phase).toBe("ended");
      expect((yield* controller.status(created.session.id)).activeRevision).toBeNull();
      expect(removed).toEqual(["1"]);
      expect(stopped).toEqual(["route-gated"]);
    }),
  ),
);

it.live("reports route and process cleanup uncertainty while fencing the session", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: "revision-a",
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      const supervisor = makePreviewWorkflowApiSupervisor({
        currentSourceRevision: () => Effect.succeed("revision-a"),
        startProcess: () => Effect.succeed({ id: "owned-process", endpoint, opaque: "owned" }),
        probe: ({ session, revision }) =>
          Effect.succeed(readiness(session.id, session.generation, revision, digest("e"))),
        probePublishedRoute: () => Effect.succeed({}),
        sourceRevisions: () => Stream.never,
        publishRoute: () => Effect.succeed(endpoint),
        removeRoute: () =>
          Effect.fail(
            makePreviewWorkflowApiSupervisorError(
              "workflow-api-route-removal-failed",
              created.session,
            ),
          ),
        awaitExit: () => Effect.never,
        stopProcess: () =>
          Effect.fail(
            makePreviewWorkflowApiSupervisorError("process-stop-failed", created.session),
          ),
      });

      const exit = yield* Effect.exit(
        supervisor.run({
          checkout: "/checkout",
          session: created.session,
          ownerIdentity: created.ownerIdentity,
          supervisorIdentity: created.supervisorIdentity,
          config,
          group: { ...group, sessionId: created.session.id },
          controller,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(failure).toMatchObject({
          reason: "cleanup-unconfirmed",
          cleanup: {
            route: "unconfirmed",
            process: "unconfirmed",
            sessionFence: "confirmed",
          },
        });
      }
      expect((yield* controller.status(created.session.id)).phase).toBe("ended");
    }),
  ),
);

it.live(
  "rejects a stale persisted catalog on resume and recovers with a refreshed session plan",
  () =>
    withController(({ value }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const controller = yield* makePreviewSessionController(() => value);
          const created = yield* controller.create({
            owner: "owner",
            checkout: "/checkout",
            manifests: { "sheet-workflows-api": apiDigest },
            requestedRevision: "revision-a",
            groups: ["workflow-execution"],
            endpoints: [endpoint],
            targets: [workflowTarget],
          });

          value += 30_001;
          const resumed = yield* controller.resume(created.session.id, created.ownerIdentity);
          expect(resumed.session.generation).toBe(2);
          const staleGroup = {
            ...group,
            sessionId: resumed.session.id,
            generation: resumed.session.generation,
          };
          const staleProcess = yield* previewWorkflowApiProcessRequest({
            checkout: "/checkout",
            session: resumed.session,
            config,
            group: staleGroup,
            listener: { host: "127.0.0.1", port: 43123 },
            authIssuer: "https://auth.dev.tiara-stack.moe",
            applicationOrigin: "https://session-api.dev.tiara-stack.moe",
            revision: resumed.session.requestedRevision,
            credentialEnvironment: {
              POSTGRES_URL:
                "postgres://preview:secret@workflows.dev.tiara-stack.moe/tiara?sslmode=verify-full",
              SHEET_AUTH_OAUTH_CLIENT_ID: "preview-workflow-api",
              SHEET_AUTH_OAUTH_CLIENT_SECRET: "secret-value",
              SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS: "preview-workflow-api",
              SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "preview-bot-gateway",
            },
            databaseTarget: {
              stateIdentity: group.stateIdentity,
              deployedManifestDigest: manifestDigest,
              schemaArtifactDigest: schemaDigest,
              workflowContractCatalogDigest: contractDigest,
              endpoint: databaseEndpoint,
            },
          });
          expect(staleProcess.env.WORKFLOWS_PREVIEW_CATALOG_DIGEST).toBe(contractDigest);

          const started: string[] = [];
          const stopped: string[] = [];
          const probed: string[] = [];
          const published: string[] = [];
          const incompatibleSupervisor = makePreviewWorkflowApiSupervisor({
            currentSourceRevision: () => Effect.succeed("revision-a"),
            startProcess: ({ revision }) =>
              Effect.sync(() => {
                started.push(revision);
                return { id: "resumed-stale", endpoint, opaque: revision };
              }),
            probe: ({ session, revision }) =>
              Effect.sync(() => {
                probed.push(revision);
                return readiness(session.id, session.generation, revision, digest("d"));
              }),
            probePublishedRoute: ({ session, revision }) =>
              Effect.succeed(readiness(session.id, session.generation, revision, digest("d"))),
            sourceRevisions: () => Stream.never,
            publishRoute: () =>
              Effect.sync(() => {
                published.push("stale");
                return endpoint;
              }),
            removeRoute: () => Effect.void,
            awaitExit: () => Effect.never,
            stopProcess: (process) => Effect.sync(() => stopped.push(process.id)),
          });
          const incompatible = yield* Effect.exit(
            incompatibleSupervisor.run({
              checkout: "/checkout",
              session: resumed.session,
              ownerIdentity: created.ownerIdentity,
              supervisorIdentity: resumed.supervisorIdentity,
              config,
              group: staleGroup,
              controller,
            }),
          );
          expect(incompatible._tag).toBe("Failure");
          expect(started).toEqual(["revision-a"]);
          expect(probed).toEqual(["revision-a"]);
          expect(published).toEqual([]);
          expect(stopped).toEqual(["resumed-stale"]);
          expect((yield* controller.status(created.session.id)).phase).toBe("ended");

          const compatibleGroup = { ...group, workflowContractCatalogDigest: digest("d") };
          const compatibleTarget = previewSharedWorkflowGroupTarget(compatibleGroup);
          const replacement = yield* controller.create({
            owner: "owner",
            checkout: "/checkout",
            manifests: { "sheet-workflows-api": apiDigest },
            requestedRevision: "revision-b",
            groups: ["workflow-execution"],
            endpoints: [endpoint],
            targets: [compatibleTarget],
          });
          const matchingGroup = {
            ...compatibleGroup,
            sessionId: replacement.session.id,
            generation: replacement.session.generation,
          };
          const ready = yield* Deferred.make<void>();
          let matchingProbes = 0;
          const recoverySupervisor = makePreviewWorkflowApiSupervisor({
            currentSourceRevision: () => Effect.succeed("revision-b"),
            startProcess: ({ revision }) =>
              Effect.succeed({ id: "refreshed", endpoint, opaque: revision }),
            probe: ({ session, revision }) =>
              Effect.sync(() => {
                matchingProbes += 1;
                return readiness(
                  session.id,
                  session.generation,
                  revision,
                  digest("d"),
                  compatibleTarget,
                );
              }),
            probePublishedRoute: ({ session, revision }) =>
              Effect.succeed(
                readiness(session.id, session.generation, revision, digest("d"), compatibleTarget),
              ),
            sourceRevisions: () => Stream.never,
            publishRoute: () => Effect.succeed(endpoint),
            removeRoute: () => Effect.void,
            awaitExit: () => Effect.never,
            stopProcess: () => Effect.void,
          });
          const recoveryFiber = yield* Effect.forkChild(
            recoverySupervisor.run({
              checkout: "/checkout",
              session: replacement.session,
              ownerIdentity: replacement.ownerIdentity,
              supervisorIdentity: replacement.supervisorIdentity,
              config,
              group: matchingGroup,
              controller,
              onReady: (session) =>
                session.activeRevision === "revision-b"
                  ? Deferred.succeed(ready, undefined)
                  : Effect.void,
            }),
          );
          yield* Deferred.await(ready);
          expect(matchingProbes).toBe(2);
          expect((yield* controller.status(replacement.session.id)).phase).toBe("active");
          yield* Fiber.interrupt(recoveryFiber);
        }),
      ),
    ),
);

it.effect(
  "launches only the producer runtime with read-only admission and pinned group evidence",
  () =>
    withController(({ value }) =>
      Effect.gen(function* () {
        const controller = yield* makePreviewSessionController(() => value);
        const created = yield* controller.create({
          owner: "owner",
          checkout: "/checkout",
          manifests: { "sheet-workflows-api": apiDigest },
          requestedRevision: "sha256:" + "d".repeat(64),
        });
        const request = yield* previewWorkflowApiProcessRequest({
          checkout: "/checkout",
          session: created.session,
          config,
          group: {
            ...group,
            sessionId: created.session.id,
            generation: created.session.generation,
          },
          listener: { host: "127.0.0.1", port: 43123 },
          authIssuer: "https://auth.dev.tiara-stack.moe",
          applicationOrigin: "https://session-api.dev.tiara-stack.moe",
          revision: "sha256:" + "d".repeat(64),
          credentialEnvironment: {
            POSTGRES_URL:
              "postgres://preview:secret@workflows.dev.tiara-stack.moe/tiara?sslmode=verify-full",
            SHEET_AUTH_OAUTH_CLIENT_ID: "preview-workflow-api",
            SHEET_AUTH_OAUTH_CLIENT_SECRET: "secret-value",
            SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS: "preview-workflow-api",
            SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "preview-bot-gateway",
          },
          databaseTarget: {
            stateIdentity: group.stateIdentity,
            deployedManifestDigest: manifestDigest,
            schemaArtifactDigest: schemaDigest,
            workflowContractCatalogDigest: contractDigest,
            endpoint: databaseEndpoint,
          },
        });

        expect(request.command).toBe(process.execPath);
        expect(request.args).toEqual([
          "--conditions=development",
          "--import",
          "/checkout/node_modules/tsx/dist/loader.mjs",
          "packages/sheet-workflows/src/index.ts",
        ]);
        expect(request.environmentInheritance).toBe("web-preview");
        expect(request.env).toMatchObject({
          PORT: "43123",
          HOST: "127.0.0.1",
          NODE_OPTIONS: "--conditions=development",
          SHEET_WORKFLOWS_ROLE: "producer",
          WORKFLOWS_STATE_PLANE_POLICY: "shared-admission",
          WORKFLOWS_AUTONOMOUS_TRIGGER_NAMES: "",
          WORKFLOWS_SMOKE_WORKFLOW_ENABLED: "false",
          WORKFLOWS_PREVIEW_SESSION_ID: created.session.id,
          WORKFLOWS_PREVIEW_GENERATION: "1",
          WORKFLOWS_PREVIEW_GROUP_TARGET: workflowTarget,
          WORKFLOWS_PREVIEW_API_ENDPOINT: "https://session-api.dev.tiara-stack.moe",
          WORKFLOWS_PREVIEW_SCHEMA_ARTIFACT_DIGEST: schemaDigest,
          WORKFLOWS_SOURCE_REVISION: "sha256:" + "d".repeat(64),
        });
      }),
    ),
);

it("uses the node-postgres parser loaded by PgClient and requires verified TLS in the URL", () => {
  const previousSslMode = process.env.PGSSLMODE;
  try {
    delete process.env.PGSSLMODE;
    const missingModeUrl = "postgres://preview:secret@workflows.dev.tiara-stack.moe/tiara";
    const verifiedUrl = `${missingModeUrl}?sslmode=verify-full`;
    const missingMode = new NodePostgresConnectionParameters(missingModeUrl);
    const verified = new NodePostgresConnectionParameters(verifiedUrl);
    const disabled = new NodePostgresConnectionParameters(`${missingModeUrl}?sslmode=disable`);
    const noVerify = new NodePostgresConnectionParameters(`${missingModeUrl}?sslmode=no-verify`);

    expect(missingMode.ssl).toBe(false);
    expect(verified.ssl).toEqual({});
    expect(disabled.ssl).toBe(false);
    expect(noVerify.ssl).toEqual({ rejectUnauthorized: false });
    expect(previewWorkflowApiCredentialMatchesDatabaseTarget(verifiedUrl, databaseEndpoint)).toBe(
      true,
    );
    for (const rejected of [
      missingModeUrl,
      `${missingModeUrl}?sslmode=disable`,
      `${missingModeUrl}?sslmode=require`,
      `${missingModeUrl}?sslmode=no-verify`,
      `${missingModeUrl}?ssl=0`,
      `${verifiedUrl}&ssl=0`,
      `${missingModeUrl}?sslmode=verify-full&sslmode=disable`,
    ])
      expect(previewWorkflowApiCredentialMatchesDatabaseTarget(rejected, databaseEndpoint)).toBe(
        false,
      );
  } finally {
    if (previousSslMode === undefined) delete process.env.PGSSLMODE;
    else process.env.PGSSLMODE = previousSslMode;
  }
});

it.effect("rejects a producer process request when the API role is not the sole selection", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: "sha256:" + "d".repeat(64),
      });
      const result = yield* Effect.exit(
        previewWorkflowApiProcessRequest({
          checkout: "/checkout",
          session: created.session,
          config: { ...config, roles: ["sheet-workflows-api", "sheet-web"] },
          group: {
            ...group,
            sessionId: created.session.id,
            generation: created.session.generation,
          },
          listener: { host: "127.0.0.1", port: 43123 },
          authIssuer: "https://auth.dev.tiara-stack.moe",
          applicationOrigin: "https://session-api.dev.tiara-stack.moe",
          revision: "sha256:" + "d".repeat(64),
          credentialEnvironment: {
            POSTGRES_URL:
              "postgres://preview:secret@workflows.dev.tiara-stack.moe/tiara?sslmode=verify-full",
            SHEET_AUTH_OAUTH_CLIENT_ID: "preview-workflow-api",
            SHEET_AUTH_OAUTH_CLIENT_SECRET: "secret-value",
            SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS: "preview-workflow-api",
            SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "preview-bot-gateway",
          },
          databaseTarget: {
            stateIdentity: group.stateIdentity,
            deployedManifestDigest: manifestDigest,
            schemaArtifactDigest: schemaDigest,
            workflowContractCatalogDigest: contractDigest,
            endpoint: databaseEndpoint,
          },
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const failure = result.cause.reasons.find(Cause.isFailReason);
        expect(failure?.error).toMatchObject({ reason: "adapter-unavailable" });
      }
    }),
  ),
);

it.effect("rejects a producer database URL outside the resolved shared-group endpoint", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: "sha256:" + "d".repeat(64),
      });
      const input = {
        checkout: "/checkout",
        session: created.session,
        config,
        group: {
          ...group,
          sessionId: created.session.id,
          generation: created.session.generation,
        },
        listener: { host: "127.0.0.1" as const, port: 43123 },
        authIssuer: "https://auth.dev.tiara-stack.moe",
        applicationOrigin: "https://session-api.dev.tiara-stack.moe",
        revision: "sha256:" + "d".repeat(64),
        credentialEnvironment: {
          POSTGRES_URL: "postgres://preview:secret@unrelated.example/tiara",
          SHEET_AUTH_OAUTH_CLIENT_ID: "preview-workflow-api",
          SHEET_AUTH_OAUTH_CLIENT_SECRET: "secret-value",
          SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS: "preview-workflow-api",
          SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "preview-bot-gateway",
        },
        databaseTarget: {
          stateIdentity: group.stateIdentity,
          deployedManifestDigest: manifestDigest,
          schemaArtifactDigest: schemaDigest,
          workflowContractCatalogDigest: contractDigest,
          endpoint: databaseEndpoint,
        },
      };
      const wrongHost = yield* Effect.exit(previewWorkflowApiProcessRequest(input));
      const missingTlsMode = yield* Effect.exit(
        previewWorkflowApiProcessRequest({
          ...input,
          credentialEnvironment: {
            ...input.credentialEnvironment,
            POSTGRES_URL: "postgres://preview:secret@workflows.dev.tiara-stack.moe/tiara",
          },
        }),
      );
      const unapprovedDatabaseTarget = yield* Effect.exit(
        previewWorkflowApiProcessRequest({
          ...input,
          credentialEnvironment: {
            ...input.credentialEnvironment,
            POSTGRES_URL: "postgres://preview:secret@db.external.example/tiara",
          },
          databaseTarget: {
            ...input.databaseTarget,
            endpoint: "postgres://db.external.example/tiara",
          },
        }),
      );
      const wrongState = yield* Effect.exit(
        previewWorkflowApiProcessRequest({
          ...input,
          credentialEnvironment: {
            ...input.credentialEnvironment,
            POSTGRES_URL:
              "postgres://preview:secret@workflows.dev.tiara-stack.moe/tiara?sslmode=verify-full",
          },
          databaseTarget: { ...input.databaseTarget, stateIdentity: "another-workflow-group" },
        }),
      );
      const wrongSchema = yield* Effect.exit(
        previewWorkflowApiProcessRequest({
          ...input,
          databaseTarget: {
            ...input.databaseTarget,
            schemaArtifactDigest: digest("e"),
          },
        }),
      );
      const mismatchedDeclaredSchema = yield* Effect.exit(
        previewWorkflowApiProcessRequest({
          ...input,
          config: {
            ...config,
            identities: { ...config.identities, schemaArtifactDigest: digest("e") },
          },
        }),
      );
      const endpointOverrides = yield* Effect.forEach(
        [
          "host=unrelated.example",
          "port=5433",
          "%68ost=production-db.example",
          "host=workflows.dev.tiara-stack.moe&host=production-db.example",
          "port=5432&port=5433",
          "%70ort=5433",
          "hostaddr=192.0.2.4",
          "db=another-workflow-db",
          "database=another-workflow-db",
          "dbname=another-workflow-db",
          "%64bname=another-workflow-db",
          "service=another-workflow-db",
          "servicefile=/tmp/another-workflow-db.conf",
          "ssl=0",
          "sslmode=disable",
          "sslmode=require",
          "sslmode=verify-full&sslmode=disable",
          "%73slmode=disable",
          "application_name=unapproved-option",
        ],
        (query) =>
          Effect.exit(
            previewWorkflowApiProcessRequest({
              ...input,
              credentialEnvironment: {
                ...input.credentialEnvironment,
                POSTGRES_URL: `postgres://preview:secret@workflows.dev.tiara-stack.moe/tiara?${query}`,
              },
            }),
          ),
      );
      const safeConnectionOption = yield* Effect.exit(
        previewWorkflowApiProcessRequest({
          ...input,
          credentialEnvironment: {
            ...input.credentialEnvironment,
            POSTGRES_URL:
              "postgres://preview:secret@workflows.dev.tiara-stack.moe/tiara?sslmode=verify-full",
          },
        }),
      );
      const overriddenNodeConditions = yield* Effect.exit(
        previewWorkflowApiProcessRequest({
          ...input,
          credentialEnvironment: {
            ...input.credentialEnvironment,
            NODE_OPTIONS: "--conditions=production",
          },
        }),
      );

      for (const result of [
        wrongHost,
        missingTlsMode,
        unapprovedDatabaseTarget,
        wrongState,
        wrongSchema,
        mismatchedDeclaredSchema,
        ...endpointOverrides,
        overriddenNodeConditions,
      ]) {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          const failure = result.cause.reasons.find(Cause.isFailReason);
          expect(failure?.error).toMatchObject({ reason: "adapter-unavailable" });
        }
      }
      expect(safeConnectionOption._tag).toBe("Success");
    }),
  ),
);

const assertMigrationArtifactIdentityControls = (
  fileSystem: FileSystem.FileSystem,
  fixture: WorkflowApiSourceFixture,
  initial: { readonly revision: string; readonly schemaArtifactDigest: string },
) =>
  Effect.gen(function* () {
    const changedMigration = "export const migration = 2;\n";
    yield* fileSystem.writeFileString(
      path.resolve(fixture.checkout, fixture.migrationPath),
      changedMigration,
    );
    const staleManifest = yield* Effect.exit(
      previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture),
    );
    expect(Exit.isFailure(staleManifest)).toBe(true);

    const changedDigest = `sha256:${createHash("sha256").update(changedMigration).digest("hex")}`;
    yield* fileSystem.writeFileString(
      path.resolve(
        fixture.checkout,
        "packages/sheet-db-schema/src/migration-artifact-manifest.json",
      ),
      `${JSON.stringify({
        sources: fixture.migrationSources.map(({ relativePath, digest }) => [
          relativePath,
          relativePath === fixture.migrationPath ? changedDigest : digest,
        ]),
      })}\n`,
    );
    const changedSchema = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
    expect(changedSchema.schemaArtifactDigest).not.toBe(initial.schemaArtifactDigest);

    yield* fileSystem.writeFileString(
      path.resolve(
        fixture.checkout,
        "packages/sheet-db-schema/effect-sql-migrations/0002_unlisted.ts",
      ),
      "export const migration = 2;\n",
    );
    const unlistedMigration = yield* Effect.exit(
      previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture),
    );
    expect(Exit.isFailure(unlistedMigration)).toBe(true);
    return changedSchema;
  });

const makeCatalogAdmissionAdapters = (
  runtimeGroup: typeof group,
  counters: {
    databaseTargetResolves: number;
    credentialResolves: number;
    originResolutions: number;
    processStarts: number;
    routePublications: number;
  },
  resolvedCatalogDigest: { value: string },
  trustedRuntimeArtifactAttestations: PreviewWorkflowApiRuntimeArtifactAttestations,
  assertCandidateStaged: () => Effect.Effect<void, PreviewWorkflowApiHostError> = () => Effect.void,
  failDatabaseTargetResolution: { value: boolean } = { value: false },
  failCredentialResolution: { value: boolean } = { value: false },
  failOriginResolution: { value: boolean } = { value: false },
) =>
  makePreviewWorkflowApiSupervisorAdapters({
    trustedRuntimeArtifactAttestations,
    credentialProvider: {
      resolveDatabaseTarget: () =>
        Effect.gen(function* () {
          counters.databaseTargetResolves += 1;
          yield* assertCandidateStaged();
          if (failDatabaseTargetResolution.value)
            return yield* Effect.fail(
              new PreviewWorkflowApiHostError({ reason: "database-target-fixture-failure" }),
            );
          return {
            stateIdentity: runtimeGroup.stateIdentity,
            deployedManifestDigest: runtimeGroup.deployedManifestDigest,
            schemaArtifactDigest: runtimeGroup.schemaArtifactDigest,
            workflowContractCatalogDigest: resolvedCatalogDigest.value,
            endpoint: databaseEndpoint,
          };
        }),
      resolve: () =>
        Effect.gen(function* () {
          counters.credentialResolves += 1;
          if (failCredentialResolution.value)
            return yield* Effect.fail(
              new PreviewWorkflowApiHostError({ reason: "workflow-api-credentials-unavailable" }),
            );
          return {
            authIssuer: "https://auth.dev.tiara-stack.moe",
            environment: {
              POSTGRES_URL:
                "postgres://preview@workflows.dev.tiara-stack.moe/tiara?sslmode=verify-full",
              SHEET_AUTH_OAUTH_CLIENT_ID: "preview-workflow-api",
              SHEET_AUTH_OAUTH_CLIENT_SECRET: "preview-workflow-api-test-secret",
              SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS: "preview-workflow-api",
              SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "preview-bot-gateway",
            },
          };
        }),
    },
    route: {
      applicationOrigin: () =>
        Effect.gen(function* () {
          counters.originResolutions += 1;
          if (failOriginResolution.value)
            return yield* Effect.fail(
              new PreviewWorkflowApiHostError({ reason: "workflow-api-route-unavailable" }),
            );
          return "https://workflow-api.dev.tiara-stack.moe";
        }),
      publish: () =>
        Effect.sync(() => {
          counters.routePublications += 1;
          return endpoint;
        }),
      remove: () => Effect.void,
    },
    processStarter: async () => {
      counters.processStarts += 1;
      throw new Error("incompatible startup must fail before process start");
    },
  });

const runCandidateCleanupRetryControl = (
  failureAt: "stage" | "credentials" | "origin" | "process-start",
) =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
      const sourceSnapshot = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
      const sourceSchemaArtifactDigest: typeof schemaDigest = `sha256:${sourceSnapshot.schemaArtifactDigest.slice("sha256:".length)}`;
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: fixture.checkout,
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: sourceSnapshot.revision,
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      const runtimeGroup = {
        ...group,
        sessionId: created.session.id,
        generation: created.session.generation,
        schemaArtifactDigest: sourceSchemaArtifactDigest,
      };
      const runtimeConfig: ConnectedPreviewConfig = {
        ...config,
        identities: {
          ...config.identities,
          sourceRevision: sourceSnapshot.revision,
          schemaArtifactDigest: sourceSchemaArtifactDigest,
        },
        groups: config.groups.map((candidate) =>
          candidate.id === "workflow-execution"
            ? { ...candidate, schemaArtifactDigest: sourceSchemaArtifactDigest }
            : candidate,
        ),
      };
      const counters = {
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      };
      const resolvedCatalogDigest = { value: runtimeGroup.workflowContractCatalogDigest };
      const failDatabaseTargetResolution = { value: false };
      const failCredentialResolution = { value: failureAt === "credentials" };
      const failOriginResolution = { value: failureAt === "origin" };
      const candidateParent = path.join(
        path.dirname(fixture.checkout),
        ".tiara-workflow-api-candidates",
        path.basename(fixture.checkout),
      );
      const preservedCandidate = path.join(candidateParent, "preserved-candidate");
      yield* fileSystem.makeDirectory(preservedCandidate, { recursive: true });
      yield* fileSystem.writeFileString(path.join(preservedCandidate, "marker"), "keep");
      let candidateCleanupFailures = 0;
      let failCandidateCleanup = true;
      let failCandidateSourceWrite = failureAt === "stage";
      const failingFileSystem = new Proxy(fileSystem, {
        get(target, property) {
          if (property === "remove")
            return (targetPath: string, options?: { readonly recursive?: boolean }) => {
              const absolutePath = path.resolve(targetPath);
              if (
                failCandidateCleanup &&
                path.dirname(absolutePath) === candidateParent &&
                path.basename(absolutePath).startsWith("tiara-workflow-api-candidate-") &&
                !path.basename(absolutePath).includes(".owner.json")
              ) {
                candidateCleanupFailures += 1;
                return Effect.fail(new Error("candidate-cleanup-fixture-failure"));
              }
              return fileSystem.remove(targetPath, options);
            };
          if (property === "writeFile")
            return (...args: Parameters<FileSystem.FileSystem["writeFile"]>) => {
              const targetPath = path.resolve(args[0]);
              const firstSegment = path.relative(candidateParent, targetPath).split(path.sep)[0];
              if (
                failCandidateSourceWrite &&
                firstSegment !== undefined &&
                firstSegment.startsWith("tiara-workflow-api-candidate-") &&
                !firstSegment.includes(".owner.json")
              ) {
                failCandidateSourceWrite = false;
                return Effect.fail(new Error("candidate-stage-fixture-failure"));
              }
              return fileSystem.writeFile(...args);
            };
          return Reflect.get(target, property, target);
        },
      });
      const adapters = yield* makeCatalogAdmissionAdapters(
        runtimeGroup,
        counters,
        resolvedCatalogDigest,
        fixture.trustedRuntimeArtifactAttestations,
        () => Effect.void,
        failDatabaseTargetResolution,
        failCredentialResolution,
        failOriginResolution,
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(FileSystem.FileSystem, failingFileSystem),
            NodeHttpClient.layerNodeHttp,
          ),
        ),
      );
      const input = {
        checkout: fixture.checkout,
        session: created.session,
        revision: sourceSnapshot.revision,
        config: runtimeConfig,
        group: runtimeGroup,
      };

      const first = yield* Effect.exit(adapters.startProcess(input));
      expect(Exit.isFailure(first)).toBe(true);
      if (Exit.isFailure(first)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(first.cause));
        const expectedReasonByFailure = {
          stage: "workflow-source-unavailable",
          credentials: "workflow-api-credentials-unavailable",
          origin: "workflow-api-route-unavailable",
          "process-start": "workflow-api-process-start-failed",
        } as const;
        expect(error).toMatchObject({
          reason: expectedReasonByFailure[failureAt],
          sourceStage: "candidate-cleanup-unconfirmed",
        });
      }
      expect(candidateCleanupFailures).toBe(1);
      const afterFirst = yield* fileSystem.readDirectory(candidateParent);
      expect(afterFirst).toContain("preserved-candidate");
      const unconfirmedCandidate = afterFirst.find(
        (entry) =>
          entry.startsWith("tiara-workflow-api-candidate-") && !entry.includes(".owner.json"),
      );
      expect(unconfirmedCandidate).toBeDefined();
      if (unconfirmedCandidate === undefined) return;
      const ownerRecordPath = `${path.join(candidateParent, unconfirmedCandidate)}.owner.json`;
      expect(afterFirst).toContain(path.basename(ownerRecordPath));
      const ownerRecord = JSON.parse(yield* fileSystem.readFileString(ownerRecordPath));
      const canonicalCheckoutRoot = yield* fileSystem.realPath(fixture.checkout);
      expect(ownerRecord).toMatchObject({
        schemaVersion: 1,
        checkoutRoot: canonicalCheckoutRoot,
        candidateCheckout: path.join(candidateParent, unconfirmedCandidate),
        sessionId: created.session.id,
        generation: created.session.generation,
        revision: sourceSnapshot.revision,
        cleanupState: "cleanup-pending",
      });
      expect(yield* fileSystem.readFileString(path.join(preservedCandidate, "marker"))).toBe(
        "keep",
      );

      // The next same-session start retries the retained exact path before
      // staging a new candidate or performing another target/credential call.
      failCandidateCleanup = false;
      failCredentialResolution.value = false;
      failOriginResolution.value = false;
      const retry = yield* Effect.exit(adapters.startProcess(input));
      expect(Exit.isFailure(retry)).toBe(true);
      if (Exit.isFailure(retry)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(retry.cause));
        expect(error).toMatchObject({ reason: "workflow-api-process-start-failed" });
      }
      expect(candidateCleanupFailures).toBe(1);
      const afterRetry = yield* fileSystem.readDirectory(candidateParent);
      expect(afterRetry).toEqual(["preserved-candidate"]);
      if (unconfirmedCandidate !== undefined)
        expect(afterRetry).not.toContain(unconfirmedCandidate);
      expect(yield* fileSystem.readFileString(path.join(preservedCandidate, "marker"))).toBe(
        "keep",
      );
      yield* fileSystem.remove(preservedCandidate, { recursive: true });
      expect(yield* fileSystem.readDirectory(candidateParent)).toEqual([]);
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
  );

const makeCandidateCleanupScenario = (clock: { value: number }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
    const sourceSnapshot = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
    const sourceSchemaArtifactDigest: typeof schemaDigest = `sha256:${sourceSnapshot.schemaArtifactDigest.slice("sha256:".length)}`;
    const controller = yield* makePreviewSessionController(() => clock.value);
    const created = yield* controller.create({
      owner: "owner",
      checkout: fixture.checkout,
      manifests: { "sheet-workflows-api": apiDigest },
      requestedRevision: sourceSnapshot.revision,
      groups: ["workflow-execution"],
      endpoints: [endpoint],
      targets: [workflowTarget],
    });
    const runtimeGroup = {
      ...group,
      sessionId: created.session.id,
      generation: created.session.generation,
      schemaArtifactDigest: sourceSchemaArtifactDigest,
    };
    const runtimeConfig: ConnectedPreviewConfig = {
      ...config,
      identities: {
        ...config.identities,
        sourceRevision: sourceSnapshot.revision,
        schemaArtifactDigest: sourceSchemaArtifactDigest,
      },
      groups: config.groups.map((candidate) =>
        candidate.id === "workflow-execution"
          ? { ...candidate, schemaArtifactDigest: sourceSchemaArtifactDigest }
          : candidate,
      ),
    };
    const candidateParent = path.join(
      path.dirname(fixture.checkout),
      ".tiara-workflow-api-candidates",
      path.basename(fixture.checkout),
    );
    const preservedCandidate = path.join(candidateParent, "preserved-candidate");
    yield* fileSystem.makeDirectory(preservedCandidate, { recursive: true });
    yield* fileSystem.writeFileString(path.join(preservedCandidate, "marker"), "keep");
    const counters = {
      databaseTargetResolves: 0,
      credentialResolves: 0,
      originResolutions: 0,
      processStarts: 0,
      routePublications: 0,
    };
    const resolvedCatalogDigest = { value: runtimeGroup.workflowContractCatalogDigest };
    const failDatabaseTargetResolution = { value: true };
    return {
      fileSystem,
      fixture,
      sourceSnapshot,
      controller,
      created,
      runtimeGroup,
      runtimeConfig,
      candidateParent,
      preservedCandidate,
      counters,
      resolvedCatalogDigest,
      failDatabaseTargetResolution,
    };
  });

const runCandidateCleanupFreshAdapterRetryControl = (
  failurePoint: "remove" | "exists" | "realPath" | "stat" = "remove",
) =>
  withController((clock) =>
    Effect.gen(function* () {
      const scenario = yield* makeCandidateCleanupScenario(clock);
      const {
        fileSystem,
        fixture,
        sourceSnapshot,
        controller,
        created,
        runtimeGroup,
        runtimeConfig,
        candidateParent,
        preservedCandidate,
        counters,
        resolvedCatalogDigest,
        failDatabaseTargetResolution,
      } = scenario;
      let candidateCleanupFailures = 0;
      let failCandidateCleanup = true;
      const shouldFailCandidateCleanupInspection = (targetPath: string) => {
        const absolutePath = path.resolve(targetPath);
        const name = path.basename(absolutePath);
        if (
          failCandidateCleanup &&
          counters.databaseTargetResolves > 0 &&
          path.dirname(absolutePath) === candidateParent &&
          name.startsWith("tiara-workflow-api-candidate-") &&
          !name.includes(".owner.json")
        ) {
          candidateCleanupFailures += 1;
          return true;
        }
        return false;
      };
      const failingFileSystem = new Proxy(fileSystem, {
        get(target, property) {
          if (property === "remove" && failurePoint === "remove")
            return (targetPath: string, options?: { readonly recursive?: boolean }) => {
              const absolutePath = path.resolve(targetPath);
              const name = path.basename(absolutePath);
              if (
                failCandidateCleanup &&
                path.dirname(absolutePath) === candidateParent &&
                name.startsWith("tiara-workflow-api-candidate-") &&
                !name.includes(".owner.json")
              ) {
                candidateCleanupFailures += 1;
                return Effect.fail(new Error("candidate-cleanup-fixture-failure"));
              }
              return fileSystem.remove(targetPath, options);
            };
          if (property === "exists" && failurePoint === "exists")
            return (...args: Parameters<FileSystem.FileSystem["exists"]>) => {
              if (shouldFailCandidateCleanupInspection(args[0]))
                return Effect.fail(new Error("candidate-cleanup-exists-fixture-failure"));
              return fileSystem.exists(...args);
            };
          if (property === "realPath" && failurePoint === "realPath")
            return (...args: Parameters<FileSystem.FileSystem["realPath"]>) => {
              if (shouldFailCandidateCleanupInspection(args[0]))
                return Effect.fail(new Error("candidate-cleanup-realpath-fixture-failure"));
              return fileSystem.realPath(...args);
            };
          if (property === "stat" && failurePoint === "stat")
            return (...args: Parameters<FileSystem.FileSystem["stat"]>) => {
              if (shouldFailCandidateCleanupInspection(args[0]))
                return Effect.fail(new Error("candidate-cleanup-inspection-fixture-failure"));
              return fileSystem.stat(...args);
            };
          return Reflect.get(target, property, target);
        },
      });
      const assertCandidateStaged = () =>
        Effect.gen(function* () {
          const entries = yield* fileSystem.readDirectory(candidateParent).pipe(
            Effect.mapError(
              () =>
                new PreviewWorkflowApiHostError({
                  reason: "workflow-source-unavailable",
                  phase: "candidate-parent-read",
                }),
            ),
          );
          expect(
            entries.some(
              (entry) =>
                entry.startsWith("tiara-workflow-api-candidate-") && !entry.includes(".owner.json"),
            ),
          ).toBe(true);
        });
      const firstAdapters = yield* makeCatalogAdmissionAdapters(
        runtimeGroup,
        counters,
        resolvedCatalogDigest,
        fixture.trustedRuntimeArtifactAttestations,
        assertCandidateStaged,
        failDatabaseTargetResolution,
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(FileSystem.FileSystem, failingFileSystem),
            NodeHttpClient.layerNodeHttp,
          ),
        ),
      );
      const input = {
        checkout: fixture.checkout,
        session: created.session,
        revision: sourceSnapshot.revision,
        config: runtimeConfig,
        group: runtimeGroup,
      };
      const first = yield* Effect.exit(firstAdapters.startProcess(input));
      expect(Exit.isFailure(first)).toBe(true);
      if (Exit.isFailure(first)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(first.cause));
        expect(error).toMatchObject({ sourceStage: "candidate-cleanup-unconfirmed" });
      }
      expect(candidateCleanupFailures).toBe(1);
      expect(counters).toEqual({
        databaseTargetResolves: 1,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });
      const afterFirst = yield* fileSystem.readDirectory(candidateParent);
      const orphanName = afterFirst.find(
        (entry) =>
          entry.startsWith("tiara-workflow-api-candidate-") && !entry.includes(".owner.json"),
      );
      expect(orphanName).toBeDefined();
      if (orphanName === undefined) return;
      const orphanPath = path.join(candidateParent, orphanName);
      const ownerRecordPath = `${orphanPath}.owner.json`;
      expect(afterFirst).toContain("preserved-candidate");
      expect(afterFirst).toContain(path.basename(ownerRecordPath));
      const ownerRecord = JSON.parse(yield* fileSystem.readFileString(ownerRecordPath));
      expect(ownerRecord).toMatchObject({
        sessionId: created.session.id,
        generation: created.session.generation,
        revision: sourceSnapshot.revision,
        candidateCheckout: orphanPath,
        cleanupState: "cleanup-pending",
      });

      // Resume the same durable session after its supervisor lease expires, then
      // construct a new adapter as the next CLI command would.
      clock.value += 30_001;
      const resumed = yield* controller.resume(
        created.session.id,
        created.ownerIdentity,
        created.supervisorIdentity,
      );
      expect(resumed.session.generation).toBe(created.session.generation + 1);
      const resumedGroup = { ...runtimeGroup, generation: resumed.session.generation };
      failCandidateCleanup = false;
      const nextCounters = {
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      };
      const nextFailDatabaseTargetResolution = { value: true };
      let retryObservedOrphanRemoved = false;
      const assertRecoveredCandidateStaged = () =>
        Effect.gen(function* () {
          const entries = yield* fileSystem.readDirectory(candidateParent).pipe(
            Effect.mapError(
              () =>
                new PreviewWorkflowApiHostError({
                  reason: "workflow-source-unavailable",
                  phase: "candidate-parent-read",
                }),
            ),
          );
          expect(entries).not.toContain(orphanName);
          expect(entries).not.toContain(path.basename(ownerRecordPath));
          expect(
            entries.some(
              (entry) =>
                entry.startsWith("tiara-workflow-api-candidate-") && !entry.includes(".owner.json"),
            ),
          ).toBe(true);
          retryObservedOrphanRemoved = true;
        });
      const nextAdapters = yield* makeCatalogAdmissionAdapters(
        resumedGroup,
        nextCounters,
        resolvedCatalogDigest,
        fixture.trustedRuntimeArtifactAttestations,
        assertRecoveredCandidateStaged,
        nextFailDatabaseTargetResolution,
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(FileSystem.FileSystem, fileSystem),
            NodeHttpClient.layerNodeHttp,
          ),
        ),
      );
      const retry = yield* Effect.exit(
        nextAdapters.startProcess({ ...input, session: resumed.session, group: resumedGroup }),
      );
      expect(Exit.isFailure(retry)).toBe(true);
      expect(retryObservedOrphanRemoved).toBe(true);
      expect(nextCounters).toEqual({
        databaseTargetResolves: 1,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });
      const afterRetry = yield* fileSystem.readDirectory(candidateParent);
      expect(afterRetry).toEqual(["preserved-candidate"]);
      expect(yield* fileSystem.readFileString(path.join(preservedCandidate, "marker"))).toBe(
        "keep",
      );
      yield* fileSystem.remove(preservedCandidate, { recursive: true });
      expect(yield* fileSystem.readDirectory(candidateParent)).toEqual([]);
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
  );

type OwnerRecordCleanupControl = "recover" | "retention-failure" | "candidate-reappears";

const runOwnerRecordCleanupRetryControl = (control: OwnerRecordCleanupControl) =>
  withController((clock) =>
    Effect.gen(function* () {
      const scenario = yield* makeCandidateCleanupScenario(clock);
      const {
        fileSystem,
        fixture,
        sourceSnapshot,
        controller,
        created,
        runtimeGroup,
        runtimeConfig,
        candidateParent,
        preservedCandidate,
        counters,
        resolvedCatalogDigest,
        failDatabaseTargetResolution,
      } = scenario;
      let failOwnerRecordUnlink = true;
      let ownerRecordUnlinkFailures = 0;
      let ownerRecordRetentionFailures = 0;
      const cleanupFailureFileSystem = new Proxy(fileSystem, {
        get(target, property) {
          if (property === "remove")
            return (targetPath: string, options?: { readonly recursive?: boolean }) => {
              const absolutePath = path.resolve(targetPath);
              const name = path.basename(absolutePath);
              if (
                failOwnerRecordUnlink &&
                path.dirname(absolutePath) === candidateParent &&
                name.startsWith("tiara-workflow-api-candidate-") &&
                name.endsWith(".owner.json")
              ) {
                failOwnerRecordUnlink = false;
                ownerRecordUnlinkFailures += 1;
                return Effect.fail(new Error("candidate-owner-record-unlink-fixture-failure"));
              }
              return fileSystem.remove(targetPath, options);
            };
          if (property === "writeFileString" && control === "retention-failure")
            return (...args: Parameters<FileSystem.FileSystem["writeFileString"]>) => {
              const targetPath = path.resolve(args[0]);
              if (
                ownerRecordUnlinkFailures > 0 &&
                path.dirname(targetPath) === candidateParent &&
                path.basename(targetPath).includes(".owner.json.") &&
                path.basename(targetPath).endsWith(".tmp")
              ) {
                ownerRecordRetentionFailures += 1;
                return Effect.fail(new Error("candidate-owner-record-retention-fixture-failure"));
              }
              return fileSystem.writeFileString(...args);
            };
          return Reflect.get(target, property, target);
        },
      });
      const assertCandidateStaged = () =>
        fileSystem.readDirectory(candidateParent).pipe(
          Effect.map((entries) => {
            expect(
              entries.some(
                (entry) =>
                  entry.startsWith("tiara-workflow-api-candidate-") &&
                  !entry.endsWith(".owner.json"),
              ),
            ).toBe(true);
          }),
          Effect.mapError(
            () =>
              new PreviewWorkflowApiHostError({
                reason: "workflow-source-unavailable",
                phase: "candidate-parent-read",
              }),
          ),
        );
      const adapters = yield* makeCatalogAdmissionAdapters(
        runtimeGroup,
        counters,
        resolvedCatalogDigest,
        fixture.trustedRuntimeArtifactAttestations,
        assertCandidateStaged,
        failDatabaseTargetResolution,
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(FileSystem.FileSystem, cleanupFailureFileSystem),
            NodeHttpClient.layerNodeHttp,
          ),
        ),
      );
      const input = {
        checkout: fixture.checkout,
        session: created.session,
        revision: sourceSnapshot.revision,
        config: runtimeConfig,
        group: runtimeGroup,
      };

      const first = yield* Effect.exit(adapters.startProcess(input));
      expect(Exit.isFailure(first)).toBe(true);
      if (Exit.isFailure(first)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(first.cause));
        expect(error).toMatchObject({ sourceStage: "candidate-cleanup-unconfirmed" });
      }
      expect(ownerRecordUnlinkFailures).toBe(1);
      expect(ownerRecordRetentionFailures).toBe(control === "retention-failure" ? 1 : 0);
      expect(counters).toEqual({
        databaseTargetResolves: 1,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });

      const afterFirst = yield* fileSystem.readDirectory(candidateParent);
      const ownerRecordName = afterFirst.find(
        (entry) =>
          entry.startsWith("tiara-workflow-api-candidate-") && entry.endsWith(".owner.json"),
      );
      expect(ownerRecordName).toBeDefined();
      if (ownerRecordName === undefined) return;
      const ownerRecordPath = path.join(candidateParent, ownerRecordName);
      const candidateCheckout = ownerRecordPath.slice(0, -".owner.json".length);
      expect(afterFirst).toContain("preserved-candidate");
      expect(afterFirst).not.toContain(path.basename(candidateCheckout));
      const ownerRecord = JSON.parse(yield* fileSystem.readFileString(ownerRecordPath));
      const canonicalCheckoutRoot = yield* fileSystem.realPath(fixture.checkout);
      const cleanupStateByControl = {
        recover: "owner-record-cleanup-pending",
        "retention-failure": "staging",
        "candidate-reappears": "owner-record-cleanup-pending",
      } as const;
      expect(ownerRecord).toMatchObject({
        schemaVersion: 1,
        checkoutRoot: canonicalCheckoutRoot,
        candidateCheckout,
        sessionId: created.session.id,
        generation: created.session.generation,
        revision: sourceSnapshot.revision,
        token: expect.any(String),
        cleanupState: cleanupStateByControl[control],
      });

      if (control === "retention-failure") return;

      if (control === "candidate-reappears") {
        yield* fileSystem.makeDirectory(candidateCheckout, { recursive: true });
        yield* fileSystem.writeFileString(path.join(candidateCheckout, "do-not-delete"), "keep");
      }

      clock.value += 30_001;
      const resumed = yield* controller.resume(
        created.session.id,
        created.ownerIdentity,
        created.supervisorIdentity,
      );
      expect(resumed.session.generation).toBe(created.session.generation + 1);
      const resumedGroup = { ...runtimeGroup, generation: resumed.session.generation };
      const nextCounters = {
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      };
      let recoveredBeforeAdmission = false;
      const assertRecoveryBeforeAdmission = () =>
        Effect.gen(function* () {
          const entries = yield* fileSystem.readDirectory(candidateParent).pipe(
            Effect.mapError(
              () =>
                new PreviewWorkflowApiHostError({
                  reason: "workflow-source-unavailable",
                  phase: "candidate-parent-read",
                }),
            ),
          );
          expect(entries).not.toContain(path.basename(candidateCheckout));
          expect(entries).not.toContain(ownerRecordName);
          expect(
            entries.some(
              (entry) =>
                entry.startsWith("tiara-workflow-api-candidate-") && !entry.endsWith(".owner.json"),
            ),
          ).toBe(true);
          recoveredBeforeAdmission = true;
        });
      const nextAdapters = yield* makeCatalogAdmissionAdapters(
        resumedGroup,
        nextCounters,
        resolvedCatalogDigest,
        fixture.trustedRuntimeArtifactAttestations,
        assertRecoveryBeforeAdmission,
        { value: true },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(FileSystem.FileSystem, fileSystem),
            NodeHttpClient.layerNodeHttp,
          ),
        ),
      );
      const retry = yield* Effect.exit(
        nextAdapters.startProcess({ ...input, session: resumed.session, group: resumedGroup }),
      );
      expect(Exit.isFailure(retry)).toBe(true);
      if (control === "candidate-reappears") {
        expect(recoveredBeforeAdmission).toBe(false);
        expect(nextCounters).toEqual({
          databaseTargetResolves: 0,
          credentialResolves: 0,
          originResolutions: 0,
          processStarts: 0,
          routePublications: 0,
        });
        const error = Exit.isFailure(retry)
          ? Option.getOrUndefined(Cause.findErrorOption(retry.cause))
          : undefined;
        expect(error).toMatchObject({ sourceStage: "candidate-cleanup-staging-ambiguous" });
        expect(
          yield* fileSystem.readFileString(path.join(candidateCheckout, "do-not-delete")),
        ).toBe("keep");
        yield* fileSystem.remove(candidateParent, { recursive: true });
      } else {
        expect(recoveredBeforeAdmission).toBe(true);
        expect(nextCounters).toEqual({
          databaseTargetResolves: 1,
          credentialResolves: 0,
          originResolutions: 0,
          processStarts: 0,
          routePublications: 0,
        });
        expect(yield* fileSystem.readDirectory(candidateParent)).toEqual(["preserved-candidate"]);
        expect(yield* fileSystem.readFileString(path.join(preservedCandidate, "marker"))).toBe(
          "keep",
        );
        yield* fileSystem.remove(preservedCandidate, { recursive: true });
        expect(yield* fileSystem.readDirectory(candidateParent)).toEqual([]);
      }
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
  );

const runOwnerRecordDanglingSymlinkRetryControl = () =>
  withController((clock) =>
    Effect.gen(function* () {
      const scenario = yield* makeCandidateCleanupScenario(clock);
      const {
        fileSystem,
        fixture,
        sourceSnapshot,
        controller,
        created,
        runtimeGroup,
        runtimeConfig,
        candidateParent,
        preservedCandidate,
        counters,
        resolvedCatalogDigest,
        failDatabaseTargetResolution,
      } = scenario;
      let failOwnerRecordUnlink = true;
      let ownerRecordUnlinkFailures = 0;
      const cleanupFailureFileSystem = new Proxy(fileSystem, {
        get(target, property) {
          if (property === "remove")
            return (targetPath: string, options?: { readonly recursive?: boolean }) => {
              const absolutePath = path.resolve(targetPath);
              const name = path.basename(absolutePath);
              if (
                failOwnerRecordUnlink &&
                path.dirname(absolutePath) === candidateParent &&
                name.startsWith("tiara-workflow-api-candidate-") &&
                name.endsWith(".owner.json")
              ) {
                failOwnerRecordUnlink = false;
                ownerRecordUnlinkFailures += 1;
                return Effect.fail(new Error("candidate-owner-record-unlink-fixture-failure"));
              }
              return fileSystem.remove(targetPath, options);
            };
          return Reflect.get(target, property, target);
        },
      });
      const assertCandidateStaged = () =>
        fileSystem.readDirectory(candidateParent).pipe(
          Effect.map((entries) => {
            expect(
              entries.some(
                (entry) =>
                  entry.startsWith("tiara-workflow-api-candidate-") &&
                  !entry.endsWith(".owner.json"),
              ),
            ).toBe(true);
          }),
          Effect.mapError(
            () =>
              new PreviewWorkflowApiHostError({
                reason: "workflow-source-unavailable",
                phase: "candidate-parent-read",
              }),
          ),
        );
      const adapters = yield* makeCatalogAdmissionAdapters(
        runtimeGroup,
        counters,
        resolvedCatalogDigest,
        fixture.trustedRuntimeArtifactAttestations,
        assertCandidateStaged,
        failDatabaseTargetResolution,
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(FileSystem.FileSystem, cleanupFailureFileSystem),
            NodeHttpClient.layerNodeHttp,
          ),
        ),
      );
      const input = {
        checkout: fixture.checkout,
        session: created.session,
        revision: sourceSnapshot.revision,
        config: runtimeConfig,
        group: runtimeGroup,
      };

      const first = yield* Effect.exit(adapters.startProcess(input));
      expect(Exit.isFailure(first)).toBe(true);
      if (Exit.isFailure(first)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(first.cause));
        expect(error).toMatchObject({ sourceStage: "candidate-cleanup-unconfirmed" });
      }
      expect(ownerRecordUnlinkFailures).toBe(1);
      expect(counters).toEqual({
        databaseTargetResolves: 1,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });

      const afterFirst = yield* fileSystem.readDirectory(candidateParent);
      const ownerRecordName = afterFirst.find(
        (entry) =>
          entry.startsWith("tiara-workflow-api-candidate-") && entry.endsWith(".owner.json"),
      );
      expect(ownerRecordName).toBeDefined();
      if (ownerRecordName === undefined) return;
      const ownerRecordPath = path.join(candidateParent, ownerRecordName);
      const candidateCheckout = ownerRecordPath.slice(0, -".owner.json".length);
      const ownerRecord = JSON.parse(yield* fileSystem.readFileString(ownerRecordPath));
      const canonicalCheckoutRoot = yield* fileSystem.realPath(fixture.checkout);
      expect(afterFirst).toContain("preserved-candidate");
      expect(afterFirst).not.toContain(path.basename(candidateCheckout));
      expect(ownerRecord).toMatchObject({
        schemaVersion: 1,
        checkoutRoot: canonicalCheckoutRoot,
        candidateCheckout,
        sessionId: created.session.id,
        generation: created.session.generation,
        revision: sourceSnapshot.revision,
        cleanupState: "owner-record-cleanup-pending",
      });
      yield* fileSystem.symlink(
        path.join(candidateParent, "missing-candidate-target"),
        candidateCheckout,
      );

      clock.value += 30_001;
      const resumed = yield* controller.resume(
        created.session.id,
        created.ownerIdentity,
        created.supervisorIdentity,
      );
      expect(resumed.session.generation).toBe(created.session.generation + 1);
      const resumedGroup = { ...runtimeGroup, generation: resumed.session.generation };
      const nextCounters = {
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      };
      let recoveredBeforeAdmission = false;
      const assertRecoveryBeforeAdmission = () =>
        Effect.gen(function* () {
          const entries = yield* fileSystem.readDirectory(candidateParent).pipe(
            Effect.mapError(
              () =>
                new PreviewWorkflowApiHostError({
                  reason: "workflow-source-unavailable",
                  phase: "candidate-parent-read",
                }),
            ),
          );
          expect(entries).not.toContain(path.basename(candidateCheckout));
          expect(entries).not.toContain(ownerRecordName);
          expect(
            entries.some(
              (entry) =>
                entry.startsWith("tiara-workflow-api-candidate-") && !entry.endsWith(".owner.json"),
            ),
          ).toBe(true);
          recoveredBeforeAdmission = true;
        });
      const nextAdapters = yield* makeCatalogAdmissionAdapters(
        resumedGroup,
        nextCounters,
        resolvedCatalogDigest,
        fixture.trustedRuntimeArtifactAttestations,
        assertRecoveryBeforeAdmission,
        { value: true },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(FileSystem.FileSystem, fileSystem),
            NodeHttpClient.layerNodeHttp,
          ),
        ),
      );
      const rejectedDanglingEntry = yield* Effect.exit(
        nextAdapters.startProcess({ ...input, session: resumed.session, group: resumedGroup }),
      );
      expect(Exit.isFailure(rejectedDanglingEntry)).toBe(true);

      const danglingTarget = yield* fileSystem.readLink(candidateCheckout);
      const entriesAfterRetry = yield* fileSystem.readDirectory(candidateParent);
      const ownerRecordAfterRetry = JSON.parse(yield* fileSystem.readFileString(ownerRecordPath));
      const firstRetryError = Exit.isFailure(rejectedDanglingEntry)
        ? Option.getOrUndefined(Cause.findErrorOption(rejectedDanglingEntry.cause))
        : undefined;
      expect(danglingTarget).toBe(path.join(candidateParent, "missing-candidate-target"));
      expect(entriesAfterRetry).toContain(path.basename(candidateCheckout));
      expect(entriesAfterRetry).toContain(ownerRecordName);
      expect(ownerRecordAfterRetry).toEqual(ownerRecord);
      expect(firstRetryError).toMatchObject({
        sourceStage: "candidate-cleanup-staging-ambiguous",
      });
      expect(nextCounters).toEqual({
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });

      yield* fileSystem.remove(candidateCheckout);
      const retryAfterLinkRemoval = yield* Effect.exit(
        nextAdapters.startProcess({ ...input, session: resumed.session, group: resumedGroup }),
      );
      expect(Exit.isFailure(retryAfterLinkRemoval)).toBe(true);
      expect(recoveredBeforeAdmission).toBe(true);
      expect(nextCounters).toEqual({
        databaseTargetResolves: 1,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });
      expect(yield* fileSystem.readDirectory(candidateParent)).toEqual(["preserved-candidate"]);
      expect(yield* fileSystem.readFileString(path.join(preservedCandidate, "marker"))).toBe(
        "keep",
      );
      yield* fileSystem.remove(preservedCandidate, { recursive: true });
      expect(yield* fileSystem.readDirectory(candidateParent)).toEqual([]);
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
  );

it.live(
  "stages immutable package-name dependency imports and rejects mismatched links",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
      const initial = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
      expect(initial.dependencyClosureDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      const originalRuntimeBytes = yield* fileSystem.readFileString(fixture.dependencySource);
      yield* fileSystem.writeFileString(fixture.dependencySource, "export const revision = 2;\n");
      const modifiedRuntimeCandidate = yield* Effect.exit(
        stageWorkflowApiFixtureCandidate(
          fileSystem,
          fixture,
          initial.revision,
          initial.schemaArtifactDigest,
        ),
      );
      expect(Exit.isFailure(modifiedRuntimeCandidate)).toBe(true);
      if (Exit.isFailure(modifiedRuntimeCandidate)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(modifiedRuntimeCandidate.cause));
        expect(error).toMatchObject({
          phase: "dependency-store-content:checkout:candidate-dependency@1.0.0:index.mjs",
        });
      }
      yield* fileSystem.writeFileString(fixture.dependencySource, originalRuntimeBytes);
      const authDependencyLink = path.join(
        fixture.checkout,
        "packages/sheet-workflows/node_modules/sheet-auth",
      );

      yield* expectInvalidWorkspaceLink(
        fileSystem,
        fixture,
        "../../sheet-domain",
        initial.revision,
        initial.schemaArtifactDigest,
      );
      const externalTarget = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "workflow-api-external-workspace-link-",
      });
      yield* expectInvalidWorkspaceLink(
        fileSystem,
        fixture,
        externalTarget,
        initial.revision,
        initial.schemaArtifactDigest,
      );
      yield* fileSystem.remove(authDependencyLink);
      yield* fileSystem.symlink("../../sheet-auth", authDependencyLink);

      const dependencyLink = path.join(
        fixture.checkout,
        "packages/sheet-workflows/node_modules/candidate-dependency",
      );
      const dependencyPackageRoot = path.join(
        fixture.checkout,
        "node_modules/.pnpm/candidate-dependency@1.0.0/node_modules/candidate-dependency",
      );
      yield* fileSystem.remove(dependencyLink);
      yield* fileSystem.symlink(externalTarget, dependencyLink);
      const escapedDependency = yield* Effect.exit(
        stageWorkflowApiFixtureCandidate(
          fileSystem,
          fixture,
          initial.revision,
          initial.schemaArtifactDigest,
        ),
      );
      expect(Exit.isFailure(escapedDependency)).toBe(true);
      if (Exit.isFailure(escapedDependency)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(escapedDependency.cause));
        expect(error).toMatchObject({ phase: "dependency-link-outside-checkout" });
      }
      yield* fileSystem.remove(dependencyLink);
      yield* fileSystem.symlink(
        path.relative(path.dirname(dependencyLink), dependencyPackageRoot),
        dependencyLink,
      );

      const mismatchedPackageManifest = path.join(dependencyPackageRoot, "package.json");
      const originalPackageManifest = yield* fileSystem.readFileString(mismatchedPackageManifest);
      yield* fileSystem.writeFileString(
        mismatchedPackageManifest,
        originalPackageManifest.replace('"version":"1.0.0"', '"version":"2.0.0"'),
      );
      const mismatchedPackage = yield* Effect.exit(
        stageWorkflowApiFixtureCandidate(
          fileSystem,
          fixture,
          initial.revision,
          initial.schemaArtifactDigest,
        ),
      );
      expect(Exit.isFailure(mismatchedPackage)).toBe(true);
      if (Exit.isFailure(mismatchedPackage)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(mismatchedPackage.cause));
        expect(error).toMatchObject({
          phase: "dependency-lock-identity:candidate-dependency@1.0.0",
        });
      }
      yield* fileSystem.writeFileString(mismatchedPackageManifest, originalPackageManifest);

      const originalInstalledLock = yield* fileSystem.readFileString(
        path.join(fixture.checkout, "node_modules/.pnpm/lock.yaml"),
      );
      yield* fileSystem.writeFileString(
        path.join(fixture.checkout, "node_modules/.pnpm/lock.yaml"),
        `${originalInstalledLock}# altered installed lock identity\n`,
      );
      const mismatchedInstalledLock = yield* Effect.exit(
        stageWorkflowApiFixtureCandidate(
          fileSystem,
          fixture,
          initial.revision,
          initial.schemaArtifactDigest,
        ),
      );
      expect(Exit.isFailure(mismatchedInstalledLock)).toBe(true);
      if (Exit.isFailure(mismatchedInstalledLock)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(mismatchedInstalledLock.cause));
        expect(error).toMatchObject({ phase: "installed-dependency-lockfile-mismatch" });
      }
      yield* fileSystem.writeFileString(
        path.join(fixture.checkout, "node_modules/.pnpm/lock.yaml"),
        originalInstalledLock,
      );

      const lockfilePath = path.join(fixture.checkout, "pnpm-lock.yaml");
      const originalSourceLock = yield* fileSystem.readFileString(lockfilePath);
      const workflowManifestPath = path.join(
        fixture.checkout,
        "packages/sheet-workflows/package.json",
      );
      const originalWorkflowManifest = yield* fileSystem.readFileString(workflowManifestPath);
      const declaredWorkflowManifest = Schema.decodeUnknownSync(
        Schema.Struct({
          name: Schema.String,
          dependencies: Schema.Record(Schema.String, Schema.String),
        }),
      )(JSON.parse(originalWorkflowManifest));
      const undeclaredWorkflowManifest = {
        ...declaredWorkflowManifest,
        dependencies: Object.fromEntries(
          Object.entries(declaredWorkflowManifest.dependencies ?? {}).filter(
            ([name]) => name !== "candidate-dependency",
          ),
        ),
      };
      expect(undeclaredWorkflowManifest.name).toBe("sheet-workflows");
      const emptyDependencyLock = originalSourceLock
        .replace(
          `      candidate-dependency:\n        specifier: 1.0.0\n        version: 1.0.0\n`,
          "",
        )
        .replace(
          `  candidate-dependency@1.0.0:\n    resolution:\n      integrity: sha512-${Buffer.alloc(64).toString("base64")}\n`,
          "",
        )
        .replace("  candidate-dependency@1.0.0: {}\n", "");
      expect(emptyDependencyLock).not.toBe(originalSourceLock);
      yield* fileSystem.writeFileString(
        workflowManifestPath,
        JSON.stringify(undeclaredWorkflowManifest),
      );
      yield* fileSystem.writeFileString(lockfilePath, emptyDependencyLock);
      yield* fileSystem.writeFileString(
        path.join(fixture.checkout, "node_modules/.pnpm/lock.yaml"),
        emptyDependencyLock,
      );
      const undeclaredCandidateDependency = yield* Effect.exit(
        stageWorkflowApiFixtureCandidate(
          fileSystem,
          fixture,
          initial.revision,
          initial.schemaArtifactDigest,
        ),
      );
      expect(Exit.isFailure(undeclaredCandidateDependency)).toBe(true);
      if (Exit.isFailure(undeclaredCandidateDependency)) {
        const error = Option.getOrUndefined(
          Cause.findErrorOption(undeclaredCandidateDependency.cause),
        );
        expect(error).toMatchObject({
          phase: "dependency-not-in-lock-importer:packages/sheet-workflows:candidate-dependency",
        });
      }
      yield* fileSystem.writeFileString(workflowManifestPath, originalWorkflowManifest);
      yield* fileSystem.writeFileString(lockfilePath, originalSourceLock);
      yield* fileSystem.writeFileString(
        path.join(fixture.checkout, "node_modules/.pnpm/lock.yaml"),
        originalInstalledLock,
      );

      const malformedIntegrityLock = originalSourceLock.replace(
        `sha512-${Buffer.alloc(64).toString("base64")}`,
        "sha512-invalid",
      );
      expect(malformedIntegrityLock).not.toBe(originalSourceLock);
      yield* fileSystem.writeFileString(lockfilePath, malformedIntegrityLock);
      yield* fileSystem.writeFileString(
        path.join(fixture.checkout, "node_modules/.pnpm/lock.yaml"),
        malformedIntegrityLock,
      );
      const malformedIntegrity = yield* Effect.exit(
        stageWorkflowApiFixtureCandidate(
          fileSystem,
          fixture,
          initial.revision,
          initial.schemaArtifactDigest,
        ),
      );
      expect(Exit.isFailure(malformedIntegrity)).toBe(true);
      if (Exit.isFailure(malformedIntegrity)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(malformedIntegrity.cause));
        expect(error).toMatchObject({
          phase: "dependency-lock-integrity:candidate-dependency@1.0.0",
        });
      }
      yield* fileSystem.writeFileString(lockfilePath, originalSourceLock);
      yield* fileSystem.writeFileString(
        path.join(fixture.checkout, "node_modules/.pnpm/lock.yaml"),
        originalInstalledLock,
      );

      const unlistedPackageRoot = path.join(
        fixture.checkout,
        "node_modules/.pnpm/unlisted-dependency@1.0.0/node_modules/unlisted-dependency",
      );
      yield* fileSystem.makeDirectory(unlistedPackageRoot, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(unlistedPackageRoot, "package.json"),
        '{"name":"unlisted-dependency","version":"1.0.0"}\n',
      );
      const unlistedLink = path.join(
        fixture.checkout,
        "packages/sheet-workflows/node_modules/unlisted-dependency",
      );
      yield* fileSystem.symlink(
        path.relative(path.dirname(unlistedLink), unlistedPackageRoot),
        unlistedLink,
      );
      const unlistedDependency = yield* Effect.exit(
        stageWorkflowApiFixtureCandidate(
          fileSystem,
          fixture,
          initial.revision,
          initial.schemaArtifactDigest,
        ),
      );
      expect(Exit.isFailure(unlistedDependency)).toBe(true);
      if (Exit.isFailure(unlistedDependency)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(unlistedDependency.cause));
        expect(error).toMatchObject({
          phase: "dependency-not-in-lock-importer:packages/sheet-workflows:unlisted-dependency",
        });
      }
      yield* fileSystem.remove(unlistedLink);

      const candidate = yield* Effect.acquireRelease(
        stageWorkflowApiFixtureCandidate(
          fileSystem,
          fixture,
          initial.revision,
          initial.schemaArtifactDigest,
        ),
        (staged) => fileSystem.remove(staged.checkout, { recursive: true }).pipe(Effect.orDie),
      );
      expect(
        yield* fileSystem.readFileString(
          path.join(candidate.checkout, "node_modules/.pnpm/lock.yaml"),
        ),
      ).toBe(yield* fileSystem.readFileString(path.join(fixture.checkout, "pnpm-lock.yaml")));
      expect(yield* fileSystem.exists(path.join(candidate.checkout, "node_modules/.bin"))).toBe(
        false,
      );
      yield* fileSystem.writeFileString(
        fixture.dependencyBinSource,
        "export const binRevision = 2;\n",
      );
      expect(
        yield* fileSystem.exists(path.join(candidate.checkout, "node_modules/.bin/candidate-bin")),
      ).toBe(false);
      yield* runCandidatePackageNameImport(
        fileSystem,
        candidate.checkout,
        fixture.authSource,
        fixture.dependencySource,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  30_000,
);

it.live(
  "rejects package-index and matching CAS changes under the same lock identity",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
      const lockfilePath = path.join(fixture.checkout, "pnpm-lock.yaml");
      const originalLockfile = yield* fileSystem.readFileString(lockfilePath);
      const attestationsPath = path.join(
        fixture.checkout,
        "preview-workflow-api-runtime-attestations.json",
      );
      const originalAttestations = yield* fileSystem.readFileString(attestationsPath);
      const original = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
      expect(original.dependencyClosureDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(originalLockfile).toContain(`integrity: ${candidateDependencyIntegrity}`);

      yield* fileSystem.writeFileString(fixture.dependencySource, "export const revision = 2;\n");
      const forgedIndex = yield* workflowApiFixturePackageIndex(
        fileSystem,
        fixture.storeDirectory,
        path.dirname(fixture.dependencySource),
        "candidate-dependency",
        "1.0.0",
      );
      yield* updateWorkflowApiPnpmStoreIndex(fixture.storeDirectory, {
        integrity: candidateDependencyIntegrity,
        name: "candidate-dependency",
        version: "1.0.0",
        index: forgedIndex,
      });

      expect(yield* fileSystem.readFileString(lockfilePath)).toBe(originalLockfile);
      expect(yield* fileSystem.readFileString(attestationsPath)).toBe(originalAttestations);
      const reindexedSnapshot = yield* Effect.exit(
        previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture),
      );
      expect(Exit.isFailure(reindexedSnapshot)).toBe(true);
      if (Exit.isFailure(reindexedSnapshot)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(reindexedSnapshot.cause));
        expect(error).toMatchObject({
          phase: "dependency-artifact-runtime-identity:candidate-dependency@1.0.0",
        });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  30_000,
);

it.live(
  "rejects a changed generated native output without an independent attestation",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
      yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
      const attestationsPath = path.join(
        fixture.checkout,
        "preview-workflow-api-runtime-attestations.json",
      );
      const approvedAttestations = yield* fileSystem.readFileString(attestationsPath);
      const nativeOutputPath = path.join(
        path.dirname(fixture.dependencySource),
        "build/Release/fixture.node",
      );
      yield* fileSystem.makeDirectory(path.dirname(nativeOutputPath), { recursive: true });
      yield* fileSystem.writeFileString(nativeOutputPath, "generated-native-v1\n");
      yield* fileSystem.chmod(nativeOutputPath, 0o444);

      const changedSnapshot = yield* Effect.exit(
        previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture),
      );
      expect(Exit.isFailure(changedSnapshot)).toBe(true);
      if (Exit.isFailure(changedSnapshot)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(changedSnapshot.cause));
        expect(error).toMatchObject({
          phase: "dependency-artifact-runtime-identity:candidate-dependency@1.0.0",
        });
      }
      expect(yield* fileSystem.readFileString(attestationsPath)).toBe(approvedAttestations);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  30_000,
);

it.live(
  "stages a package patched by the exact lock-bound patch with a trusted attestation",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
      const patchPath = "patches/candidate-dependency.patch";
      const patchBytes =
        "--- a/index.mjs\n" +
        "+++ b/index.mjs\n" +
        "@@ -1 +1 @@\n" +
        "-export const revision = 1;\n" +
        "+export const revision = 2;\n";
      const patchHash = createHash("sha256").update(patchBytes).digest("hex");
      const packageLocator = "candidate-dependency@1.0.0";
      const patchedPackageId = `${packageLocator}(patch_hash=${patchHash})`;
      const patchedStoreDirectory = `${packageLocator}_patch_hash=${patchHash}`;
      yield* fileSystem.writeFileString(path.join(fixture.checkout, patchPath), patchBytes);

      const rootManifestPath = path.join(fixture.checkout, "package.json");
      const rootManifest = Schema.decodeUnknownSync(
        Schema.Struct({
          name: Schema.String,
          devDependencies: Schema.Record(Schema.String, Schema.String),
        }),
      )(JSON.parse(yield* fileSystem.readFileString(rootManifestPath)));
      yield* fileSystem.writeFileString(
        rootManifestPath,
        `${JSON.stringify({
          ...rootManifest,
          pnpm: { patchedDependencies: { [packageLocator]: patchPath } },
        })}\n`,
      );

      const lockPath = path.join(fixture.checkout, "pnpm-lock.yaml");
      const originalLock = yield* fileSystem.readFileString(lockPath);
      const patchedResolution = `1.0.0(patch_hash=${patchHash})`;
      const patchedLock = originalLock
        .replace(
          "lockfileVersion: '9.0'\n",
          `lockfileVersion: '9.0'\npatchedDependencies:\n  ${packageLocator}: ${patchHash}\n`,
        )
        .replace("        version: 1.0.0\n", `        version: ${patchedResolution}\n`)
        .replace("  candidate-dependency@1.0.0: {}\n", `  ${patchedPackageId}: {}\n`);
      expect(patchedLock).not.toBe(originalLock);
      yield* fileSystem.writeFileString(lockPath, patchedLock);
      yield* fileSystem.writeFileString(
        path.join(fixture.checkout, "node_modules/.pnpm/lock.yaml"),
        patchedLock,
      );

      const originalPackageRoot = path.dirname(fixture.dependencySource);
      const patchedPackageRoot = path.join(
        fixture.checkout,
        "node_modules/.pnpm",
        patchedStoreDirectory,
        "node_modules/candidate-dependency",
      );
      yield* fileSystem.makeDirectory(patchedPackageRoot, { recursive: true });
      const packageManifest = yield* fileSystem.readFileString(
        path.join(originalPackageRoot, "package.json"),
      );
      yield* fileSystem.writeFileString(
        path.join(patchedPackageRoot, "package.json"),
        packageManifest,
      );
      yield* fileSystem.writeFileString(
        path.join(patchedPackageRoot, "index.mjs"),
        "export const revision = 2;\n",
      );
      const dependencyLink = path.join(
        fixture.checkout,
        "packages/sheet-workflows/node_modules/candidate-dependency",
      );
      yield* fileSystem.remove(dependencyLink);
      yield* fileSystem.symlink(
        path.relative(path.dirname(dependencyLink), patchedPackageRoot),
        dependencyLink,
      );

      const patchedPackageIndex = yield* workflowApiFixturePackageIndex(
        fileSystem,
        fixture.storeDirectory,
        patchedPackageRoot,
        "candidate-dependency",
        "1.0.0",
      );
      const packages = { ...fixture.trustedRuntimeArtifactAttestations.packages };
      delete packages[packageLocator];
      packages[patchedPackageId] = {
        integrity: candidateDependencyIntegrity,
        runtimeDigest: workflowApiFixtureRuntimeDigest(patchedPackageIndex.files),
      };
      const patchedRuntimeArtifactAttestations = {
        schemaVersion: 1 as const,
        packages,
      } satisfies PreviewWorkflowApiRuntimeArtifactAttestations;

      const patchFile = path.join(fixture.checkout, patchPath);
      yield* fileSystem.writeFileString(
        patchFile,
        patchBytes.replace("revision = 2", "revision = 3"),
      );
      const changedLockPatch = yield* Effect.exit(
        previewWorkflowApiFixtureSourceSnapshot(
          fileSystem,
          fixture,
          patchedRuntimeArtifactAttestations,
        ),
      );
      expect(Exit.isFailure(changedLockPatch)).toBe(true);
      if (Exit.isFailure(changedLockPatch)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(changedLockPatch.cause));
        expect(error).toMatchObject({
          phase: `dependency-patch-content:${packageLocator}`,
        });
      }
      yield* fileSystem.writeFileString(patchFile, patchBytes);

      const source = yield* previewWorkflowApiFixtureSourceSnapshot(
        fileSystem,
        fixture,
        patchedRuntimeArtifactAttestations,
      );
      const candidate = yield* Effect.acquireRelease(
        stageWorkflowApiFixtureCandidate(
          fileSystem,
          fixture,
          source.revision,
          source.schemaArtifactDigest,
          patchedRuntimeArtifactAttestations,
        ),
        (staged) => fileSystem.remove(staged.checkout, { recursive: true }).pipe(Effect.orDie),
      );
      yield* runCandidatePackageNameImport(
        fileSystem,
        candidate.checkout,
        fixture.authSource,
        path.join(patchedPackageRoot, "index.mjs"),
        "2",
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  30_000,
);

it.live(
  "rejects a runtime closure without an independently supplied artifact attestation",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
      yield* fileSystem.writeFileString(
        path.join(fixture.checkout, "preview-workflow-api-runtime-attestations.json"),
        '{"schemaVersion":1,"packages":{}}\n',
      );
      const source = yield* Effect.exit(
        previewWorkflowApiSourceSnapshot(fileSystem, fixture.checkout),
      );
      expect(Exit.isFailure(source)).toBe(true);
      if (Exit.isFailure(source)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(source.cause));
        expect(error).toMatchObject({
          phase: "dependency-artifact-attestation-provider-unavailable",
        });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  60_000,
);

it.live(
  "rejects checkout-authored policy during source and staged candidate admission",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
      const initial = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
      const policyPath = path.join(
        fixture.checkout,
        "preview-workflow-api-runtime-attestations.json",
      );
      const emptyPlaceholder = yield* fileSystem.readFileString(policyPath);
      yield* fileSystem.writeFileString(
        policyPath,
        `${JSON.stringify(fixture.trustedRuntimeArtifactAttestations)}\n`,
      );

      const editedSource = yield* Effect.exit(
        previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture),
      );
      expect(Exit.isFailure(editedSource)).toBe(true);
      if (Exit.isFailure(editedSource)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(editedSource.cause));
        expect(error).toMatchObject({ phase: "dependency-artifact-source-policy-untrusted" });
      }

      const stagedSubstitution = yield* Effect.exit(
        stageWorkflowApiFixtureCandidate(
          fileSystem,
          fixture,
          initial.revision,
          initial.schemaArtifactDigest,
        ),
      );
      expect(Exit.isFailure(stagedSubstitution)).toBe(true);
      if (Exit.isFailure(stagedSubstitution)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(stagedSubstitution.cause));
        expect(error).toMatchObject({ phase: "dependency-artifact-source-policy-untrusted" });
      }
      yield* fileSystem.writeFileString(policyPath, emptyPlaceholder);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  30_000,
);

it.live(
  "keeps the repository producer runtime unavailable without trusted package attestations",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const source = yield* Effect.exit(
        previewWorkflowApiSourceSnapshot(fileSystem, repositoryRoot),
      );
      expect(Exit.isFailure(source)).toBe(true);
      if (Exit.isFailure(source)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(source.cause));
        expect(error).toMatchObject({ reason: "workflow-source-unavailable" });
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  60_000,
);

it.live("binds source revisions to loaded runtime roots and migration bytes", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
    const initial = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
    yield* fileSystem.writeFileString(fixture.authSource, "export const policyRevision = 2;\n");
    const changedAuth = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
    expect(changedAuth.revision).not.toBe(initial.revision);
    expect(changedAuth.schemaArtifactDigest).toBe(initial.schemaArtifactDigest);

    yield* applyRuntimeSourceMutations(fileSystem, fixture.checkout);
    const changedRuntime = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
    expect(changedRuntime.revision).not.toBe(initial.revision);
    expect(changedRuntime.schemaArtifactDigest).toBe(initial.schemaArtifactDigest);
    yield* assertMigrationArtifactIdentityControls(fileSystem, fixture, initial);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.live("rejects file and directory symlinks that escape the source checkout", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
    const outside = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "workflow-api-outside-source-",
    });
    const outsideFile = path.join(outside, "outside.ts");
    yield* fileSystem.writeFileString(outsideFile, "export const outside = true;\n");

    const fileLink = path.join(fixture.checkout, "packages/sheet-workflows/src/outside.ts");
    yield* fileSystem.symlink(outsideFile, fileLink);
    const fileSnapshot = yield* Effect.exit(
      previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture),
    );
    expect(Exit.isFailure(fileSnapshot)).toBe(true);

    yield* fileSystem.remove(fileLink);
    const directoryLink = path.join(fixture.checkout, "packages/sheet-workflows/src/outside");
    yield* fileSystem.symlink(outside, directoryLink);
    const directorySnapshot = yield* Effect.exit(
      previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture),
    );
    expect(Exit.isFailure(directorySnapshot)).toBe(true);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.live("rejects catalog and migration mismatches before credentials or publication", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
      const initial = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
      const changedSchema = yield* assertMigrationArtifactIdentityControls(
        fileSystem,
        fixture,
        initial,
      );
      expect(changedSchema.schemaArtifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      const changedSchemaArtifactDigest: typeof schemaDigest = `sha256:${changedSchema.schemaArtifactDigest.slice("sha256:".length)}`;
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: fixture.checkout,
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: changedSchema.revision,
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      const runtimeGroup = {
        ...group,
        sessionId: created.session.id,
        generation: created.session.generation,
        schemaArtifactDigest: changedSchemaArtifactDigest,
      };
      const runtimeConfig: ConnectedPreviewConfig = {
        ...config,
        identities: {
          ...config.identities,
          sourceRevision: changedSchema.revision,
          schemaArtifactDigest: changedSchemaArtifactDigest,
        },
        groups: config.groups.map((candidate) =>
          candidate.id === "workflow-execution"
            ? { ...candidate, schemaArtifactDigest: changedSchemaArtifactDigest }
            : candidate,
        ),
      };
      const counters = {
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      };
      const resolvedCatalogDigest = { value: runtimeGroup.workflowContractCatalogDigest };
      const failDatabaseTargetResolution = { value: false };
      const candidateParent = path.join(
        path.dirname(fixture.checkout),
        ".tiara-workflow-api-candidates",
        path.basename(fixture.checkout),
      );
      const assertCandidateStaged = () =>
        fileSystem.readDirectory(candidateParent).pipe(
          Effect.map((entries) => {
            expect(entries.some((entry) => entry.startsWith("tiara-workflow-api-candidate-"))).toBe(
              true,
            );
          }),
          Effect.mapError(
            () =>
              new PreviewWorkflowApiHostError({
                reason: "workflow-source-unavailable",
                phase: "candidate-not-staged-before-database-target",
              }),
          ),
        );
      const adapters = yield* makeCatalogAdmissionAdapters(
        runtimeGroup,
        counters,
        resolvedCatalogDigest,
        fixture.trustedRuntimeArtifactAttestations,
        assertCandidateStaged,
        failDatabaseTargetResolution,
      );
      const unlistedMigrationPath = path.resolve(
        fixture.checkout,
        "packages/sheet-db-schema/effect-sql-migrations/0002_unlisted.ts",
      );
      const unlistedMigration = yield* Effect.exit(
        adapters.startProcess({
          checkout: fixture.checkout,
          session: created.session,
          revision: changedSchema.revision,
          config: runtimeConfig,
          group: runtimeGroup,
        }),
      );
      expect(Exit.isFailure(unlistedMigration)).toBe(true);
      if (Exit.isFailure(unlistedMigration)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(unlistedMigration.cause));
        expect(error).toMatchObject({ reason: "workflow-source-unavailable" });
      }
      expect(counters).toEqual({
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });

      yield* fileSystem.remove(unlistedMigrationPath);
      const dependencyPackageRoot = path.dirname(fixture.dependencySource);
      const originalDependencyBytes = yield* fileSystem.readFileString(fixture.dependencySource);
      yield* fileSystem.writeFileString(fixture.dependencySource, "export const revision = 2;\n");
      const forgedPackageIndex = yield* workflowApiFixturePackageIndex(
        fileSystem,
        fixture.storeDirectory,
        dependencyPackageRoot,
        "candidate-dependency",
        "1.0.0",
      );
      yield* updateWorkflowApiPnpmStoreIndex(fixture.storeDirectory, {
        integrity: candidateDependencyIntegrity,
        name: "candidate-dependency",
        version: "1.0.0",
        index: forgedPackageIndex,
      });
      // The adapter has already copied its provider input. Mutating the caller's
      // object cannot authorize the matching attacker-controlled package bytes.
      fixture.trustedRuntimeArtifactAttestations.packages["candidate-dependency@1.0.0"] = {
        integrity: candidateDependencyIntegrity,
        runtimeDigest: workflowApiFixtureRuntimeDigest(forgedPackageIndex.files),
      };
      const sourcePolicyPath = path.join(
        fixture.checkout,
        "preview-workflow-api-runtime-attestations.json",
      );
      const sourcePolicyBytes = yield* fileSystem.readFileString(sourcePolicyPath);
      const forgedPolicyPackages = {
        ...fixture.trustedRuntimeArtifactAttestations.packages,
        "candidate-dependency@1.0.0": {
          integrity: candidateDependencyIntegrity,
          runtimeDigest: workflowApiFixtureRuntimeDigest(forgedPackageIndex.files),
        },
      };
      yield* fileSystem.writeFileString(
        sourcePolicyPath,
        `${JSON.stringify({ schemaVersion: 1, packages: forgedPolicyPackages })}\n`,
      );
      const untrustedRuntime = yield* Effect.exit(
        adapters.startProcess({
          checkout: fixture.checkout,
          session: created.session,
          revision: changedSchema.revision,
          config: runtimeConfig,
          group: runtimeGroup,
        }),
      );
      expect(Exit.isFailure(untrustedRuntime)).toBe(true);
      if (Exit.isFailure(untrustedRuntime)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(untrustedRuntime.cause));
        expect(error).toMatchObject({ reason: "workflow-source-unavailable" });
      }
      expect(counters).toEqual({
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });
      yield* fileSystem.writeFileString(sourcePolicyPath, sourcePolicyBytes);
      const fixedAnchorRejectsChangedRuntime = yield* Effect.exit(
        adapters.startProcess({
          checkout: fixture.checkout,
          session: created.session,
          revision: changedSchema.revision,
          config: runtimeConfig,
          group: runtimeGroup,
        }),
      );
      expect(Exit.isFailure(fixedAnchorRejectsChangedRuntime)).toBe(true);
      if (Exit.isFailure(fixedAnchorRejectsChangedRuntime)) {
        const error = Option.getOrUndefined(
          Cause.findErrorOption(fixedAnchorRejectsChangedRuntime.cause),
        );
        expect(error).toMatchObject({ reason: "workflow-source-unavailable" });
      }
      expect(counters).toEqual({
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });
      yield* fileSystem.writeFileString(fixture.dependencySource, originalDependencyBytes);
      const originalPackageIndex = yield* workflowApiFixturePackageIndex(
        fileSystem,
        fixture.storeDirectory,
        dependencyPackageRoot,
        "candidate-dependency",
        "1.0.0",
      );
      yield* updateWorkflowApiPnpmStoreIndex(fixture.storeDirectory, {
        integrity: candidateDependencyIntegrity,
        name: "candidate-dependency",
        version: "1.0.0",
        index: originalPackageIndex,
      });
      fixture.trustedRuntimeArtifactAttestations.packages["candidate-dependency@1.0.0"] = {
        integrity: candidateDependencyIntegrity,
        runtimeDigest: workflowApiFixtureRuntimeDigest(originalPackageIndex.files),
      };

      const nativeOutputPath = path.join(dependencyPackageRoot, "build/Release/fixture.node");
      yield* fileSystem.makeDirectory(path.dirname(nativeOutputPath), { recursive: true });
      yield* fileSystem.writeFileString(nativeOutputPath, "unapproved generated output\n");
      yield* fileSystem.chmod(nativeOutputPath, 0o444);
      const unapprovedNativeOutput = yield* Effect.exit(
        adapters.startProcess({
          checkout: fixture.checkout,
          session: created.session,
          revision: changedSchema.revision,
          config: runtimeConfig,
          group: runtimeGroup,
        }),
      );
      expect(Exit.isFailure(unapprovedNativeOutput)).toBe(true);
      if (Exit.isFailure(unapprovedNativeOutput)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(unapprovedNativeOutput.cause));
        expect(error).toMatchObject({ reason: "workflow-source-unavailable" });
      }
      expect(counters).toEqual({
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });
      yield* fileSystem.remove(nativeOutputPath);

      resolvedCatalogDigest.value = digest("e");
      const catalogMismatch = yield* Effect.exit(
        adapters.startProcess({
          checkout: fixture.checkout,
          session: created.session,
          revision: changedSchema.revision,
          config: runtimeConfig,
          group: runtimeGroup,
        }),
      );
      expect(Exit.isFailure(catalogMismatch)).toBe(true);
      if (Exit.isFailure(catalogMismatch)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(catalogMismatch.cause));
        expect(error).toMatchObject({ reason: "workflow-catalog-incompatible" });
      }
      expect(counters).toEqual({
        databaseTargetResolves: 1,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });
      expect(yield* fileSystem.readDirectory(candidateParent)).toEqual([]);

      resolvedCatalogDigest.value = runtimeGroup.workflowContractCatalogDigest;
      failDatabaseTargetResolution.value = true;
      const targetResolverFailure = yield* Effect.exit(
        adapters.startProcess({
          checkout: fixture.checkout,
          session: created.session,
          revision: changedSchema.revision,
          config: runtimeConfig,
          group: runtimeGroup,
        }),
      );
      expect(Exit.isFailure(targetResolverFailure)).toBe(true);
      expect(counters).toEqual({
        databaseTargetResolves: 2,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });
      expect(yield* fileSystem.readDirectory(candidateParent)).toEqual([]);
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
  ),
);

it.live("retains exact candidate ownership after staging cleanup failure", () =>
  runCandidateCleanupRetryControl("stage"),
);

it.live("retains exact candidate ownership after credential cleanup failure", () =>
  runCandidateCleanupRetryControl("credentials"),
);

it.live("retains exact candidate ownership after route cleanup failure", () =>
  runCandidateCleanupRetryControl("origin"),
);

it.live("retains exact candidate ownership after process-start cleanup failure", () =>
  runCandidateCleanupRetryControl("process-start"),
);

it.live("retains exact candidate ownership across fresh adapter resume", () =>
  runCandidateCleanupFreshAdapterRetryControl(),
);

it.live(
  "retains exact owner record after unlink failure and retries after fresh adapter resume",
  () => runOwnerRecordCleanupRetryControl("recover"),
);

it.live("surfaces owner-record retention failure without claiming durable recovery", () =>
  runOwnerRecordCleanupRetryControl("retention-failure"),
);

it.live("retains owner record when the candidate path is a dangling symlink", () =>
  runOwnerRecordDanglingSymlinkRetryControl(),
);

it.live("does not delete an existing candidate for a pending owner-record cleanup", () =>
  runOwnerRecordCleanupRetryControl("candidate-reappears"),
);

it.live(
  "retains exact candidate ownership across fresh adapter resume after inspection failure",
  () => runCandidateCleanupFreshAdapterRetryControl("stat"),
);

it.live("retains exact candidate ownership across fresh adapter resume after exists failure", () =>
  runCandidateCleanupFreshAdapterRetryControl("exists"),
);

it.live(
  "retains exact candidate ownership across fresh adapter resume after realpath failure",
  () => runCandidateCleanupFreshAdapterRetryControl("realPath"),
);

it.live("reports unconfirmed candidate cleanup after database target failure", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
      const sourceSnapshot = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
      const sourceSchemaArtifactDigest: typeof schemaDigest = `sha256:${sourceSnapshot.schemaArtifactDigest.slice("sha256:".length)}`;
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: fixture.checkout,
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: sourceSnapshot.revision,
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      const runtimeGroup = {
        ...group,
        sessionId: created.session.id,
        generation: created.session.generation,
        schemaArtifactDigest: sourceSchemaArtifactDigest,
      };
      const runtimeConfig: ConnectedPreviewConfig = {
        ...config,
        identities: {
          ...config.identities,
          sourceRevision: sourceSnapshot.revision,
          schemaArtifactDigest: sourceSchemaArtifactDigest,
        },
        groups: config.groups.map((candidate) =>
          candidate.id === "workflow-execution"
            ? { ...candidate, schemaArtifactDigest: sourceSchemaArtifactDigest }
            : candidate,
        ),
      };
      const counters = {
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      };
      const resolvedCatalogDigest = { value: runtimeGroup.workflowContractCatalogDigest };
      const failDatabaseTargetResolution = { value: true };
      const candidateParent = path.join(
        path.dirname(fixture.checkout),
        ".tiara-workflow-api-candidates",
        path.basename(fixture.checkout),
      );
      const preservedCandidate = path.join(candidateParent, "preserved-candidate");
      yield* fileSystem.makeDirectory(preservedCandidate, { recursive: true });
      yield* fileSystem.writeFileString(path.join(preservedCandidate, "marker"), "keep");
      let candidateCleanupFailures = 0;
      let failCandidateCleanup = true;
      const cleanupFailingFileSystem = new Proxy(fileSystem, {
        get(target, property) {
          if (property === "remove")
            return (targetPath: string, options?: { readonly recursive?: boolean }) => {
              const absolutePath = path.resolve(targetPath);
              if (
                failCandidateCleanup &&
                path.dirname(absolutePath) === candidateParent &&
                path.basename(absolutePath).startsWith("tiara-workflow-api-candidate-") &&
                !path.basename(absolutePath).includes(".owner.json")
              ) {
                candidateCleanupFailures += 1;
                return Effect.fail(new Error("candidate-cleanup-fixture-failure"));
              }
              return fileSystem.remove(targetPath, options);
            };
          return Reflect.get(target, property, target);
        },
      });
      const adapters = yield* makeCatalogAdmissionAdapters(
        runtimeGroup,
        counters,
        resolvedCatalogDigest,
        fixture.trustedRuntimeArtifactAttestations,
        () =>
          fileSystem.readDirectory(candidateParent).pipe(
            Effect.map((entries) => {
              expect(
                entries.some((entry) => entry.startsWith("tiara-workflow-api-candidate-")),
              ).toBe(true);
            }),
            Effect.mapError(
              () =>
                new PreviewWorkflowApiHostError({
                  reason: "workflow-source-unavailable",
                  phase: "candidate-not-staged-before-database-target",
                }),
            ),
          ),
        failDatabaseTargetResolution,
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(FileSystem.FileSystem, cleanupFailingFileSystem),
            NodeHttpClient.layerNodeHttp,
          ),
        ),
      );

      const cleanupFailure = yield* Effect.exit(
        adapters.startProcess({
          checkout: fixture.checkout,
          session: created.session,
          revision: sourceSnapshot.revision,
          config: runtimeConfig,
          group: runtimeGroup,
        }),
      );
      expect(Exit.isFailure(cleanupFailure)).toBe(true);
      if (Exit.isFailure(cleanupFailure)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(cleanupFailure.cause));
        expect(error).toMatchObject({
          reason: "workflow-api-credentials-unavailable",
          sourceStage: "candidate-cleanup-unconfirmed",
        });
      }
      expect(candidateCleanupFailures).toBe(1);
      expect(counters).toEqual({
        databaseTargetResolves: 1,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });
      const candidateEntries = yield* fileSystem.readDirectory(candidateParent);
      expect(candidateEntries).toContain("preserved-candidate");
      const ownedCandidate = candidateEntries.find(
        (entry) =>
          entry.startsWith("tiara-workflow-api-candidate-") && !entry.includes(".owner.json"),
      );
      expect(ownedCandidate).toBeDefined();
      if (ownedCandidate === undefined) return;
      expect(candidateEntries).toContain(`${ownedCandidate}.owner.json`);
      const ownerRecord = JSON.parse(
        yield* fileSystem.readFileString(
          path.join(candidateParent, `${ownedCandidate}.owner.json`),
        ),
      );
      expect(ownerRecord.cleanupState).toBe("cleanup-pending");
      expect(yield* fileSystem.readFileString(path.join(preservedCandidate, "marker"))).toBe(
        "keep",
      );
      expect(ownedCandidate).toBeDefined();

      // A later same-session start retries only the exact candidate path this
      // adapter owns, then stages a fresh candidate for the next attempt.
      failCandidateCleanup = false;
      const retry = yield* Effect.exit(
        adapters.startProcess({
          checkout: fixture.checkout,
          session: created.session,
          revision: sourceSnapshot.revision,
          config: runtimeConfig,
          group: runtimeGroup,
        }),
      );
      expect(Exit.isFailure(retry)).toBe(true);
      if (Exit.isFailure(retry)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(retry.cause));
        expect(error).toMatchObject({ reason: "workflow-api-credentials-unavailable" });
      }
      expect(candidateCleanupFailures).toBe(1);
      expect(counters).toEqual({
        databaseTargetResolves: 2,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });
      const afterRetryEntries = yield* fileSystem.readDirectory(candidateParent);
      expect(afterRetryEntries).toEqual(["preserved-candidate"]);
      if (ownedCandidate !== undefined) expect(afterRetryEntries).not.toContain(ownedCandidate);
      yield* fileSystem.remove(preservedCandidate, { recursive: true });
      expect(yield* fileSystem.readDirectory(candidateParent)).toEqual([]);
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
  ),
);

it.live("rejects a staged runtime policy substitution before database admission", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
      const sourceSnapshot = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
      const sourceSchemaArtifactDigest: typeof schemaDigest = `sha256:${sourceSnapshot.schemaArtifactDigest.slice("sha256:".length)}`;
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: fixture.checkout,
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: sourceSnapshot.revision,
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      const runtimeGroup = {
        ...group,
        sessionId: created.session.id,
        generation: created.session.generation,
        schemaArtifactDigest: sourceSchemaArtifactDigest,
      };
      const runtimeConfig: ConnectedPreviewConfig = {
        ...config,
        identities: {
          ...config.identities,
          sourceRevision: sourceSnapshot.revision,
          schemaArtifactDigest: sourceSchemaArtifactDigest,
        },
        groups: config.groups.map((candidate) =>
          candidate.id === "workflow-execution"
            ? { ...candidate, schemaArtifactDigest: sourceSchemaArtifactDigest }
            : candidate,
        ),
      };
      const counters = {
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      };
      const resolvedCatalogDigest = { value: runtimeGroup.workflowContractCatalogDigest };
      const sourcePolicyPath = path.join(
        fixture.checkout,
        "preview-workflow-api-runtime-attestations.json",
      );
      const sourcePolicyBefore = yield* fileSystem.readFileString(sourcePolicyPath);
      const trustedAnchorBefore = JSON.stringify(fixture.trustedRuntimeArtifactAttestations);
      const candidateParent = path.join(
        path.dirname(fixture.checkout),
        ".tiara-workflow-api-candidates",
        path.basename(fixture.checkout),
      );
      let stagedPolicySubstitutionCount = 0;
      let stagedCandidatePolicyObserved = false;
      const tamperingFileSystem = new Proxy(fileSystem, {
        get(target, property) {
          if (property === "readFile")
            return (filePath: string) =>
              Effect.gen(function* () {
                const absolutePath = path.resolve(filePath);
                const inCandidateTree = absolutePath.includes(
                  `${path.sep}.tiara-workflow-api-candidates${path.sep}`,
                );
                if (
                  stagedPolicySubstitutionCount === 0 &&
                  inCandidateTree &&
                  path.basename(absolutePath) === "preview-workflow-api-runtime-attestations.json"
                ) {
                  stagedCandidatePolicyObserved = yield* fileSystem.exists(absolutePath);
                  expect(stagedCandidatePolicyObserved).toBe(true);
                  expect(absolutePath).not.toBe(sourcePolicyPath);
                  expect(yield* fileSystem.readFileString(absolutePath)).toBe(sourcePolicyBefore);
                  yield* fileSystem.chmod(absolutePath, 0o644);
                  yield* fileSystem.writeFileString(
                    absolutePath,
                    `${JSON.stringify({
                      schemaVersion: 1,
                      packages: fixture.trustedRuntimeArtifactAttestations.packages,
                    })}\n`,
                  );
                  yield* fileSystem.chmod(absolutePath, 0o444);
                  stagedPolicySubstitutionCount += 1;
                }
                return yield* fileSystem.readFile(absolutePath);
              });
          return Reflect.get(target, property, target);
        },
      });
      const adapters = yield* makeCatalogAdmissionAdapters(
        runtimeGroup,
        counters,
        resolvedCatalogDigest,
        fixture.trustedRuntimeArtifactAttestations,
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(FileSystem.FileSystem, tamperingFileSystem),
            NodeHttpClient.layerNodeHttp,
          ),
        ),
      );

      const stagedPolicyAdmission = yield* Effect.exit(
        adapters.startProcess({
          checkout: fixture.checkout,
          session: created.session,
          revision: sourceSnapshot.revision,
          config: runtimeConfig,
          group: runtimeGroup,
        }),
      );
      expect(Exit.isFailure(stagedPolicyAdmission)).toBe(true);
      if (Exit.isFailure(stagedPolicyAdmission)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(stagedPolicyAdmission.cause));
        expect(error).toMatchObject({
          reason: "workflow-source-unavailable",
          sourceStage: "dependency-artifact-source-policy-untrusted",
        });
      }
      expect(stagedPolicySubstitutionCount).toBe(1);
      expect(stagedCandidatePolicyObserved).toBe(true);
      expect(yield* fileSystem.readFileString(sourcePolicyPath)).toBe(sourcePolicyBefore);
      expect(JSON.stringify(fixture.trustedRuntimeArtifactAttestations)).toBe(trustedAnchorBefore);
      expect(counters).toEqual({
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });
      expect(yield* fileSystem.readDirectory(candidateParent)).toEqual([]);
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
  ),
);

it.live("rejects checkout changes between source preflight and candidate verification", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
      const sourceSnapshot = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
      const sourceSchemaArtifactDigest: typeof schemaDigest = `sha256:${sourceSnapshot.schemaArtifactDigest.slice("sha256:".length)}`;
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: fixture.checkout,
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: sourceSnapshot.revision,
        groups: ["workflow-execution"],
        endpoints: [endpoint],
        targets: [workflowTarget],
      });
      const runtimeGroup = {
        ...group,
        sessionId: created.session.id,
        generation: created.session.generation,
        schemaArtifactDigest: sourceSchemaArtifactDigest,
      };
      const runtimeConfig: ConnectedPreviewConfig = {
        ...config,
        identities: {
          ...config.identities,
          sourceRevision: sourceSnapshot.revision,
          schemaArtifactDigest: sourceSchemaArtifactDigest,
        },
        groups: config.groups.map((candidate) =>
          candidate.id === "workflow-execution"
            ? { ...candidate, schemaArtifactDigest: sourceSchemaArtifactDigest }
            : candidate,
        ),
      };
      const counters = {
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      };
      const resolvedCatalogDigest = { value: runtimeGroup.workflowContractCatalogDigest };
      const sourcePath = fixture.authSource;
      const originalSource = yield* fileSystem.readFileString(sourcePath);
      const changedSource = "export const policyRevision = 2;\n";
      let sourceReads = 0;
      let interCheckMutationCount = 0;
      const changingFileSystem = new Proxy(fileSystem, {
        get(target, property) {
          if (property === "readFile")
            return (filePath: string) =>
              Effect.gen(function* () {
                const absolutePath = path.resolve(filePath);
                if (absolutePath === sourcePath) {
                  sourceReads += 1;
                  if (sourceReads === 2) {
                    yield* fileSystem.writeFileString(sourcePath, changedSource);
                    interCheckMutationCount += 1;
                  }
                }
                return yield* fileSystem.readFile(absolutePath);
              });
          return Reflect.get(target, property, target);
        },
      });
      const adapters = yield* makeCatalogAdmissionAdapters(
        runtimeGroup,
        counters,
        resolvedCatalogDigest,
        fixture.trustedRuntimeArtifactAttestations,
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(FileSystem.FileSystem, changingFileSystem),
            NodeHttpClient.layerNodeHttp,
          ),
        ),
      );

      const changedCandidate = yield* Effect.exit(
        adapters.startProcess({
          checkout: fixture.checkout,
          session: created.session,
          revision: sourceSnapshot.revision,
          config: runtimeConfig,
          group: runtimeGroup,
        }),
      );
      expect(Exit.isFailure(changedCandidate)).toBe(true);
      expect(sourceReads).toBe(2);
      expect(interCheckMutationCount).toBe(1);
      expect(yield* fileSystem.readFileString(sourcePath)).toBe(changedSource);
      expect(originalSource).not.toBe(changedSource);
      expect(counters).toEqual({
        databaseTargetResolves: 0,
        credentialResolves: 0,
        originResolutions: 0,
        processStarts: 0,
        routePublications: 0,
      });
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
  ),
);

it.live(
  "rejects checkout changes after candidate source capture and before target resolution",
  () =>
    withController(({ value }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const fixture = yield* makeWorkflowApiSourceFixture(fileSystem);
        const sourceSnapshot = yield* previewWorkflowApiFixtureSourceSnapshot(fileSystem, fixture);
        const sourceSchemaArtifactDigest: typeof schemaDigest = `sha256:${sourceSnapshot.schemaArtifactDigest.slice("sha256:".length)}`;
        const controller = yield* makePreviewSessionController(() => value);
        const created = yield* controller.create({
          owner: "owner",
          checkout: fixture.checkout,
          manifests: { "sheet-workflows-api": apiDigest },
          requestedRevision: sourceSnapshot.revision,
          groups: ["workflow-execution"],
          endpoints: [endpoint],
          targets: [workflowTarget],
        });
        const runtimeGroup = {
          ...group,
          sessionId: created.session.id,
          generation: created.session.generation,
          schemaArtifactDigest: sourceSchemaArtifactDigest,
        };
        const runtimeConfig: ConnectedPreviewConfig = {
          ...config,
          identities: {
            ...config.identities,
            sourceRevision: sourceSnapshot.revision,
            schemaArtifactDigest: sourceSchemaArtifactDigest,
          },
          groups: config.groups.map((candidate) =>
            candidate.id === "workflow-execution"
              ? { ...candidate, schemaArtifactDigest: sourceSchemaArtifactDigest }
              : candidate,
          ),
        };
        const counters = {
          databaseTargetResolves: 0,
          credentialResolves: 0,
          originResolutions: 0,
          processStarts: 0,
          routePublications: 0,
        };
        const resolvedCatalogDigest = { value: runtimeGroup.workflowContractCatalogDigest };
        const sourcePath = fixture.authSource;
        const originalSource = yield* fileSystem.readFileString(sourcePath);
        const changedSource = "export const policyRevision = 3;\n";
        const candidateParent = path.join(
          path.dirname(fixture.checkout),
          ".tiara-workflow-api-candidates",
          path.basename(fixture.checkout),
        );
        let candidateTreeWrites = 0;
        let interStageMutationCount = 0;
        const mutatingFileSystem = new Proxy(fileSystem, {
          get(target, property) {
            if (property === "writeFile")
              return (...args: Parameters<FileSystem.FileSystem["writeFile"]>) =>
                Effect.gen(function* () {
                  const targetPath = path.resolve(args[0]);
                  if (targetPath.startsWith(`${candidateParent}${path.sep}`)) {
                    candidateTreeWrites += 1;
                    if (interStageMutationCount === 0) {
                      yield* fileSystem.writeFileString(sourcePath, changedSource);
                      interStageMutationCount += 1;
                    }
                  }
                  return yield* fileSystem.writeFile(...args);
                });
            return Reflect.get(target, property, target);
          },
        });
        const adapters = yield* makeCatalogAdmissionAdapters(
          runtimeGroup,
          counters,
          resolvedCatalogDigest,
          fixture.trustedRuntimeArtifactAttestations,
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(FileSystem.FileSystem, mutatingFileSystem),
              NodeHttpClient.layerNodeHttp,
            ),
          ),
        );

        const changedCandidate = yield* Effect.exit(
          adapters.startProcess({
            checkout: fixture.checkout,
            session: created.session,
            revision: sourceSnapshot.revision,
            config: runtimeConfig,
            group: runtimeGroup,
          }),
        );
        expect(Exit.isFailure(changedCandidate)).toBe(true);
        if (Exit.isFailure(changedCandidate)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(changedCandidate.cause));
          expect(error).toMatchObject({
            reason: "revision-failed",
            sourceStage: "candidate-source-revalidation",
          });
        }
        expect(candidateTreeWrites).toBeGreaterThan(0);
        expect(interStageMutationCount).toBe(1);
        expect(yield* fileSystem.readFileString(sourcePath)).toBe(changedSource);
        expect(originalSource).not.toBe(changedSource);
        expect(counters).toEqual({
          databaseTargetResolves: 0,
          credentialResolves: 0,
          originResolutions: 0,
          processStarts: 0,
          routePublications: 0,
        });
        expect(yield* fileSystem.readDirectory(candidateParent)).toEqual([]);
      }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
    ),
);

it.live("resolves watched producer dependencies from their development source exports", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dependencies: ReadonlyArray<readonly [string, string, string]> = [
      ["effect-zero-workflow", ".", "./src/index.ts"],
      ["effect-zero", ".", "./src/index.ts"],
      ["effect-sql-kit", ".", "./src/index.ts"],
      ["effect-sql-schema", ".", "./src/index.mts"],
      ["sheet-auth", "./identity/server", "./src/identity-server.ts"],
      ["sheet-bot-api", ".", "./src/index.ts"],
      ["sheet-db-schema", "./migrations", "./src/migrations.ts"],
      ["sheet-domain", ".", "./src/index.ts"],
      ["sheet-message-content", "./rendering", "./src/rendering.ts"],
      ["sheet-workflow-contracts", ".", "./src/index.ts"],
      ["sheet-zero-api", "./schema", "./src/schema.ts"],
      ["sheet-zero-server", "./workflows", "./src/workflows.ts"],
      ["typhoon-core", "./*", "./src/*/index.ts"],
      ["typhoon-zero", "./schema", "./src/schema/index.ts"],
    ];
    for (const [packageName, subpath, sourceTarget] of dependencies) {
      const packagePath = path.join(repositoryRoot, "packages", packageName, "package.json");
      const packageJsonInput: unknown = JSON.parse(yield* fileSystem.readFileString(packagePath));
      const packageJson = Schema.decodeUnknownSync(
        Schema.Struct({ exports: Schema.Record(Schema.String, Schema.Unknown) }),
      )(packageJsonInput);
      const exportEntry = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
        packageJson.exports[subpath],
      );
      expect(exportEntry.development, `${packageName} ${subpath}`).toBe(sourceTarget);
    }

    const includedPackages = new Set(
      previewWorkflowApiSourceRoots
        .filter((sourceRoot) => sourceRoot.startsWith("packages/"))
        .map((sourceRoot) => sourceRoot.split("/")[1]!),
    );
    const pending = ["sheet-workflows"];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const packageName = pending.pop()!;
      if (visited.has(packageName)) continue;
      visited.add(packageName);
      expect(includedPackages.has(packageName), `${packageName} source root`).toBe(true);
      const packageManifest: unknown = JSON.parse(
        yield* fileSystem.readFileString(
          path.join(repositoryRoot, "packages", packageName, "package.json"),
        ),
      );
      const dependencies =
        Schema.decodeUnknownSync(
          Schema.Struct({
            dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
          }),
        )(packageManifest).dependencies ?? {};
      for (const [dependency, version] of Object.entries(dependencies))
        if (version === "workspace:*") pending.push(dependency);
    }
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.live("executes the watched workflow-store source through the producer development export", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fixture = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "workflow-api-loaded-dependency-",
    });
    const packageRoot = path.join(fixture, "node_modules/effect-zero-workflow");
    const sourceDirectory = path.join(packageRoot, "src");
    const distDirectory = path.join(packageRoot, "dist");
    yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
    yield* fileSystem.makeDirectory(packageRoot, { recursive: true });
    yield* fileSystem.makeDirectory(distDirectory, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(packageRoot, "package.json"),
      yield* fileSystem.readFileString(
        path.join(repositoryRoot, "packages/effect-zero-workflow/package.json"),
      ),
    );
    yield* fileSystem.writeFileString(
      path.join(sourceDirectory, "index.ts"),
      'export { workflowTableNames } from "./store.ts";\n',
    );
    for (const sourceFile of ["store.ts", "models.ts"])
      yield* fileSystem.symlink(
        path.join(repositoryRoot, "packages/effect-zero-workflow/src", sourceFile),
        path.join(sourceDirectory, sourceFile),
      );
    yield* fileSystem.writeFileString(
      path.join(distDirectory, "index.mjs"),
      'export const workflowTableNames = () => ({ command: "stale-dist", run: "stale-dist" });\n',
    );
    const entry = path.join(fixture, "entry.mjs");
    yield* fileSystem.writeFileString(
      entry,
      'import { workflowTableNames } from "effect-zero-workflow";\nconsole.log(JSON.stringify(workflowTableNames("preview")));\n',
    );
    const loader = path.join(repositoryRoot, "node_modules/tsx/dist/loader.mjs");
    const processHandle = yield* Effect.tryPromise({
      try: () =>
        startLongLivedProcess({
          command: process.execPath,
          args: ["--import", loader, entry],
          cwd: fixture,
          env: { NODE_OPTIONS: "--conditions=development" },
          environmentInheritance: "web-preview",
          timeoutMs: 10_000,
          kind: "dependency-check",
          readOnly: true,
          output: "capture",
        }),
      catch: (cause) => cause,
    });
    const result = yield* Effect.tryPromise({
      try: () => processHandle.exited,
      catch: (cause) => cause,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toEqual({
      command: "preview_workflow_command",
      run: "preview_workflow_run",
    });
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.live("loads host migration identity through the root development entry condition", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rootPackageInput: unknown = JSON.parse(
      yield* fileSystem.readFileString(path.join(repositoryRoot, "package.json")),
    );
    const rootScripts = Schema.decodeUnknownSync(
      Schema.Struct({ scripts: Schema.Struct({ dev: Schema.String }) }),
    )(rootPackageInput).scripts;
    expect(rootScripts.dev).toContain("--conditions=development");
    expect(rootScripts.dev).toContain("--import tsx");

    const fixture = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "workflow-api-host-development-exports-",
    });
    const packageRoot = path.join(fixture, "node_modules/sheet-db-schema");
    const sourceDirectory = path.join(packageRoot, "src");
    const distDirectory = path.join(packageRoot, "dist");
    yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
    yield* fileSystem.makeDirectory(distDirectory, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "sheet-db-schema",
        type: "module",
        exports: {
          "./migrations": {
            development: "./src/migrations.mjs",
            default: "./dist/migrations.mjs",
          },
          "./migration-artifact-identity": {
            development: "./src/migration-artifact-identity.mjs",
            default: "./dist/migrations.mjs",
          },
        },
      }),
    );
    yield* fileSystem.writeFileString(
      path.join(sourceDirectory, "migrations.mjs"),
      'export const migrationRuntime = "current-source";\n',
    );
    yield* fileSystem.writeFileString(
      path.join(sourceDirectory, "migration-artifact-identity.mjs"),
      'export const identityRuntime = "current-source";\n',
    );
    yield* fileSystem.writeFileString(
      path.join(distDirectory, "migrations.mjs"),
      'export const migrationRuntime = "stale-dist";\nexport const identityRuntime = "stale-dist";\n',
    );
    const entry = path.join(fixture, "entry.mjs");
    yield* fileSystem.writeFileString(
      entry,
      'import { migrationRuntime } from "sheet-db-schema/migrations";\n' +
        'import { identityRuntime } from "sheet-db-schema/migration-artifact-identity";\n' +
        "console.log(`${migrationRuntime}:${identityRuntime}`);\n",
    );
    const loader = path.join(repositoryRoot, "node_modules/tsx/dist/loader.mjs");
    const processHandle = yield* Effect.tryPromise({
      try: () =>
        startLongLivedProcess({
          command: process.execPath,
          args: ["--conditions=development", "--import", loader, entry],
          cwd: fixture,
          env: { NODE_OPTIONS: "" },
          environmentInheritance: "web-preview",
          timeoutMs: 10_000,
          kind: "dependency-check",
          readOnly: true,
          output: "capture",
        }),
      catch: (cause) => cause,
    });
    const result = yield* Effect.tryPromise({
      try: () => processHandle.exited,
      catch: (cause) => cause,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout?.trim()).toBe("current-source:current-source");
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.live(
  "loads the current workflow catalog identity through its package-name development export",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const actualManifest: unknown = JSON.parse(
        yield* fileSystem.readFileString(
          path.join(repositoryRoot, "packages/sheet-workflows/package.json"),
        ),
      );
      const packageManifest = Schema.decodeUnknownSync(
        Schema.Struct({
          exports: Schema.Struct({
            "./catalog-identity": Schema.Struct({
              types: Schema.String,
              development: Schema.String,
              default: Schema.String,
            }),
          }),
        }),
      )(actualManifest);
      const catalogExport = packageManifest.exports["./catalog-identity"];
      expect(catalogExport.development).toBe("./src/catalogIdentity.ts");

      const fixture = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "workflow-catalog-development-export-",
      });
      const packageRoot = path.join(fixture, "node_modules/sheet-workflows");
      const sourceDirectory = path.join(packageRoot, "src");
      const distDirectory = path.join(packageRoot, "dist");
      yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(distDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ type: "module", exports: { "./catalog-identity": catalogExport } }),
      );
      yield* fileSystem.writeFileString(
        path.join(sourceDirectory, "catalogIdentity.ts"),
        'export const digest = "source-v1";\n',
      );
      yield* fileSystem.writeFileString(
        path.join(distDirectory, "catalog-identity.mjs"),
        'export const digest = "stale-dist";\n',
      );
      const entry = path.join(fixture, "entry.mjs");
      yield* fileSystem.writeFileString(
        entry,
        'import { digest } from "sheet-workflows/catalog-identity";\nconsole.log(digest);\n',
      );
      const loader = path.join(repositoryRoot, "node_modules/tsx/dist/loader.mjs");
      const observe = (expected: string) =>
        Effect.gen(function* () {
          const processHandle = yield* Effect.tryPromise({
            try: () =>
              startLongLivedProcess({
                command: process.execPath,
                args: ["--conditions=development", "--import", loader, entry],
                cwd: fixture,
                env: { NODE_OPTIONS: "" },
                environmentInheritance: "web-preview",
                timeoutMs: 10_000,
                kind: "dependency-check",
                readOnly: true,
                output: "capture",
              }),
            catch: (cause) => cause,
          });
          const result = yield* Effect.tryPromise({
            try: () => processHandle.exited,
            catch: (cause) => cause,
          });
          expect(result.exitCode, result.stderr).toBe(0);
          expect(result.stdout?.trim()).toBe(expected);
        });

      yield* observe("source-v1");
      yield* fileSystem.writeFileString(
        path.join(sourceDirectory, "catalogIdentity.ts"),
        'export const digest = "source-v2";\n',
      );
      yield* fileSystem.remove(distDirectory, { recursive: true });
      yield* observe("source-v2");

      const actualEntryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        directory: path.dirname(fileURLToPath(import.meta.url)),
        prefix: "workflow-catalog-actual-package-import-",
      });
      const actualEntry = path.join(actualEntryDirectory, "entry.mjs");
      yield* fileSystem.writeFileString(
        actualEntry,
        'import { sheetWorkflowContractCatalogDigest } from "sheet-workflows/catalog-identity";\n' +
          "console.log(sheetWorkflowContractCatalogDigest);\n",
      );
      const actualProcess = yield* Effect.tryPromise({
        try: () =>
          startLongLivedProcess({
            command: process.execPath,
            args: ["--conditions=development", "--import", loader, actualEntry],
            cwd: path.join(repositoryRoot, "packages/developer-launcher"),
            env: { NODE_OPTIONS: "" },
            environmentInheritance: "web-preview",
            timeoutMs: 30_000,
            kind: "dependency-check",
            readOnly: true,
            output: "capture",
          }),
        catch: (cause) => cause,
      });
      const actualResult = yield* Effect.tryPromise({
        try: () => actualProcess.exited,
        catch: (cause) => cause,
      });
      expect(actualResult.exitCode, actualResult.stderr).toBe(0);
      expect(actualResult.stdout?.trim()).toBe(sheetWorkflowContractCatalogDigest);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  60_000,
);

it("requires the loaded migration registration paths to exactly match the manifest", () => {
  const registrations = sheetDbMigrationArtifacts.map(([id, , , relativePath]) => ({
    id,
    relativePath,
  }));
  const manifestPaths = sheetDbMigrationArtifactSources.map(([relativePath]) => relativePath);

  expect(previewWorkflowApiRegisteredMigrationsMatch(manifestPaths, registrations)).toBe(true);
  expect(
    previewWorkflowApiRegisteredMigrationsMatch(manifestPaths, registrations.slice(0, -1)),
  ).toBe(false);
  expect(
    previewWorkflowApiRegisteredMigrationsMatch(manifestPaths, [
      ...registrations,
      {
        id: registrations.length + 1,
        relativePath: `packages/sheet-db-schema/effect-sql-migrations/${String(
          registrations.length + 1,
        ).padStart(4, "0")}_unlisted.ts`,
      },
    ]),
  ).toBe(false);
  expect(
    previewWorkflowApiRegisteredMigrationsMatch(manifestPaths, [
      { ...registrations[0]!, id: registrations[0]!.id + 1 },
      ...registrations.slice(1),
    ]),
  ).toBe(false);
  expect(
    previewWorkflowApiRegisteredMigrationsMatch(manifestPaths, [
      {
        ...registrations[0]!,
        relativePath: registrations[0]!.relativePath.replace("_", "_other_"),
      },
      ...registrations.slice(1),
    ]),
  ).toBe(false);
});

it("frames file paths and contents separately in the source revision", () => {
  const firstTree = previewWorkflowApiSourceRevisionFromFiles([
    { relativePath: "a.ts", contents: new TextEncoder().encode("b.ts-payload") },
  ]);
  const secondTree = previewWorkflowApiSourceRevisionFromFiles([
    { relativePath: "a.tsb.ts", contents: new TextEncoder().encode("-payload") },
  ]);
  const firstDependencyIdentity = previewWorkflowApiSourceRevisionFromFiles(
    [{ relativePath: "a.ts", contents: new TextEncoder().encode("b.ts-payload") }],
    digest("a"),
  );
  const changedDependencyIdentity = previewWorkflowApiSourceRevisionFromFiles(
    [{ relativePath: "a.ts", contents: new TextEncoder().encode("b.ts-payload") }],
    digest("b"),
  );

  expect(firstTree).not.toBe(secondTree);
  expect(firstDependencyIdentity).not.toBe(firstTree);
  expect(firstDependencyIdentity).not.toBe(changedDependencyIdentity);
});

it.live("stale supervisor cleanup cannot stop a newer resumed generation", () =>
  withController(({ value }) =>
    Effect.gen(function* () {
      const controller = yield* makePreviewSessionController(() => value);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-workflows-api": apiDigest },
        requestedRevision: "revision-a",
      });
      yield* controller.activate(
        created.session.id,
        created.session.generation,
        created.supervisorIdentity,
        "revision-a",
      );

      value += previewSupervisorLeaseMs;
      const resumed = yield* controller.resume(created.session.id, created.ownerIdentity);
      yield* stopFailedPreviewWorkflowApiSupervisorSession(
        controller,
        created.session.id,
        created.supervisorIdentity,
        created.session.generation,
      );

      const afterStaleCleanup = yield* controller.status(created.session.id);
      expect(afterStaleCleanup.generation).toBe(resumed.session.generation);
      expect(afterStaleCleanup.phase).toBe("pending");
    }),
  ),
);
