#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const canonicalPath = (value: string) => {
  try {
    return realpathSync(value);
  } catch {
    return path.normalize(path.resolve(value));
  }
};

const isMain = () => {
  if (!process.argv[1]) return false;
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));
};

if (isMain()) {
  runMain();
}
