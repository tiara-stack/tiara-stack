import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  captureCheckpoint,
  determineReviewBaseFromCompletedCheckpoint,
  getHeadCommit,
  resolveRepoRoot,
} from "./checkpoint";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trimEnd();

const makeRepo = () => {
  const repo = mkdtempSync(join(tmpdir(), "tiara-review-test."));
  git(repo, ["init"]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "tag.gpgsign", "false"]);
  writeFileSync(join(repo, "tracked.txt"), "initial\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
};

describe("checkpoint", () => {
  it.live("captures tracked and untracked files without modifying branch or real index", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      try {
        const originalHead = git(repo, ["rev-parse", "HEAD"]);
        writeFileSync(join(repo, "tracked.txt"), "changed\n");
        writeFileSync(join(repo, "untracked.txt"), "new\n");
        writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
        writeFileSync(join(repo, "ignored.txt"), "ignored\n");

        const checkpoint = yield* captureCheckpoint(repo);

        expect(checkpoint.checkpointRef).toMatch(/^refs\/tiara-review-checkpoints\//);
        expect(git(repo, ["rev-parse", "HEAD"])).toBe(originalHead);
        expect(git(repo, ["status", "--short"])).toContain(" M tracked.txt");
        expect(git(repo, ["status", "--short"])).toContain("?? untracked.txt");
        expect(git(repo, ["show", `${checkpoint.checkpointCommit}:tracked.txt`])).toBe("changed");
        expect(git(repo, ["show", `${checkpoint.checkpointCommit}:untracked.txt`])).toBe("new");
        expect(() => git(repo, ["show", `${checkpoint.checkpointCommit}:ignored.txt`])).toThrow();
        expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("changed\n");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }),
  );

  it.live("chooses HEAD when there is no prior checkpoint", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      try {
        writeFileSync(join(repo, "tracked.txt"), "changed\n");
        const checkpoint = yield* captureCheckpoint(repo);
        const base = yield* determineReviewBaseFromCompletedCheckpoint(repo, checkpoint, null);
        const head = yield* getHeadCommit(repo);
        expect(base.baseRef).toBe("HEAD");
        expect(base.baseCommit).toBe(head);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }),
  );

  it.live("chooses a prior checkpoint newer than HEAD", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      try {
        writeFileSync(join(repo, "tracked.txt"), "first\n");
        const prior = yield* captureCheckpoint(repo);
        writeFileSync(join(repo, "tracked.txt"), "second\n");
        const current = yield* captureCheckpoint(repo);
        const base = yield* determineReviewBaseFromCompletedCheckpoint(repo, current, prior);
        expect(base.baseRef).toBe(prior.checkpointCommit);
        expect(base.priorCheckpointRef).toBe(prior.checkpointRef);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }),
  );

  it.live("falls back to HEAD when a completed checkpoint commit is unavailable", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      try {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1100)));
        writeFileSync(join(repo, "tracked.txt"), "changed\n");
        const current = yield* captureCheckpoint(repo);
        const base = yield* determineReviewBaseFromCompletedCheckpoint(repo, current, {
          checkpointRef: "refs/tiara-review-checkpoints/missing",
          checkpointCommit: "0000000000000000000000000000000000000000",
          createdAt: current.createdAt + 1,
        });
        const head = yield* getHeadCommit(repo);
        expect(base.baseRef).toBe("HEAD");
        expect(base.baseCommit).toBe(head);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }),
  );

  it.live("resolves repo root", () =>
    Effect.gen(function* () {
      const repo = makeRepo();
      try {
        expect(yield* resolveRepoRoot(repo)).toBe(repo);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }),
  );
});
