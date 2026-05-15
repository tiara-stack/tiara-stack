#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import { generateEffect, writeGeneratedFileEffect } from "./generate";

const generateCommand = Command.make(
  "generate",
  {
    config: Flag.path("config").pipe(Flag.withAlias("c"), Flag.optional),
    output: Flag.path("output").pipe(Flag.withAlias("o"), Flag.withDefault("./zero-schema.gen.ts")),
    tsconfig: Flag.path("tsconfig").pipe(Flag.withAlias("t"), Flag.withDefault("./tsconfig.json")),
    format: Flag.boolean("format").pipe(Flag.withDefault(false)),
    debug: Flag.boolean("debug").pipe(Flag.withDefault(false)),
    jsFileExtension: Flag.boolean("js-file-extension").pipe(Flag.withDefault(false)),
    skipTypes: Flag.boolean("skip-types").pipe(Flag.withDefault(false)),
    skipBuilder: Flag.boolean("skip-builder").pipe(Flag.withDefault(false)),
    skipDeclare: Flag.boolean("skip-declare").pipe(Flag.withDefault(false)),
    enableLegacyMutators: Flag.boolean("enable-legacy-mutators").pipe(Flag.withDefault(false)),
    enableLegacyQueries: Flag.boolean("enable-legacy-queries").pipe(Flag.withDefault(false)),
    force: Flag.boolean("force").pipe(Flag.withDefault(false)),
  },
  (options) =>
    Effect.gen(function* () {
      yield* Console.log("effect-zero: Generating Zero schema...");

      const result = yield* generateEffect({
        config: Option.getOrUndefined(options.config),
        tsConfigPath: options.tsconfig,
        outputFilePath: options.output,
        format: options.format,
        debug: options.debug,
        force: options.force,
        jsFileExtension: options.jsFileExtension,
        skipTypes: options.skipTypes,
        skipBuilder: options.skipBuilder,
        skipDeclare: options.skipDeclare,
        enableLegacyMutators: options.enableLegacyMutators,
        enableLegacyQueries: options.enableLegacyQueries,
      });

      const outputPath = yield* writeGeneratedFileEffect({
        content: result.content,
        outputFilePath: result.outputFilePath,
        force: options.force,
        format: options.format,
      });

      yield* Console.log(`effect-zero: Zero schema written to ${outputPath}`);
    }),
).pipe(Command.withDescription("Generate a Rocicorp Zero schema from Effect SQL models"));

export const command = Command.make("effect-zero").pipe(
  Command.withDescription("The CLI for converting Effect SQL models to Zero schemas"),
  Command.withSubcommands([generateCommand]),
);

export const main = Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
);

export const runMain = () => NodeRuntime.runMain(main);

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  runMain();
}
