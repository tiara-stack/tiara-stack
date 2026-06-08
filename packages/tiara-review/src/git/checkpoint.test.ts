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
  it("captures tracked and untracked files without modifying branch or real index", async () => {
    const repo = makeRepo();
    try {
      const originalHead = git(repo, ["rev-parse", "HEAD"]);
      writeFileSync(join(repo, "tracked.txt"), "changed\n");
      writeFileSync(join(repo, "untracked.txt"), "new\n");
      writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
      writeFileSync(join(repo, "ignored.txt"), "ignored\n");

      const checkpoint = await Effect.runPromise(captureCheckpoint(repo));

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
  });

  it("chooses HEAD when there is no prior checkpoint", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "tracked.txt"), "changed\n");
      const checkpoint = await Effect.runPromise(captureCheckpoint(repo));
      const base = await Effect.runPromise(
        determineReviewBaseFromCompletedCheckpoint(repo, checkpoint, null),
      );
      const head = await Effect.runPromise(getHeadCommit(repo));
      expect(base.baseRef).toBe("HEAD");
      expect(base.baseCommit).toBe(head);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("chooses a prior checkpoint newer than HEAD", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "tracked.txt"), "first\n");
      const prior = await Effect.runPromise(captureCheckpoint(repo));
      writeFileSync(join(repo, "tracked.txt"), "second\n");
      const current = await Effect.runPromise(captureCheckpoint(repo));
      const base = await Effect.runPromise(
        determineReviewBaseFromCompletedCheckpoint(repo, current, prior),
      );
      expect(base.baseRef).toBe(prior.checkpointCommit);
      expect(base.priorCheckpointRef).toBe(prior.checkpointRef);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back to HEAD when a completed checkpoint commit is unavailable", async () => {
    const repo = makeRepo();
    try {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      writeFileSync(join(repo, "tracked.txt"), "changed\n");
      const current = await Effect.runPromise(captureCheckpoint(repo));
      const base = await Effect.runPromise(
        determineReviewBaseFromCompletedCheckpoint(repo, current, {
          checkpointRef: "refs/tiara-review-checkpoints/missing",
          checkpointCommit: "0000000000000000000000000000000000000000",
          createdAt: current.createdAt + 1,
        }),
      );
      const head = await Effect.runPromise(getHeadCommit(repo));
      expect(base.baseRef).toBe("HEAD");
      expect(base.baseCommit).toBe(head);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("resolves repo root", async () => {
    const repo = makeRepo();
    try {
      await expect(Effect.runPromise(resolveRepoRoot(repo))).resolves.toBe(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
