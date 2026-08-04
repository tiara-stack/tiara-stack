import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";
import { command } from "./index";

const runCli = (...args: readonly string[]) =>
  Effect.gen(function* () {
    yield* Command.runWith(command, { version: "0.0.0" })(args);
    return (yield* TestConsole.logLines).join("\n");
  }).pipe(Effect.provide(TestConsole.layer), Effect.provide(NodeServices.layer));

describe("effect-zero Effect CLI", () => {
  it.live("prints root help", () =>
    Effect.gen(function* () {
      const output = yield* runCli("--help");

      expect(output).toContain("effect-zero");
      expect(output).toContain("generate");
    }),
  );

  it.live("prints generate help", () =>
    Effect.gen(function* () {
      const output = yield* runCli("generate", "--help");

      expect(output).toContain("--config");
      expect(output).toContain("--output");
      expect(output).toContain("--tsconfig");
      expect(output).toContain("--format");
      expect(output).toContain("--force");
    }),
  );
});
