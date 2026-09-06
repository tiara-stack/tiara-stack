import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { EffectivePrincipal } from "sheet-auth/identity";
import { CheckinMessagesLoad, CheckinMessagesSave, WorkspaceId } from "sheet-workflow-contracts";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { SheetDataProvider } from "@/services/sheetDataProvider";
import { makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import { workflowTestAccountId } from "../shared/testHelpers";
import {
  checkinMessagesWorkflowOperationsLayer,
  CheckinMessagesWorkflowOperations,
} from "./messageService";

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
const principal = Schema.decodeUnknownSync(EffectivePrincipal)({
  kind: "user",
  userId: "user-1",
  discordAccount: { accountId: workflowTestAccountId },
});
const target = {
  workspaceId,
  conversationId: "running-1",
  conversationName: "running",
  eventStartEpochMs: 1_700_000_000_000,
};
const binding = { eventStartEpochMs: target.eventStartEpochMs, messageSetGeneration: 1 };

const makeProvider = (): SheetDataProvider["Service"] => ({
  generateCheckin: () => Effect.die("unused"),
  resolveCheckinMessageTarget: () => Effect.succeed(target),
  generateRoomOrder: () => Effect.die("unused"),
  loadWorkspaceSchedules: () => Effect.die("unused"),
  resolveSpreadsheetId: () => Effect.die("unused"),
});

const makeOperations = (persistence: TrustedSheetPersistenceShape) =>
  Effect.gen(function* () {
    return yield* CheckinMessagesWorkflowOperations;
  }).pipe(
    Effect.provide(checkinMessagesWorkflowOperationsLayer),
    Effect.provide(Layer.succeed(TrustedSheetPersistence, persistence)),
    Effect.provide(Layer.succeed(SheetDataProvider, makeProvider())),
  );

describe("check-in message workflow operations", () => {
  it.effect("reconciles the current event and returns configuration rows", () =>
    Effect.gen(function* () {
      const base = makeTrustedSheetPersistenceMock();
      let currentSet: Effect.Success<
        ReturnType<TrustedSheetPersistenceShape["checkinMessages"]["getMessageSet"]>
      > = Option.none();
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        checkinMessages: {
          ...base.checkinMessages,
          getMessageSet: () => Effect.succeed(currentSet),
          reconcileMessageSet: (input) =>
            Effect.sync(() => {
              currentSet = Option.some({
                workspaceId: input.workspaceId,
                eventStartEpochMs: input.observedEventStartEpochMs,
                messageSetGeneration: 1,
                updatedBy: input.updatedBy,
                createdAt: 1,
                updatedAt: 1,
                deletedAt: null,
              });
            }),
          listHourlyMessages: () =>
            Effect.succeed([
              {
                workspaceId,
                messageSetGeneration: 1,
                conversationId: "running-1",
                hour: 12,
                template: "saved {{hourString}}",
                version: 3,
                createdBy: workflowTestAccountId,
                updatedBy: workflowTestAccountId,
                createdAt: 1,
                updatedAt: 1,
                deletedAt: null,
              },
            ]),
        },
      };
      const operations = yield* makeOperations(persistence);
      const result = yield* operations.load(
        Schema.decodeUnknownSync(CheckinMessagesLoad.input)({
          workspaceId,
          conversationName: "running",
        }),
        principal,
      );
      expect(result).toMatchObject({
        workspaceId,
        conversationId: "running-1",
        conversationName: "running",
        binding,
        messages: [{ hour: 12, template: "saved {{hourString}}", version: 3 }],
      });
    }),
  );

  it.effect("rejects a stale event binding before writing", () =>
    Effect.gen(function* () {
      const base = makeTrustedSheetPersistenceMock();
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        checkinMessages: {
          ...base.checkinMessages,
          getMessageSet: () =>
            Effect.succeed(
              Option.some({
                workspaceId,
                eventStartEpochMs: target.eventStartEpochMs + 1,
                messageSetGeneration: 2,
                updatedBy: workflowTestAccountId,
                createdAt: 1,
                updatedAt: 1,
                deletedAt: null,
              }),
            ),
          saveHourlyMessage: () => Effect.die("stale binding must not write"),
        },
      };
      const operations = yield* makeOperations(persistence);
      const exit = yield* Effect.exit(
        operations.save(
          Schema.decodeUnknownSync(CheckinMessagesSave.input)({
            workspaceId,
            conversationId: "running-1",
            binding,
            hour: 12,
            template: "draft",
            expectedVersion: 3,
          }),
          "123e4567-e89b-42d3-a456-426614174000",
          principal,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "CheckinMessageConflict",
          kind: "event-binding",
        });
      }
    }),
  );
});
