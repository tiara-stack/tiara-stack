#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { registerHooks } from "node:module";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The installed generic core has no CLI dependency. Resolve its Effect imports
// from this repository's runtime, and only for that exact module URL.
const coreUrl = pathToFileURL("/opt/data/skills/agentic-review/scripts/review-prep-core.ts").href;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectAnchor = pathToFileURL(
  path.join(repoRoot, "packages/developer-launcher/package.json"),
).href;
const projectRequire = createRequire(projectAnchor);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL === coreUrl &&
      (specifier === "effect" || specifier.startsWith("effect/"))
    ) {
      return nextResolve(specifier, { ...context, parentURL: projectAnchor });
    }
    return nextResolve(specifier, context);
  },
});
const core = await import(coreUrl);
const ReviewPlanHead = Schema.Struct({ source: Schema.Struct({ head: Schema.String }) });
const ReceiptHead = Schema.Struct({ head: Schema.String });

const assertLiveHead = (head: string) => {
  const liveHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (head !== liveHead)
    throw new Error(`Receipt head ${head} does not match live HEAD ${liveHead}`);
  return liveHead;
};

const bundle = Command.make(
  "bundle",
  {
    input: Flag.string("input"),
    axis: Flag.string("axis"),
    output: Flag.string("output"),
  },
  ({ input, axis, output }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const inputPath = path.resolve(input);
      const plan = Schema.decodeUnknownSync(ReviewPlanHead)(
        JSON.parse(yield* fs.readFileString(inputPath)),
      );
      const liveHead = assertLiveHead(plan.source.head);
      const result = yield* core.prepareReviewBundle({ inputPath, axis, outputDirectory: output });
      if (assertLiveHead(plan.source.head) !== liveHead)
        return yield* Effect.fail(new Error("Live HEAD changed while preparing the review bundle"));
      yield* Console.log(
        `Coordinator manifest: ${result.manifestPath} (${result.manifestBytes} bytes)`,
      );
      yield* Console.log(
        `Reviewer input: ${result.reviewerInputPath} (${result.reviewerInputBytes} bytes)`,
      );
    }),
).pipe(Command.withDescription("Prepare one bounded reviewer bundle from a versioned local plan"));

const grant = Command.make(
  "check-grant",
  { input: Flag.string("input"), output: Flag.string("output") },
  ({ input, output }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const inputPath = path.resolve(input);
      const grantInput = Schema.decodeUnknownSync(ReceiptHead)(
        JSON.parse(yield* fs.readFileString(inputPath)),
      );
      const liveHead = assertLiveHead(grantInput.head);
      const result = yield* core.checkConditionalGrant({ inputPath: input, outputPath: output });
      if (assertLiveHead(grantInput.head) !== liveHead)
        return yield* Effect.fail(
          new Error("Live HEAD changed while checking the conditional grant"),
        );
      yield* Console.log(`Grant predicate check: ${result.status} (${result.outputPath})`);
      if (result.status === "reconcile")
        return yield* Effect.fail(new Error("Grant predicates require coordinator reconciliation"));
    }),
).pipe(Command.withDescription("Check recorded grant predicates without changing quota state"));

const starts = Command.make(
  "count-starts",
  { input: Flag.string("input"), output: Flag.string("output") },
  ({ input, output }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const inputPath = path.resolve(input);
      const startsInput = Schema.decodeUnknownSync(ReceiptHead)(
        JSON.parse(yield* fs.readFileString(inputPath)),
      );
      const liveHead = assertLiveHead(startsInput.head);
      const result = yield* core.countNativeStarts({ inputPath: input, outputPath: output });
      if (assertLiveHead(startsInput.head) !== liveHead)
        return yield* Effect.fail(new Error("Live HEAD changed while counting native starts"));
      yield* Console.log(
        `Counted ${result.uniqueStarts} unique starts, collapsed ${result.duplicateReceipts} duplicates (${result.outputPath})`,
      );
    }),
).pipe(Command.withDescription("Deduplicate recorded native starts without changing quota state"));

const timing = Command.make(
  "timing",
  { input: Flag.string("input"), output: Flag.string("output") },
  ({ input, output }) =>
    Effect.gen(function* () {
      const result = yield* core.buildTimingSummary({ inputPath: input, outputPath: output });
      yield* Console.log(`Timing summary: ${result.outputPath} (${result.summary.status})`);
    }),
).pipe(Command.withDescription("Summarize observed workflow intervals"));

const command = Command.make("review-prep").pipe(
  Command.withDescription(
    `TiaraStack adapter for installed agentic-review core (${projectRequire.resolve("effect/package.json")})`,
  ),
  Command.withSubcommands([bundle, grant, starts, timing]),
);

export const main = Command.run(command, { version: "tiara-review-prep/v1" }).pipe(
  Effect.provide(NodeServices.layer),
);
export const runMain = () => NodeRuntime.runMain(main);
if (process.argv[1]?.endsWith("review-prep.ts")) runMain();
