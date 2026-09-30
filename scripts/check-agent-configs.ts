import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Console, Effect, FileSystem, Schema } from "effect";
import { parse } from "yaml";

const ReviewerProfileSchema = Schema.Struct({
  coding_agent: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  reasoning_effort: Schema.NonEmptyString,
});

const AgenticReviewConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  reviewers: Schema.Struct({
    correctness_reliability: ReviewerProfileSchema,
    security_privacy: ReviewerProfileSchema,
    maintainability_tests: ReviewerProfileSchema,
    spec_conformance: ReviewerProfileSchema,
  }),
});

const TicketRoutingConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  levels: Schema.Struct({
    quick: ReviewerProfileSchema,
    focused: ReviewerProfileSchema,
    standard: ReviewerProfileSchema,
    complex: ReviewerProfileSchema,
    architectural: ReviewerProfileSchema,
  }),
});

const PositiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0));

const AutonomousDevelopmentConfigSchema = Schema.Struct({
  merge_label: Schema.optional(Schema.NonEmptyString),
  local_reviewers: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  open_code_review: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(
        Schema.Union([Schema.Literal("managed"), Schema.Literal("delegation")]),
      ),
    }),
  ),
  subagent: Schema.optional(
    Schema.Struct({
      model: Schema.NonEmptyString,
      reasoning_effort: Schema.NonEmptyString,
    }),
  ),
});

const ReviewPoolSchema = Schema.Struct({
  scope: Schema.Union([Schema.Literal("local"), Schema.Literal("hosted")]),
  reviewers: Schema.NonEmptyArray(Schema.NonEmptyString),
  max_active: Schema.optional(PositiveIntegerSchema),
  rolling_window: Schema.optional(
    Schema.Struct({
      max_invocations: PositiveIntegerSchema,
      window_seconds: PositiveIntegerSchema,
    }),
  ),
});

const TicketCoordinatorConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  worker_backend: Schema.Union([Schema.Literal("subagent"), Schema.Literal("t3code-mcp")]),
  max_workers: PositiveIntegerSchema,
  stack_backend: Schema.Union([Schema.Literal("github-native"), Schema.Literal("graphite")]),
  review_pools: Schema.Record(Schema.String, ReviewPoolSchema),
});

const configSchemas: Readonly<Record<string, Schema.Top>> = {
  "agentic-review.yaml": AgenticReviewConfigSchema,
  "autonomous-development.yaml": AutonomousDevelopmentConfigSchema,
  "ticket-coordinator.yaml": TicketCoordinatorConfigSchema,
  "ticket-routing.yaml": TicketRoutingConfigSchema,
};

const formatInventoryIssue = (
  label: string,
  fileNames: ReadonlyArray<string>,
): string | undefined => (fileNames.length === 0 ? undefined : `${label}: ${fileNames.join(", ")}`);

const validateConfigInventory = (yamlFiles: ReadonlyArray<string>): Effect.Effect<void, Error> => {
  const knownFiles = Object.keys(configSchemas).sort();
  const unknownFiles = yamlFiles.filter((fileName) => configSchemas[fileName] === undefined);
  const missingFiles = knownFiles.filter((fileName) => !yamlFiles.includes(fileName));
  const details = [
    formatInventoryIssue("unregistered", unknownFiles),
    formatInventoryIssue("missing", missingFiles),
  ]
    .filter((issue): issue is string => issue !== undefined)
    .join("; ");
  if (details.length > 0) {
    return Effect.fail(new Error(`.agents YAML inventory mismatch: ${details}`));
  }
  return Effect.void;
};

const validateReviewPoolScopes = (
  coordinator: Schema.Schema.Type<typeof TicketCoordinatorConfigSchema>,
): Effect.Effect<void, Error> => {
  const pools = Object.values(coordinator.review_pools);
  if (
    !pools.some((pool) => pool.scope === "local") ||
    !pools.some((pool) => pool.scope === "hosted")
  ) {
    return Effect.fail(
      new Error(".agents/ticket-coordinator.yaml must define local and hosted review pools"),
    );
  }
  return Effect.void;
};

const validateMergeLabel = (
  autonomous: Schema.Schema.Type<typeof AutonomousDevelopmentConfigSchema>,
): Effect.Effect<void, Error> => {
  if (autonomous.merge_label === undefined || autonomous.merge_label.length === 0) {
    return Effect.fail(
      new Error(
        ".agents/autonomous-development.yaml must define merge_label for ticket coordination",
      ),
    );
  }
  return Effect.void;
};

const validateLocalReviewerQuotas = (
  autonomous: Schema.Schema.Type<typeof AutonomousDevelopmentConfigSchema>,
  coordinator: Schema.Schema.Type<typeof TicketCoordinatorConfigSchema>,
): Effect.Effect<void, Error> => {
  const pools = Object.values(coordinator.review_pools);
  const quotaReviewers = new Set(
    pools.filter((pool) => pool.scope === "local").flatMap((pool) => pool.reviewers),
  );
  const missingLocalReviewers = (autonomous.local_reviewers ?? []).filter(
    (reviewer) => !quotaReviewers.has(reviewer),
  );
  return missingLocalReviewers.length > 0
    ? Effect.fail(
        new Error(
          `.agents/ticket-coordinator.yaml has no local quota pool for ${missingLocalReviewers.join(", ")}`,
        ),
      )
    : Effect.void;
};

const readAndDecodeConfig = <S extends Schema.Top & { readonly DecodingServices: never }>(
  fileSystem: FileSystem.FileSystem,
  fileName: string,
  schema: S,
): Effect.Effect<S["Type"], Error> =>
  Effect.gen(function* () {
    const filePath = `.agents/${fileName}`;
    const source = yield* fileSystem
      .readFileString(filePath)
      .pipe(
        Effect.mapError(
          (cause) => new Error(`${filePath}: unable to read config: ${String(cause)}`),
        ),
      );
    const parsed = yield* Effect.try({
      try: () => parse(source),
      catch: (cause) => new Error(`${filePath}: invalid YAML: ${String(cause)}`),
    });
    return yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(parsed).pipe(
      Effect.mapError((cause) => new Error(`${filePath}: invalid config: ${String(cause)}`)),
    );
  });

const main = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* fileSystem
    .readDirectory(".agents")
    .pipe(
      Effect.mapError((cause) => new Error(`.agents: unable to list configs: ${String(cause)}`)),
    );
  const yamlFiles = entries
    .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
    .sort();
  yield* validateConfigInventory(yamlFiles);

  const autonomous = yield* readAndDecodeConfig(
    fileSystem,
    "autonomous-development.yaml",
    AutonomousDevelopmentConfigSchema,
  );
  const agenticReview = yield* readAndDecodeConfig(
    fileSystem,
    "agentic-review.yaml",
    AgenticReviewConfigSchema,
  );
  const ticketRouting = yield* readAndDecodeConfig(
    fileSystem,
    "ticket-routing.yaml",
    TicketRoutingConfigSchema,
  );
  const ticketCoordinator = yield* readAndDecodeConfig(
    fileSystem,
    "ticket-coordinator.yaml",
    TicketCoordinatorConfigSchema,
  );

  yield* validateReviewPoolScopes(ticketCoordinator);
  yield* validateMergeLabel(autonomous);
  yield* validateLocalReviewerQuotas(autonomous, ticketCoordinator);

  const validated = [autonomous, agenticReview, ticketRouting, ticketCoordinator];
  yield* Console.log(`Validated ${validated.length} .agents YAML configs.`);
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeFileSystem.layer)));
