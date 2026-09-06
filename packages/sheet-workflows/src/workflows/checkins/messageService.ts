import { createHash } from "node:crypto";
import { Cause, Context, Data, Effect, Exit, Layer, Option, Predicate, Schema } from "effect";
import {
  CheckinMessagesLoad,
  CheckinMessagesSave,
  CheckinMessageSetBinding,
  type CheckinMessagesLoadSuccess,
  type CheckinMessagesSaveSuccess,
  type CheckinMessageConflict,
  type InteractiveDeclaredFailure,
} from "sheet-workflow-contracts";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { SheetDataProvider } from "@/services/sheetDataProvider";
import {
  interactiveExternalOperationRejected,
  requireInteractiveDiscordAccountId,
} from "../shared/interactive";

type MessageSetRow = Effect.Success<
  ReturnType<TrustedSheetPersistenceShape["checkinMessages"]["getMessageSet"]>
>;

type SaveReceiptRow = Effect.Success<
  ReturnType<TrustedSheetPersistenceShape["checkinMessages"]["getSaveReceipt"]>
>;

type MessageRow = Effect.Success<
  ReturnType<TrustedSheetPersistenceShape["checkinMessages"]["listHourlyMessages"]>
>[number];

type CheckinMessageTarget = Effect.Success<
  ReturnType<SheetDataProvider["Service"]["resolveCheckinMessageTarget"]>
>;
type CheckinMessagesLoadInput = Schema.Schema.Type<typeof CheckinMessagesLoad.input>;
type CheckinMessagesSaveInput = Schema.Schema.Type<typeof CheckinMessagesSave.input>;

class CheckinMessagesBindingRetry extends Data.TaggedError("CheckinMessagesBindingRetry")<{}> {}

const operationPrefix = "checkinMessages";

const operationError = (operation: string, cause: unknown) =>
  Effect.logError("Check-in message persistence operation failed", cause).pipe(
    Effect.annotateLogs({ operation }),
    Effect.andThen(
      Effect.fail(
        interactiveExternalOperationRejected(
          operation,
          "PersistenceUnavailable",
          "The hourly check-in message configuration was unavailable",
        ),
      ),
    ),
  );

// fallow-ignore-next-line code-duplication
const stringProperty = (value: unknown, property: string): string | undefined =>
  Predicate.isObject(value) &&
  Predicate.hasProperty(value, property) &&
  Predicate.isString(value[property])
    ? value[property]
    : undefined;

const argumentCode = (error: unknown): string | undefined =>
  Predicate.isTagged("ArgumentError")(error) && Predicate.hasProperty(error, "cause")
    ? stringProperty(error.cause, "code")
    : undefined;

const isMessageSetConflict = (error: unknown): boolean =>
  argumentCode(error) === "CHECKIN_MESSAGE_SET_CONFLICT";

const isMessageVersionConflict = (error: unknown): boolean =>
  argumentCode(error) === "CHECKIN_MESSAGE_VERSION_CONFLICT";

const isMessageReplayConflict = (error: unknown): boolean =>
  argumentCode(error) === "CHECKIN_MESSAGE_REPLAY_CONFLICT";

const bindingFrom = (row: MessageSetRow): CheckinMessageSetBinding | undefined =>
  Option.isSome(row)
    ? Option.getOrUndefined(
        Schema.decodeUnknownOption(CheckinMessageSetBinding)({
          eventStartEpochMs: row.value.eventStartEpochMs,
          messageSetGeneration: row.value.messageSetGeneration,
        }),
      )
    : undefined;

const sameBinding = (
  left: CheckinMessageSetBinding | undefined,
  right: CheckinMessageSetBinding,
): boolean =>
  left?.eventStartEpochMs === right.eventStartEpochMs &&
  left?.messageSetGeneration === right.messageSetGeneration;

const messageSetConflict = (): CheckinMessageConflict => ({
  _tag: "CheckinMessageConflict",
  kind: "event-binding",
  message:
    "The event message set changed while this message was being edited. Reload before saving.",
});

const bindingForTarget = (target: CheckinMessageTarget, row: MessageSetRow) => {
  const binding = bindingFrom(row);
  return binding !== undefined && binding.eventStartEpochMs === target.eventStartEpochMs
    ? binding
    : undefined;
};

const mapMessage = (row: MessageRow) => ({
  hour: row.hour,
  template: row.template,
  version: row.version,
});

const inputDigest = (input: CheckinMessagesSaveInput): string =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        input.workspaceId,
        input.conversationId,
        input.binding,
        input.hour,
        input.template,
        input.expectedVersion,
      ]),
    )
    .digest("hex")}`;

const saveActionKey = (invocationId: string): string =>
  `${CheckinMessagesSave.identity}:${invocationId}`;

const decodeSaveReceipt = (
  receipt: SaveReceiptRow,
): Effect.Effect<CheckinMessagesSaveSuccess, InteractiveDeclaredFailure> =>
  Option.match(receipt, {
    onNone: () =>
      operationError(`${operationPrefix}.save.receipt`, "The save receipt was not persisted"),
    onSome: (row) =>
      Schema.decodeUnknownEffect(CheckinMessagesSave.success)(row.result).pipe(
        Effect.catch((error) => operationError(`${operationPrefix}.save.receipt`, error)),
      ),
  });

interface CheckinMessagesWorkflowOperationsShape {
  readonly load: (
    input: CheckinMessagesLoadInput,
    principal: Parameters<typeof requireInteractiveDiscordAccountId>[0],
  ) => Effect.Effect<
    CheckinMessagesLoadSuccess,
    Schema.Schema.Type<typeof CheckinMessagesLoad.declaredFailure>
  >;
  readonly save: (
    input: CheckinMessagesSaveInput,
    invocationId: string,
    principal: Parameters<typeof requireInteractiveDiscordAccountId>[0],
  ) => Effect.Effect<
    CheckinMessagesSaveSuccess,
    Schema.Schema.Type<typeof CheckinMessagesSave.declaredFailure>
  >;
}

export class CheckinMessagesWorkflowOperations extends Context.Service<
  CheckinMessagesWorkflowOperations,
  CheckinMessagesWorkflowOperationsShape
>()("sheet-workflows/CheckinMessagesWorkflowOperations") {}

export const checkinMessagesWorkflowOperationsLayer = Layer.effect(
  CheckinMessagesWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const dataProvider = yield* SheetDataProvider;

    const getMessageSet = (workspaceId: string) =>
      persistence.checkinMessages.getMessageSet({ workspaceId }).pipe(Effect.timeout("30 seconds"));

    const reconcile = (
      workspaceId: string,
      target: CheckinMessageTarget,
      expectedBinding: CheckinMessageSetBinding | null,
      updatedBy: string,
    ) =>
      persistence.checkinMessages
        .reconcileMessageSet({
          workspaceId,
          observedEventStartEpochMs: target.eventStartEpochMs,
          expectedBinding,
          updatedBy,
        })
        .pipe(Effect.timeout("30 seconds"));

    const loadBinding = (
      input: CheckinMessagesLoadInput,
      target: CheckinMessageTarget,
      updatedBy: string,
    ) => {
      const attempt: (
        remaining: number,
      ) => Effect.Effect<CheckinMessageSetBinding, unknown, never> = (remaining) =>
        Effect.gen(function* () {
          const current = yield* getMessageSet(input.workspaceId);
          const expectedBinding = bindingFrom(current) ?? null;
          yield* reconcile(input.workspaceId, target, expectedBinding, updatedBy).pipe(
            Effect.mapError((error) =>
              isMessageSetConflict(error) ? new CheckinMessagesBindingRetry() : error,
            ),
          );
          const reconciled = yield* getMessageSet(input.workspaceId);
          const binding = bindingForTarget(target, reconciled);
          return binding === undefined
            ? yield* Effect.fail(new CheckinMessagesBindingRetry())
            : binding;
        }).pipe(
          Effect.catch(
            (error): Effect.Effect<CheckinMessageSetBinding, unknown, never> =>
              Predicate.isTagged("CheckinMessagesBindingRetry")(error) && remaining > 0
                ? attempt(remaining - 1)
                : Effect.fail(error),
          ),
        );
      return attempt(2);
    };

    const resolveTarget = (
      input: {
        readonly workspaceId: CheckinMessagesLoadInput["workspaceId"];
        readonly conversationId?: string | undefined;
        readonly conversationName?: string | undefined;
      },
      operation: string,
    ) =>
      dataProvider
        .resolveCheckinMessageTarget(input)
        .pipe(Effect.catch((error) => operationError(operation, error)));

    const load: CheckinMessagesWorkflowOperationsShape["load"] = (input, principal) =>
      Effect.gen(function* () {
        const updatedBy = yield* requireInteractiveDiscordAccountId(
          principal,
          CheckinMessagesLoad.authorizationPolicy.policy,
        );
        const target = yield* resolveTarget(input, `${operationPrefix}.load.resolve-target`);
        const binding = yield* loadBinding(input, target, updatedBy).pipe(
          Effect.catch((error) =>
            Predicate.isTagged("CheckinMessagesBindingRetry")(error)
              ? operationError(`${operationPrefix}.load.reconcile`, error)
              : Effect.fail(error),
          ),
        );
        const rows = yield* persistence.checkinMessages
          .listHourlyMessages({
            workspaceId: input.workspaceId,
            messageSetGeneration: binding.messageSetGeneration,
            conversationId: target.conversationId,
          })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.catch((error) => operationError(`${operationPrefix}.load.rows`, error)),
          );
        return yield* Schema.decodeUnknownEffect(CheckinMessagesLoad.success)({
          workspaceId: input.workspaceId,
          conversationId: target.conversationId,
          conversationName: target.conversationName,
          binding,
          messages: rows.map(mapMessage),
        }).pipe(Effect.catch((error) => operationError(`${operationPrefix}.load.result`, error)));
      }).pipe(
        Effect.catch((error) =>
          Schema.is(CheckinMessagesLoad.declaredFailure)(error)
            ? Effect.fail(error)
            : operationError(`${operationPrefix}.load`, error),
        ),
      );

    const save: CheckinMessagesWorkflowOperationsShape["save"] = (input, invocationId, principal) =>
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const updatedBy = yield* requireInteractiveDiscordAccountId(
          principal,
          CheckinMessagesSave.authorizationPolicy.policy,
        );
        const actionKey = saveActionKey(invocationId);
        const digest = inputDigest(input);
        const existingReceipt = yield* persistence.checkinMessages
          .getSaveReceipt({ workspaceId: input.workspaceId, invocationId, actionKey })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.catch((error) => operationError(`${operationPrefix}.save.receipt`, error)),
          );
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.inputDigest !== digest) {
            return yield* Effect.fail<CheckinMessageConflict>({
              _tag: "CheckinMessageConflict",
              kind: "replayed-input",
              message: "This save invocation was replayed with different input.",
            });
          }
          return yield* decodeSaveReceipt(existingReceipt);
        }

        const target = yield* resolveTarget(input, `${operationPrefix}.save.resolve-target`);
        if (target.eventStartEpochMs !== input.binding.eventStartEpochMs) {
          return yield* Effect.fail<CheckinMessageConflict>({
            _tag: "CheckinMessageConflict",
            kind: "event-binding",
            message: "The event changed while this message was being edited. Reload before saving.",
          });
        }
        const current = yield* getMessageSet(input.workspaceId).pipe(
          Effect.catch((error) => operationError(`${operationPrefix}.save.binding`, error)),
        );
        if (!sameBinding(bindingFrom(current), input.binding)) {
          return yield* Effect.fail(messageSetConflict());
        }
        const reconcileExit = yield* Effect.exit(
          reconcile(input.workspaceId, target, input.binding, updatedBy),
        );
        if (Exit.isFailure(reconcileExit)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(reconcileExit.cause));
          return yield* isMessageSetConflict(error)
            ? Effect.fail(messageSetConflict())
            : operationError(`${operationPrefix}.save.reconcile`, error);
        }

        const writeExit = yield* Effect.exit(
          persistence.checkinMessages
            .saveHourlyMessage({
              workspaceId: input.workspaceId,
              eventStartEpochMs: input.binding.eventStartEpochMs,
              messageSetGeneration: input.binding.messageSetGeneration,
              conversationId: input.conversationId,
              hour: input.hour,
              template: input.template,
              expectedVersion: input.expectedVersion,
              updatedBy,
              invocationId,
              actionKey,
              inputDigest: digest,
            })
            .pipe(Effect.timeout("30 seconds")),
        );
        if (Exit.isFailure(writeExit)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(writeExit.cause));
          if (isMessageVersionConflict(error)) {
            const currentExit = yield* Effect.exit(
              persistence.checkinMessages
                .getHourlyMessage({
                  workspaceId: input.workspaceId,
                  messageSetGeneration: input.binding.messageSetGeneration,
                  conversationId: input.conversationId,
                  hour: input.hour,
                })
                .pipe(Effect.timeout("30 seconds")),
            );
            const currentVersion =
              Exit.isSuccess(currentExit) && Option.isSome(currentExit.value)
                ? currentExit.value.value.version
                : undefined;
            return yield* Effect.fail({
              _tag: "CheckinMessageConflict" as const,
              kind: "row-version" as const,
              message: "This hour changed while you were editing. Review before saving again.",
              ...(currentVersion === undefined ? {} : { currentVersion }),
            });
          }
          if (isMessageSetConflict(error)) {
            return yield* Effect.fail(messageSetConflict());
          }
          if (isMessageReplayConflict(error)) {
            return yield* Effect.fail({
              _tag: "CheckinMessageConflict" as const,
              kind: "replayed-input" as const,
              message: "This save invocation was replayed with different input.",
            });
          }
          return yield* operationError(`${operationPrefix}.save.write`, error);
        }

        const receipt = yield* persistence.checkinMessages
          .getSaveReceipt({ workspaceId: input.workspaceId, invocationId, actionKey })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.catch((error) => operationError(`${operationPrefix}.save.receipt`, error)),
          );
        return yield* decodeSaveReceipt(receipt);
      }).pipe(
        Effect.catch((error) =>
          Schema.is(CheckinMessagesSave.declaredFailure)(error)
            ? Effect.fail(error)
            : operationError(`${operationPrefix}.save`, error),
        ),
      );

    return { load, save };
  }),
);
