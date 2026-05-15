#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { generateCommand } from "./generate";
import { migrateCommand } from "./migrate";
import { pushCommand } from "./push";

export const command = Command.make("effect-sql-kit").pipe(
  Command.withDescription("Drizzle Kit-like migrations for Effect SQL models"),
  Command.withSubcommands([generateCommand, migrateCommand, pushCommand]),
);

export const main = Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
);

export const runMain = () => NodeRuntime.runMain(main);

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  runMain();
}
