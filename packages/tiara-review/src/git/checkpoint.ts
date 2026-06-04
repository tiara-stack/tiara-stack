import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  type Checkpoint,
  type ReviewBase,
  CheckpointFailed,
  GitCommandFailed,
  NotGitRepository,
} from "../review/types";

const checkpointNamespace = "refs/tiara-review-checkpoints";
const emptyTreeCommit = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const checkpointNamespaceForRepoRoot = (repoRoot: string) =>
  `${checkpointNamespace}/${createHash("sha256").update(repoRoot).digest("hex").slice(0, 16)}`;

type GitResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
};

export const runGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: { readonly env?: NodeJS.ProcessEnv },
) =>
  Effect.tryPromise({
    try: () =>
      new Promise<GitResult>((resolve, reject) => {
        const child = spawn("git", args, {
          cwd,
          env: { ...process.env, ...options?.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Array<Buffer> = [];
        const stderr: Array<Buffer> = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", (error) => {
          reject(
            new GitCommandFailed({
              command: ["git", ...args],
              cwd,
              exitCode: null,
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: error.message,
            }),
          );
        });
        child.on("close", (exitCode) => {
          const result = {
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode,
          };
          if (exitCode === 0) {
            resolve(result);
          } else {
            reject(
              new GitCommandFailed({
                command: ["git", ...args],
                cwd,
                exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
              }),
            );
          }
        });
      }),
    catch: (cause) =>
      cause instanceof GitCommandFailed
        ? cause
        : new GitCommandFailed({
            command: ["git", ...args],
            cwd,
            exitCode: null,
            stdout: "",
            stderr: cause instanceof Error ? cause.message : String(cause),
          }),
  });

export const gitText = (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: { readonly env?: NodeJS.ProcessEnv },
) => runGit(cwd, args, options).pipe(Effect.map((result) => result.stdout.trimEnd()));

export const resolveRepoRoot = (cwd: string): Effect.Effect<string, NotGitRepository> =>
  Effect.gen(function* () {
    const inside = yield* gitText(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") {
      return yield* Effect.fail(
        new NotGitRepository({ cwd, message: "Path is not inside a Git working tree" }),
      );
    }
    return yield* gitText(cwd, ["rev-parse", "--show-toplevel"]);
  }).pipe(
    Effect.catch((cause: GitCommandFailed | NotGitRepository) =>
      cause._tag === "NotGitRepository"
        ? Effect.fail(cause)
        : Effect.fail(
            new NotGitRepository({
              cwd,
              message: cause.stderr || "Path is not inside a Git working tree",
            }),
          ),
    ),
  );

export const getHeadCommit = (repoRoot: string) =>
  gitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).pipe(
    Effect.map((value) => (value.length > 0 ? value : null)),
    Effect.catch(() => Effect.succeed(null)),
  );

export const getCurrentBranch = (repoRoot: string) =>
  gitText(repoRoot, ["branch", "--show-current"]).pipe(
    Effect.map((branch) => (branch.length > 0 ? branch : null)),
    Effect.catch(() => Effect.succeed(null)),
  );

export const deleteCheckpointRef = (repoRoot: string, checkpointRef: string) =>
  runGit(repoRoot, ["update-ref", "-d", checkpointRef]).pipe(Effect.asVoid);

export const captureCheckpoint = (repoRoot: string) =>
  Effect.gen(function* () {
    const headCommit = yield* getHeadCommit(repoRoot);
    const createdAt = Date.now();
    const gitCreatedAt = Math.floor(createdAt / 1000);
    const checkpointRef = `${checkpointNamespaceForRepoRoot(repoRoot)}/${gitCreatedAt}-${randomBytes(4).toString("hex")}`;
    const tempDir = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "tiara-review-checkpoint.")),
      catch: (cause) =>
        new CheckpointFailed({ message: "Unable to create temporary Git index directory", cause }),
    });

    const tempIndex = join(tempDir, "index");
    const env = {
      GIT_INDEX_FILE: tempIndex,
      GIT_AUTHOR_NAME: process.env["GIT_AUTHOR_NAME"] ?? "Tiara Code Review",
      GIT_AUTHOR_EMAIL:
        process.env["GIT_AUTHOR_EMAIL"] ?? "tiara-code-review@users.noreply.github.com",
      GIT_COMMITTER_NAME: process.env["GIT_COMMITTER_NAME"] ?? "Tiara Code Review",
      GIT_COMMITTER_EMAIL:
        process.env["GIT_COMMITTER_EMAIL"] ?? "tiara-code-review@users.noreply.github.com",
      GIT_AUTHOR_DATE: `@${gitCreatedAt}`,
      GIT_COMMITTER_DATE: `@${gitCreatedAt}`,
    };

    const effect = Effect.gen(function* () {
      if (headCommit) {
        yield* runGit(repoRoot, ["read-tree", "HEAD"], { env });
      }
      yield* runGit(repoRoot, ["add", "-A", "--", "."], { env });
      const treeOid = yield* gitText(repoRoot, ["write-tree"], { env });
      const commitArgs = headCommit
        ? [
            "commit-tree",
            "--no-gpg-sign",
            treeOid,
            "-p",
            headCommit,
            "-m",
            `tiara review checkpoint ref=${checkpointRef}`,
          ]
        : [
            "commit-tree",
            "--no-gpg-sign",
            treeOid,
            "-m",
            `tiara review checkpoint ref=${checkpointRef}`,
          ];
      const checkpointCommit = yield* gitText(repoRoot, commitArgs, { env });
      yield* runGit(repoRoot, ["update-ref", checkpointRef, checkpointCommit], { env });
      return {
        checkpointRef,
        checkpointCommit,
        headCommit,
        createdAt,
        workingDirOnly: true as const,
      } satisfies Checkpoint;
    });

    const exit = yield* Effect.exit(effect);
    yield* Effect.tryPromise({
      try: () => rm(tempDir, { recursive: true, force: true }),
      catch: (cause) => cause,
    }).pipe(Effect.ignore);
    if (Exit.isFailure(exit)) {
      return yield* Effect.fail(
        new CheckpointFailed({ message: "Unable to capture review checkpoint", cause: exit.cause }),
      );
    }
    return exit.value;
  });

const commitTimestamp = (repoRoot: string, ref: string) =>
  gitText(repoRoot, ["show", "-s", "--format=%ct", ref]).pipe(
    Effect.map((value) => Number(value)),
    Effect.catch((error) =>
      Effect.logWarning(
        `Failed to read git commit timestamp for ${ref}; falling back to 0.`,
        error,
      ).pipe(Effect.as(0)),
    ),
  );

export type CompletedCheckpointCandidate = {
  readonly checkpointRef: string;
  readonly checkpointCommit: string;
  readonly headCommit?: string | null;
  readonly createdAt: number;
};

const toUnixSeconds = (timestamp: number) =>
  timestamp > 9_999_999_999 ? Math.floor(timestamp / 1000) : timestamp;

export const determineReviewBaseFromCompletedCheckpoint = (
  repoRoot: string,
  checkpoint: Checkpoint,
  priorCheckpoint: CompletedCheckpointCandidate | null,
) =>
  Effect.gen(function* () {
    if (!checkpoint.headCommit) {
      return {
        baseRef: emptyTreeCommit,
        baseCommit: null,
        priorCheckpointRef: priorCheckpoint?.checkpointRef ?? null,
      } satisfies ReviewBase;
    }
    if (priorCheckpoint) {
      const headTimestamp = yield* commitTimestamp(repoRoot, "HEAD");
      const priorBelongsToCurrentHead =
        priorCheckpoint.headCommit !== undefined &&
        priorCheckpoint.headCommit !== null &&
        priorCheckpoint.headCommit === checkpoint.headCommit;
      if (priorBelongsToCurrentHead || toUnixSeconds(priorCheckpoint.createdAt) > headTimestamp) {
        const priorCommit = yield* gitText(repoRoot, [
          "rev-parse",
          "--verify",
          `${priorCheckpoint.checkpointCommit}^{commit}`,
        ]).pipe(Effect.catch(() => Effect.succeed(null)));
        if (!priorCommit) {
          return {
            baseRef: "HEAD",
            baseCommit: checkpoint.headCommit,
            priorCheckpointRef: priorCheckpoint.checkpointRef,
          } satisfies ReviewBase;
        }
        return {
          baseRef: priorCommit,
          baseCommit: priorCommit,
          priorCheckpointRef: priorCheckpoint.checkpointRef,
        } satisfies ReviewBase;
      }
    }
    return {
      baseRef: "HEAD",
      baseCommit: checkpoint.headCommit,
      priorCheckpointRef: priorCheckpoint?.checkpointRef ?? null,
    } satisfies ReviewBase;
  });
