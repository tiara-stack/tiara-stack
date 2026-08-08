import { Effect, Match, Predicate, Schema } from "effect";
import { DeliveryKey, DeliveryReceipt } from "sheet-bot-api";
import { makeBotCapabilityStore } from "./services/botCapabilityStore";

class RecoveryCommandError extends Schema.TaggedErrorClass<RecoveryCommandError>()(
  "RecoveryCommandError",
  { message: Schema.String },
) {}

const usage = `Usage:
  reconcile-delivery inspect --delivery-key <key>
  reconcile-delivery confirmed --delivery-key <key> --actor <operator> --evidence <reference> --receipt-json <json>
  reconcile-delivery safe-retry --delivery-key <key> --actor <operator> --evidence <reference>
  reconcile-delivery unresolved --delivery-key <key> --actor <operator> --evidence <reference>`;

const flagOccurrences = (args: ReadonlyArray<string>, flag: string) =>
  args.flatMap((argument, index) => {
    if (argument === flag) return [{ inline: false, value: args[index + 1] }];
    const inlinePrefix = `${flag}=`;
    return argument.startsWith(inlinePrefix)
      ? [{ inline: true, value: argument.slice(inlinePrefix.length) }]
      : [];
  });

// Keeping all flag forms and ambiguity checks together makes malformed recovery commands fail
// before configuration or Redis is accessed.
// fallow-ignore-next-line complexity
const requireFlag = (args: ReadonlyArray<string>, flag: string) => {
  const occurrences = flagOccurrences(args, flag);
  if (occurrences.length === 0) {
    return Effect.fail(new RecoveryCommandError({ message: `Missing ${flag}\n\n${usage}` }));
  }
  if (occurrences.length > 1) {
    return Effect.fail(new RecoveryCommandError({ message: `Repeated ${flag}\n\n${usage}` }));
  }
  const occurrence = occurrences[0];
  if (Predicate.isUndefined(occurrence)) {
    return Effect.fail(new RecoveryCommandError({ message: `Missing ${flag}\n\n${usage}` }));
  }
  const value = occurrence.value;
  return !Predicate.isString(value) ||
    value.length === 0 ||
    (!occurrence.inline && value.startsWith("--"))
    ? Effect.fail(new RecoveryCommandError({ message: `Malformed value for ${flag}\n\n${usage}` }))
    : Effect.succeed(value);
};

const decodeDeliveryKey = (value: string) =>
  Schema.decodeUnknownEffect(DeliveryKey)(value).pipe(
    Effect.mapError(() => new RecoveryCommandError({ message: "Invalid Delivery Key" })),
  );

const decodeReceipt = (value: string) =>
  Effect.try({
    try: () => JSON.parse(value) as unknown,
    catch: () => new RecoveryCommandError({ message: "--receipt-json is not valid JSON" }),
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknownEffect(DeliveryReceipt)(parsed).pipe(
        Effect.mapError(
          () => new RecoveryCommandError({ message: "--receipt-json is not a Delivery Receipt" }),
        ),
      ),
    ),
  );

export const runRecoveryCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const action = yield* Schema.decodeUnknownEffect(
      Schema.Literals(["inspect", "confirmed", "safe-retry", "unresolved"]),
    )(args[0]).pipe(Effect.mapError(() => new RecoveryCommandError({ message: usage })));
    const deliveryKey = yield* requireFlag(args, "--delivery-key").pipe(
      Effect.flatMap(decodeDeliveryKey),
    );
    const command = yield* Match.value(action).pipe(
      Match.when("inspect", () => Effect.succeed({ _tag: "Inspect" as const, deliveryKey })),
      Match.when("confirmed", () =>
        Effect.gen(function* () {
          const actor = yield* requireFlag(args, "--actor");
          const evidence = yield* requireFlag(args, "--evidence");
          const receipt = yield* requireFlag(args, "--receipt-json").pipe(
            Effect.flatMap(decodeReceipt),
          );
          return {
            _tag: "Reconcile" as const,
            deliveryKey,
            actor,
            evidence,
            resolution: { _tag: "Confirmed", receipt },
          } as const;
        }),
      ),
      Match.when("safe-retry", () =>
        Effect.gen(function* () {
          const actor = yield* requireFlag(args, "--actor");
          const evidence = yield* requireFlag(args, "--evidence");
          return {
            _tag: "Reconcile" as const,
            deliveryKey,
            actor,
            evidence,
            resolution: { _tag: "SafeRetry" },
          } as const;
        }),
      ),
      Match.when("unresolved", () =>
        Effect.gen(function* () {
          const actor = yield* requireFlag(args, "--actor");
          const evidence = yield* requireFlag(args, "--evidence");
          return {
            _tag: "Reconcile" as const,
            deliveryKey,
            actor,
            evidence,
            resolution: { _tag: "Unresolved" },
          } as const;
        }),
      ),
      Match.exhaustive,
    );
    const store = yield* makeBotCapabilityStore;

    return yield* Match.value(command).pipe(
      Match.when({ _tag: "Inspect" }, ({ deliveryKey }) => store.inspectDelivery(deliveryKey)),
      Match.when({ _tag: "Reconcile" }, ({ _tag: _, ...input }) => store.reconcileDelivery(input)),
      Match.exhaustive,
    );
  });
