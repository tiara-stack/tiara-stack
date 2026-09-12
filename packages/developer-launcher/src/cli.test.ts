import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";
import { command } from "./cli";

const runCliHelp = () =>
  Effect.gen(function* () {
    yield* Command.runWith(command, { version: "0.0.0" })(["--help"]);
    return (yield* TestConsole.logLines).join("\n");
  }).pipe(Effect.provide(TestConsole.layer), Effect.provide(NodeServices.layer));

describe("developer launcher Effect CLI", () => {
  it.live("uses Effect CLI to render root help and typed flags", () =>
    Effect.gen(function* () {
      const output = yield* runCliHelp();

      expect(output).toContain("Select a safe TiaraStack development mode");
      expect(output).toContain("--env-file");
      expect(output).toContain("--confirm-development");
      expect(output).toContain("--json");
    }),
  );

  it.live("keeps mode help on the launcher command instead of Effect's root help flag", () =>
    Effect.gen(function* () {
      process.exitCode = 0;
      try {
        yield* Command.runWith(command, { version: "0.0.0" })(["fast", "help"]);
        const output = (yield* TestConsole.logLines).join("\n");

        expect(output).toContain("TiaraStack fast mode");
        expect(output).toContain("pnpm dev fast up");
      } finally {
        process.exitCode = 0;
      }
    }).pipe(Effect.provide(TestConsole.layer), Effect.provide(NodeServices.layer)),
  );

  it.live("keeps launcher failures structured through the Effect CLI handler", () =>
    Effect.gen(function* () {
      process.exitCode = 0;
      try {
        yield* Command.runWith(command, { version: "0.0.0" })(["unknown", "--json"]);
        const output = (yield* TestConsole.logLines).join("\n");

        expect(output).toContain('"code":"invalid-mode"');
        expect(process.exitCode).toBe(2);
      } finally {
        process.exitCode = 0;
      }
    }).pipe(Effect.provide(TestConsole.layer), Effect.provide(NodeServices.layer)),
  );
});
