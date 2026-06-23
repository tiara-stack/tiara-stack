import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "@effect/vitest";
import { sqliteLayer, withSqlite } from "../db/client";
import {
  ensureDependencyGraphVersion,
  getSymbolDependencies,
  getSymbolDependents,
  lookupDependencyGraphSymbol,
} from "./store";
import { DependencyGraphFailed, DependencyGraphVersionNotFound } from "./types";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trimEnd();

const makeRepo = () => {
  const repo = mkdtempSync(join(tmpdir(), "tiara-review-graph."));
  git(repo, ["init"]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(
    join(repo, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", strict: true } }),
  );
  writeFileSync(
    join(repo, "source.ts"),
    `export interface User {
  id: string;
}

export class UserService {
  getUser(): User {
    return { id: "1" };
  }
}

export function makeUserService() {
  return new UserService();
}
`,
  );
  writeFileSync(
    join(repo, "consumer.ts"),
    `import { makeUserService, UserService, type User } from "./source";

export function loadUser(service: UserService): User {
  return service.getUser();
}

export function loadUserWithLocal(service: UserService): User {
  const user = service.getUser();
  return user;
}

export const loadUserArrow = (service: UserService): User => service.getUser();

export const defaultService = makeUserService();
`,
  );
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
};

const buildGraph = (input: {
  readonly repo: string;
  readonly dbPath: string;
  readonly branch?: string | null;
  readonly checkpointCommit: string;
  readonly checkpointRef?: string;
}) =>
  ensureDependencyGraphVersion({
    repoRoot: input.repo,
    branch: input.branch ?? "master",
    checkpointRef: input.checkpointRef ?? input.checkpointCommit,
    checkpointCommit: input.checkpointCommit,
    diffHash: input.checkpointCommit,
    dbPath: input.dbPath,
  });

describe("dependency graph store", () => {
  it.live("builds a versioned semantic graph and answers symbol dependency queries", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const dbDir = mkdtempSync(join(tmpdir(), "tiara-review-graph-db."));
      const dbPath = join(dbDir, "reviews.sqlite");
      try {
        const commit = git(repo, ["rev-parse", "HEAD"]);
        const version = yield* buildGraph({ repo, dbPath, checkpointCommit: commit });
        const lookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: version.id,
          name: "loadUser",
        });
        expect(lookup.symbols).toHaveLength(1);

        const dependencies = yield* getSymbolDependencies({
          dbPath,
          versionId: version.id,
          symbolKey: lookup.symbols[0]!.symbolKey,
        });
        expect(dependencies.edges.map((edge) => edge.target.name)).toContain("UserService");
        expect(dependencies.edges.map((edge) => edge.target.name)).toContain("User");
        const arrowLookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: version.id,
          name: "loadUserArrow",
        });
        expect(arrowLookup.symbols).toHaveLength(1);
        const arrowDependencies = yield* getSymbolDependencies({
          dbPath,
          versionId: version.id,
          symbolKey: arrowLookup.symbols[0]!.symbolKey,
        });
        expect(arrowDependencies.edges.map((edge) => edge.target.name)).toContain("UserService");
        expect(arrowDependencies.edges.map((edge) => edge.target.name)).toContain("User");
        const localLookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: version.id,
          name: "loadUserWithLocal",
        });
        const localCallDependencies = yield* getSymbolDependencies({
          dbPath,
          versionId: version.id,
          symbolKey: localLookup.symbols[0]!.symbolKey,
          edgeKinds: ["call"],
        });
        expect(localCallDependencies.edges.map((edge) => edge.target.name)).toContain("getUser");
        const defaultServiceLookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: version.id,
          name: "defaultService",
        });
        const defaultServiceDependencies = yield* getSymbolDependencies({
          dbPath,
          versionId: version.id,
          symbolKey: defaultServiceLookup.symbols[0]!.symbolKey,
          edgeKinds: ["call"],
        });
        expect(defaultServiceDependencies.edges.map((edge) => edge.target.name)).toContain(
          "makeUserService",
        );
        const escapedLookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: version.id,
          name: "User_ervice",
        });
        expect(escapedLookup.symbols).toHaveLength(0);
        const userLookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: version.id,
          name: "User",
        });
        expect(userLookup.symbols.map((symbol) => symbol.name)).toContain("User");
        expect(userLookup.symbols.map((symbol) => symbol.name)).not.toContain("loadUser");
        expect(userLookup.symbols.map((symbol) => symbol.name)).not.toContain("getUser");
        expect(userLookup.symbols.map((symbol) => symbol.name)).not.toContain("makeUserService");
        expect(userLookup.symbols.every((symbol) => symbol.name === "User")).toBe(true);
        const qualifiedLookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: version.id,
          name: "UserService.getUser",
        });
        expect(qualifiedLookup.symbols.map((symbol) => symbol.name)).toContain("getUser");
        const exit3218 = yield* Effect.exit(
          lookupDependencyGraphSymbol({
            dbPath,
            versionId: version.id,
            name: "User",
            column: 5,
          }),
        );
        expect(exit3218._tag).toBe("Failure");
        if (exit3218._tag === "Failure") {
          expect(String(exit3218.cause)).toContain(DependencyGraphFailed.name);
        }

        const service = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: version.id,
          name: "UserService",
        });
        const serviceSymbol =
          service.symbols.find((symbol) => symbol.path === "source.ts") ?? service.symbols[0]!;
        const dependents = yield* getSymbolDependents({
          dbPath,
          versionId: version.id,
          symbolKey: serviceSymbol.symbolKey,
        });
        expect(dependents.edges.map((edge) => edge.source.name)).toContain("loadUser");
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(dbDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("stores incremental graph versions as deltas", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const dbDir = mkdtempSync(join(tmpdir(), "tiara-review-graph-db."));
      const dbPath = join(dbDir, "reviews.sqlite");
      try {
        const firstCommit = git(repo, ["rev-parse", "HEAD"]);
        const firstVersion = yield* buildGraph({ repo, dbPath, checkpointCommit: firstCommit });
        writeFileSync(
          join(repo, "consumer.ts"),
          `import { UserService, type User } from "./source";

export function loadUser(service: UserService): User {
  const user = service.getUser();
  return user;
}
`,
        );
        git(repo, ["add", "consumer.ts"]);
        git(repo, ["commit", "-m", "update consumer"]);
        const secondCommit = git(repo, ["rev-parse", "HEAD"]);
        const secondVersion = yield* buildGraph({ repo, dbPath, checkpointCommit: secondCommit });
        expect(secondVersion.mode).toBe("incremental");
        expect(secondVersion.baseVersionId).toBe(firstVersion.id);
        const lookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: secondVersion.id,
          name: "loadUser",
        });
        expect(lookup.symbols[0]?.endLine).toBe(6);
        const firstLookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: firstVersion.id,
          name: "loadUser",
        });
        expect(firstLookup.symbols[0]?.endLine).toBe(5);

        const counts = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql.unsafe<{ readonly symbols: number; readonly edges: number }>(
            `select
               (select count(*) from dependency_graph_symbol_deltas where version_id = ?) as symbols,
               (select count(*) from dependency_graph_edge_deltas where version_id = ?) as edges`,
            [secondVersion.id, secondVersion.id],
          );
          return rows[0]!;
        }).pipe(Effect.provide(sqliteLayer(dbPath)));
        expect(counts.symbols).toBeGreaterThan(0);
        expect(counts.edges).toBeGreaterThan(0);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(dbDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("keeps unchanged symbol keys stable when another symbol in the file changes", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const dbDir = mkdtempSync(join(tmpdir(), "tiara-review-graph-db."));
      const dbPath = join(dbDir, "reviews.sqlite");
      try {
        const firstCommit = git(repo, ["rev-parse", "HEAD"]);
        const firstVersion = yield* buildGraph({ repo, dbPath, checkpointCommit: firstCommit });
        const firstUnchangedLookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: firstVersion.id,
          name: "loadUserWithLocal",
        });
        const firstChangedLookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: firstVersion.id,
          name: "loadUserArrow",
        });

        writeFileSync(
          join(repo, "consumer.ts"),
          `import { makeUserService, UserService, type User } from "./source";

export function loadUser(service: UserService): User {
  return service.getUser();
}

export function loadUserWithLocal(service: UserService): User {
  const user = service.getUser();
  return user;
}

export const loadUserArrow = (service: UserService): User => {
  return service.getUser();
};

export const defaultService = makeUserService();
`,
        );
        git(repo, ["add", "consumer.ts"]);
        git(repo, ["commit", "-m", "update one consumer symbol"]);

        const secondCommit = git(repo, ["rev-parse", "HEAD"]);
        const secondVersion = yield* buildGraph({ repo, dbPath, checkpointCommit: secondCommit });
        const secondUnchangedLookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: secondVersion.id,
          name: "loadUserWithLocal",
        });
        const secondChangedLookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: secondVersion.id,
          name: "loadUserArrow",
        });

        expect(secondUnchangedLookup.symbols[0]?.symbolKey).toBe(
          firstUnchangedLookup.symbols[0]?.symbolKey,
        );
        expect(secondChangedLookup.symbols[0]?.symbolKey).not.toBe(
          firstChangedLookup.symbols[0]?.symbolKey,
        );
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(dbDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("keeps cross-file dependents when only the callee file changes incrementally", () =>
    Effect.gen(function* () {
      const repo = mkdtempSync(join(tmpdir(), "tiara-review-graph."));
      const dbDir = mkdtempSync(join(tmpdir(), "tiara-review-graph-db."));
      const dbPath = join(dbDir, "reviews.sqlite");
      try {
        git(repo, ["init"]);
        git(repo, ["config", "user.name", "Test User"]);
        git(repo, ["config", "user.email", "test@example.com"]);
        git(repo, ["config", "commit.gpgsign", "false"]);
        writeFileSync(
          join(repo, "tsconfig.json"),
          JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", strict: true } }),
        );
        writeFileSync(
          join(repo, "globals.ts"),
          `function sharedValue() {
  return "one";
}
`,
        );
        writeFileSync(
          join(repo, "caller.ts"),
          `function useSharedValue() {
  return sharedValue();
}
`,
        );
        git(repo, ["add", "."]);
        git(repo, ["commit", "-m", "initial"]);
        const firstCommit = git(repo, ["rev-parse", "HEAD"]);
        const firstVersion = yield* buildGraph({ repo, dbPath, checkpointCommit: firstCommit });

        writeFileSync(
          join(repo, "globals.ts"),
          `function sharedValue() {
  const value = "two";
  return value;
}
`,
        );
        git(repo, ["add", "globals.ts"]);
        git(repo, ["commit", "-m", "update callee"]);
        const secondCommit = git(repo, ["rev-parse", "HEAD"]);
        const secondVersion = yield* buildGraph({ repo, dbPath, checkpointCommit: secondCommit });
        expect(secondVersion.mode).toBe("incremental");
        expect(secondVersion.baseVersionId).toBe(firstVersion.id);

        const lookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: secondVersion.id,
          name: "sharedValue",
        });
        const sharedValue = lookup.symbols.find((symbol) => symbol.path === "globals.ts");
        expect(sharedValue).toBeDefined();
        const dependents = yield* getSymbolDependents({
          dbPath,
          versionId: secondVersion.id,
          symbolKey: sharedValue!.symbolKey,
          edgeKinds: ["call"],
        });
        expect(dependents.edges.map((edge) => edge.source.name)).toContain("useSharedValue");
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(dbDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("keeps re-exported dependents when only the original export changes incrementally", () =>
    Effect.gen(function* () {
      const repo = mkdtempSync(join(tmpdir(), "tiara-review-graph."));
      const dbDir = mkdtempSync(join(tmpdir(), "tiara-review-graph-db."));
      const dbPath = join(dbDir, "reviews.sqlite");
      try {
        git(repo, ["init"]);
        git(repo, ["config", "user.name", "Test User"]);
        git(repo, ["config", "user.email", "test@example.com"]);
        git(repo, ["config", "commit.gpgsign", "false"]);
        writeFileSync(
          join(repo, "tsconfig.json"),
          JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", strict: true } }),
        );
        writeFileSync(
          join(repo, "c.ts"),
          `export function foo() {
  return 1;
}
`,
        );
        writeFileSync(join(repo, "b.ts"), `export { foo } from "./c";\n`);
        writeFileSync(
          join(repo, "a.ts"),
          `import { foo } from "./b";

export const useFoo = () => foo();
`,
        );
        git(repo, ["add", "."]);
        git(repo, ["commit", "-m", "initial"]);
        const firstCommit = git(repo, ["rev-parse", "HEAD"]);
        const firstVersion = yield* buildGraph({ repo, dbPath, checkpointCommit: firstCommit });

        writeFileSync(
          join(repo, "c.ts"),
          `export function foo() {
  return 2;
}
`,
        );
        git(repo, ["add", "c.ts"]);
        git(repo, ["commit", "-m", "update original export"]);
        const secondCommit = git(repo, ["rev-parse", "HEAD"]);
        const secondVersion = yield* buildGraph({ repo, dbPath, checkpointCommit: secondCommit });
        expect(secondVersion.mode).toBe("incremental");
        expect(secondVersion.baseVersionId).toBe(firstVersion.id);

        const lookup = yield* lookupDependencyGraphSymbol({
          dbPath,
          versionId: secondVersion.id,
          name: "foo",
        });
        const foo = lookup.symbols.find((symbol) => symbol.path === "c.ts");
        expect(foo).toBeDefined();
        const dependents = yield* getSymbolDependents({
          dbPath,
          versionId: secondVersion.id,
          symbolKey: foo!.symbolKey,
          edgeKinds: ["call"],
        });
        expect(dependents.edges.map((edge) => edge.source.name)).toContain("useFoo");
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(dbDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("prunes orphaned file rows after an incremental content-hash change", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const dbDir = mkdtempSync(join(tmpdir(), "tiara-review-graph-db."));
      const dbPath = join(dbDir, "reviews.sqlite");
      try {
        const firstCommit = git(repo, ["rev-parse", "HEAD"]);
        yield* buildGraph({ repo, dbPath, checkpointCommit: firstCommit });

        writeFileSync(
          join(repo, "source.ts"),
          `export interface User {
  id: string;
}

export class UserService {
  getUser(): User {
    return { id: "1" };
  }
}

export function makeUserService() {
  return new UserService();
}

// content hash changes without changing declaration spans
`,
        );
        git(repo, ["add", "source.ts"]);
        git(repo, ["commit", "-m", "update source comment"]);
        const secondCommit = git(repo, ["rev-parse", "HEAD"]);
        yield* buildGraph({ repo, dbPath, checkpointCommit: secondCommit });

        const rows = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.unsafe<{ readonly source_files: number }>(
            `select count(*) as source_files
             from dependency_graph_files
             where path = 'source.ts'`,
          );
        }).pipe(Effect.provide(sqliteLayer(dbPath)));
        expect(rows[0]?.source_files).toBe(1);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(dbDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("fails when a version chain points at a missing ancestor", () =>
    Effect.gen(function* () {
      const dbDir = mkdtempSync(join(tmpdir(), "tiara-review-graph-db."));
      const dbPath = join(dbDir, "reviews.sqlite");
      try {
        yield* withSqlite(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe(`PRAGMA foreign_keys = OFF`);
            yield* sql`
            insert into dependency_graph_versions (
              id, repo_root, branch, checkpoint_ref, checkpoint_commit, base_version_id,
              diff_hash, mode, status, created_at, completed_at, error
            ) values (
              'child-version', '/repo', 'main', 'child', 'child', 'missing-base',
              'diff', 'incremental', 'completed', 1, 1, null
            )
          `;
            yield* sql.unsafe(`PRAGMA foreign_keys = ON`);
          }),
        );

        const exit845 = yield* Effect.exit(
          lookupDependencyGraphSymbol({
            dbPath,
            versionId: "child-version",
            name: "anything",
          }),
        );
        expect(exit845._tag).toBe("Failure");
        if (exit845._tag === "Failure") {
          expect(String(exit845.cause)).toContain(DependencyGraphVersionNotFound.name);
        }
      } finally {
        rmSync(dbDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("does not build incrementally from an unrelated same-branch graph version", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const dbDir = mkdtempSync(join(tmpdir(), "tiara-review-graph-db."));
      const dbPath = join(dbDir, "reviews.sqlite");
      try {
        const firstCommit = git(repo, ["rev-parse", "HEAD"]);
        yield* buildGraph({ repo, dbPath, checkpointCommit: firstCommit });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            insert into dependency_graph_versions (
              id, repo_root, branch, checkpoint_ref, checkpoint_commit, base_version_id,
              diff_hash, mode, status, created_at, completed_at, error
            ) values (
              'stale-missing-commit', ${repo}, 'master', 'missing', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
              null, 'missing', 'full', 'completed', 999999999, 999999999, null
            )
          `;
        }).pipe(Effect.provide(sqliteLayer(dbPath)));

        git(repo, ["checkout", "--orphan", "rewritten"]);
        git(repo, ["rm", "-rf", "."]);
        writeFileSync(
          join(repo, "tsconfig.json"),
          JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", strict: true } }),
        );
        writeFileSync(
          join(repo, "source.ts"),
          `export function currentOnly() {
  return "current";
}
`,
        );
        git(repo, ["add", "."]);
        git(repo, ["commit", "-m", "rewrite history"]);
        git(repo, ["branch", "-M", "master"]);
        const rewrittenCommit = git(repo, ["rev-parse", "HEAD"]);

        const rewrittenVersion = yield* buildGraph({
          repo,
          dbPath,
          checkpointCommit: rewrittenCommit,
        });
        expect(rewrittenVersion.mode).toBe("full");
        expect(rewrittenVersion.baseVersionId).toBeNull();
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(dbDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("recovers an expired running graph version claim without waiting", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      const dbDir = mkdtempSync(join(tmpdir(), "tiara-review-graph-db."));
      const dbPath = join(dbDir, "reviews.sqlite");
      try {
        const commit = git(repo, ["rev-parse", "HEAD"]);
        yield* withSqlite(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`
              insert into dependency_graph_versions (
                id, repo_root, branch, checkpoint_ref, checkpoint_commit, base_version_id,
                diff_hash, mode, status, created_at, completed_at, lease_expires_at, error
              ) values (
                'expired-running-version', ${repo}, 'master', ${commit}, ${commit},
                null, 'expired', 'full', 'running', 1, null, 1, null
              )
            `;
          }),
        );

        const version = yield* buildGraph({ repo, dbPath, checkpointCommit: commit });
        expect(version.id).not.toBe("expired-running-version");
        expect(version.status).toBe("completed");

        const rows = yield* withSqlite(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql.unsafe<{ readonly status: string }>(
              `select status from dependency_graph_versions where id = ?`,
              ["expired-running-version"],
            );
          }),
        );
        expect(rows[0]?.status).toBe("failed");
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(dbDir, { recursive: true, force: true });
      }
    }),
  );
});
