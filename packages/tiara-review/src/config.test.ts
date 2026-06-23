import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  defaultConfigPath,
  expandHomePath,
  loadReviewConfig,
  mergeRunConfig,
  ReviewConfigInvalid,
  ReviewConfigLoadFailed,
} from "./config";

const withEnv = <A, E, R>(
  name: string,
  value: string | undefined,
  body: () => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
      return previous;
    }),
    () => body(),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = previous;
        }
      }),
  );

const firstFailure = <E>(exit: Exit.Exit<unknown, E>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe("review config", () => {
  it.live("returns an empty config when the default XDG config is missing", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "tiara-review-config."));
      try {
        const { config, path } = yield* withEnv("XDG_CONFIG_HOME", dir, () =>
          Effect.gen(function* () {
            const path = defaultConfigPath();
            const config = yield* loadReviewConfig();
            return { config, path };
          }),
        );

        expect(path).toBe(join(dir, "tiara-review", "config.json"));
        expect(config).toEqual({});
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("fails when an explicit config path is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(loadReviewConfig("/tmp/tiara-review-missing.json"));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(firstFailure(exit)).toBeInstanceOf(ReviewConfigLoadFailed);
    }),
  );

  it.live("fails on invalid JSON and invalid provider values", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "tiara-review-config."));
      try {
        const invalidJson = join(dir, "invalid.json");
        writeFileSync(invalidJson, "{nope");
        const invalidJsonExit = yield* Effect.exit(loadReviewConfig(invalidJson));
        expect(Exit.isFailure(invalidJsonExit)).toBe(true);
        expect(firstFailure(invalidJsonExit)).toBeInstanceOf(ReviewConfigInvalid);

        const invalidProvider = join(dir, "invalid-provider.json");
        writeFileSync(invalidProvider, JSON.stringify({ provider: "anthropic" }));
        const invalidProviderExit = yield* Effect.exit(loadReviewConfig(invalidProvider));
        expect(Exit.isFailure(invalidProviderExit)).toBe(true);
        expect(firstFailure(invalidProviderExit)).toBeInstanceOf(ReviewConfigInvalid);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("decodes inline provider keys and expands configured db paths", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "tiara-review-config."));
      try {
        const path = join(dir, "config.json");
        writeFileSync(
          path,
          JSON.stringify({
            provider: "openai",
            model: "gpt-4.1",
            reasoning: "medium",
            timeoutMs: 123,
            dbPath: "~/reviews.sqlite",
            providers: {
              openai: { apiKey: "sk-test", apiUrl: "https://example.invalid/v1" },
            },
          }),
        );

        const config = yield* loadReviewConfig(path);

        expect(config.provider).toBe("openai");
        expect(config.modelReasoningEffort).toBe("medium");
        expect(config.providers?.openai?.apiKey).toBe("sk-test");
        expect(config.dbPath).toBe(expandHomePath("~/reviews.sqlite"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("decodes Kimi config and expands Kimi path fields", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "tiara-review-config."));
      try {
        const path = join(dir, "config.json");
        writeFileSync(
          path,
          JSON.stringify({
            provider: "kimi",
            model: "kimi-k2",
            providers: {
              kimi: {
                executable: "~/bin/kimi",
                env: { KIMI_API_KEY: "sk-kimi" },
                thinking: true,
                yoloMode: false,
                approvalPolicy: "allow-read-only-git",
                cleanupGraceMs: 123,
                agentFile: "~/agents/review.md",
                skillsDir: "~/kimi-skills",
                shareDir: "~/.local/share/kimi",
              },
            },
          }),
        );

        const config = yield* loadReviewConfig(path);

        expect(config.provider).toBe("kimi");
        expect(config.providers?.kimi).toMatchObject({
          executable: expandHomePath("~/bin/kimi"),
          env: { KIMI_API_KEY: "sk-kimi" },
          thinking: true,
          yoloMode: false,
          approvalPolicy: "allow-read-only-git",
          cleanupGraceMs: 123,
          agentFile: expandHomePath("~/agents/review.md"),
          skillsDir: expandHomePath("~/kimi-skills"),
          shareDir: expandHomePath("~/.local/share/kimi"),
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("rejects invalid Kimi cleanup grace values", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "tiara-review-config."));
      try {
        const path = join(dir, "config.json");
        writeFileSync(path, JSON.stringify({ providers: { kimi: { cleanupGraceMs: 0 } } }));

        const exit = yield* Effect.exit(loadReviewConfig(path));

        expect(Exit.isFailure(exit)).toBe(true);
        expect(firstFailure(exit)).toBeInstanceOf(ReviewConfigInvalid);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it("merges CLI values over config values", () => {
    const merged = mergeRunConfig({
      fileConfig: {
        provider: "openrouter",
        model: "configured-model",
        modelReasoningEffort: "low",
        timeoutMs: 100,
        dbPath: "/configured.sqlite",
        providers: { openrouter: { apiKey: "sk-or" } },
      },
      cli: {
        cwd: "/repo",
        provider: "kimi",
        model: "cli-model",
        reasoning: "high",
        timeoutMs: 200,
        dbPath: "/cli.sqlite",
      },
    });

    expect(merged).toMatchObject({
      cwd: "/repo",
      provider: "kimi",
      model: "cli-model",
      modelReasoningEffort: "high",
      timeoutMs: 200,
      dbPath: "/cli.sqlite",
      providerConfig: { openrouter: { apiKey: "sk-or" } },
    });
  });

  it("defaults provider to codex", () => {
    expect(mergeRunConfig({ fileConfig: {}, cli: { cwd: "/repo" } }).provider).toBe("codex");
  });

  it("does not re-expand loaded file config db paths", () => {
    expect(
      mergeRunConfig({
        fileConfig: { dbPath: "~/already-loaded.sqlite" },
        cli: { cwd: "/repo" },
      }).dbPath,
    ).toBe("~/already-loaded.sqlite");
  });
});
