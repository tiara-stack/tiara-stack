import { expect, layer } from "@effect/vitest";
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import type { WorkflowZeroContext as CanonicalWorkflowZeroContext } from "effect-zero-workflow";
import { makeTestSheetZeroDatabase } from "sheet-db-schema/testdb";
import {
  makeTrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import type { WorkflowZeroContext as SharedWorkflowZeroContext } from "sheet-zero-server/authorization";
import { ArgumentError } from "typhoon-core/error";
import { ZeroClient } from "typhoon-zero/client";
import { makeTrustedPersistenceServices } from "./dispatch/clients/trustedPersistence";
import { makeClientDeliveryMock } from "./testHelpers";

type TrustedViewIncludesRuns = "runs" extends keyof TrustedSheetPersistenceShape ? true : false;
const _trustedViewIncludesRuns: TrustedViewIncludesRuns = false;
const sharedWorkflowContext: SharedWorkflowZeroContext = {
  principalId: "composition-contract",
  visibilityKey: "service:composition-contract",
};
const _canonicalWorkflowContext: CanonicalWorkflowZeroContext = sharedWorkflowContext;

class WorkflowPersistenceFixture extends Context.Service<WorkflowPersistenceFixture>()(
  "WorkflowPersistenceFixture",
  {
    make: Effect.gen(function* () {
      const database = yield* makeTestSheetZeroDatabase();
      const persistence = yield* makeTrustedSheetPersistence(database.executor);
      return { database, persistence };
    }),
  },
) {}

const WorkflowPersistenceFixtureLayer = Layer.effect(
  WorkflowPersistenceFixture,
  WorkflowPersistenceFixture.make,
);

const makeWorkflowPersistenceServices = (persistence: TrustedSheetPersistenceShape) =>
  makeTrustedPersistenceServices(persistence, makeClientDeliveryMock(), (messageId, operation) =>
    operation({
      clientPlatform: "discord",
      clientId: "client-1",
      messageId,
    }),
  );

const expectZeroExecutorFailure = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected Zero executor failure");
  }
  const failure = exit.cause.reasons.find(Cause.isFailReason);
  if (failure === undefined || !Schema.is(ZeroClient.ZeroClientExecutorError)(failure.error)) {
    throw new Error("Expected ZeroClientExecutorError failure reason");
  }
  return failure.error;
};

layer(WorkflowPersistenceFixtureLayer, { timeout: Duration.seconds(30) })(
  "sheet-workflows trusted persistence composition",
  (it) => {
    it.effect("executes migrated workflow persistence without widening the policy", () =>
      Effect.gen(function* () {
        const { database, persistence } = yield* WorkflowPersistenceFixture;
        yield* database.reset;
        const services = makeWorkflowPersistenceServices(persistence);

        yield* services.messageCheckinService.persistMessageCheckin("checkin-1", {
          data: {
            initialMessage: [{ type: "text", text: "hello" }],
            hour: 12,
            runningConversationId: "running-1",
            roleId: null,
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            createdByUserId: "user-1",
          },
          memberIds: ["member-1", "member-2"],
        });
        yield* services.messageSlotService.upsertMessageSlotData("slot-1", {
          day: 4,
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          createdByUserId: "user-1",
        });
        yield* persistence.teamSubmissionState.upsertMessageTeamSubmission({
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          messageId: "submission-1",
          clientPlatform: "discord",
          clientId: "client-1",
          discordGuildId: "workspace-1",
          discordChannelId: "conversation-1",
          discordAuthorId: "user-1",
          sheetId: "sheet-1",
          confirmationMessageId: "confirmation-1",
          parsedSubmission: [],
          rowMappings: [],
          rollbackSnapshot: null,
          status: "registered",
        });
        const registeredSubmission =
          yield* persistence.teamSubmissionState.getMessageTeamSubmission({
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            messageId: "submission-1",
          });
        const registered = Option.getOrThrow(registeredSubmission);
        expect(registered).toMatchObject({
          status: "registered",
        });
        const conflictExit = yield* Effect.exit(
          persistence.teamSubmissionState.upsertMessageTeamSubmission({
            workspaceId: registered.workspaceId,
            conversationId: registered.conversationId,
            messageId: registered.messageId,
            clientPlatform: registered.clientPlatform,
            clientId: registered.clientId,
            discordGuildId: registered.discordGuildId,
            discordChannelId: registered.discordChannelId,
            discordAuthorId: registered.discordAuthorId,
            sheetId: registered.sheetId,
            confirmationMessageId: registered.confirmationMessageId,
            parsedSubmission: registered.parsedSubmission,
            rowMappings: registered.rowMappings,
            rollbackSnapshot: registered.rollbackSnapshot,
            expectedVersion: registered.version + 1,
            status: "confirmed",
          }),
        );
        const conflictError = expectZeroExecutorFailure(conflictExit);
        expect(conflictError.code).toBe("TEAM_SUBMISSION_VERSION_CONFLICT");
        const unchangedSubmission = yield* persistence.teamSubmissionState.getMessageTeamSubmission(
          {
            workspaceId: registered.workspaceId,
            conversationId: registered.conversationId,
            messageId: registered.messageId,
          },
        );
        expect(Option.getOrThrow(unchangedSubmission)).toMatchObject({
          status: "registered",
          version: registered.version,
        });
        const confirmationRequest = {
          client: { platform: "discord", clientId: "client-1" },
          dispatchRequestId: "dispatch-confirm-1",
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          messageId: "submission-1",
          confirmationMessageId: "confirmation-1",
          interactionResponseToken: "interaction-token",
          interactionResponseDeadlineEpochMs: 1_700_000_000_000,
        } as const;
        const conflictingServices = makeWorkflowPersistenceServices({
          ...persistence,
          teamSubmissionState: {
            ...persistence.teamSubmissionState,
            upsertMessageTeamSubmission: (args) =>
              persistence.teamSubmissionState.upsertMessageTeamSubmission({
                ...args,
                expectedVersion: (args.expectedVersion ?? 0) + 1,
              }),
          },
        });
        const serviceConflictExit = yield* Effect.exit(
          conflictingServices.teamSubmissionStateService.confirmFromDiscord(
            confirmationRequest,
            "user-1",
          ),
        );
        if (Exit.isSuccess(serviceConflictExit)) {
          throw new Error("Expected team submission version conflict");
        }
        const serviceConflict = Option.getOrThrow(Cause.findErrorOption(serviceConflictExit.cause));
        expect(Schema.is(ArgumentError)(serviceConflict)).toBe(true);

        yield* services.teamSubmissionStateService.confirmFromDiscord(
          confirmationRequest,
          "user-1",
        );

        const checkin = yield* services.messageCheckinService.getMessageCheckinData("checkin-1");
        const members = yield* services.messageCheckinService.getMessageCheckinMembers("checkin-1");
        const slot = yield* services.messageSlotService.getMessageSlotData("slot-1");
        const submission = yield* persistence.teamSubmissionState.getMessageTeamSubmission({
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          messageId: "submission-1",
        });

        expect(Option.getOrThrow(checkin)).toMatchObject({ hour: 12 });
        expect(members).toHaveLength(2);
        const slotData = Option.getOrThrow(slot);
        expect(slotData.day).toBe(4);
        expect(Option.getOrThrow(slotData.workspaceId)).toBe("workspace-1");
        expect(Option.getOrThrow(submission)).toMatchObject({
          status: "confirmed",
        });
        expect(sharedWorkflowContext).toEqual({
          principalId: "composition-contract",
          visibilityKey: "service:composition-contract",
        });
        expect("runs" in persistence).toBe(false);
      }),
    );

    it.effect("rolls back a failed workflow room-order transaction in PGlite", () =>
      Effect.gen(function* () {
        const { database, persistence } = yield* WorkflowPersistenceFixture;
        yield* database.reset;
        const services = makeWorkflowPersistenceServices(persistence);

        const exit = yield* Effect.exit(
          services.messageRoomOrderService.persistMessageRoomOrder("room-order-1", {
            data: {
              previousFills: [],
              fills: [],
              hour: 14,
              rank: 2,
              workspaceId: null,
              conversationId: null,
              createdByUserId: null,
            },
            entries: [
              { rank: 2, position: 0, hour: 14, team: "A", tags: [], effectValue: 1 },
              {
                // Exceeds the rank column width to force the database transaction to fail.
                rank: 2 ** 40,
                position: 1,
                hour: 15,
                team: "B",
                tags: [],
                effectValue: 2,
              },
            ],
          }),
        );

        expect(expectZeroExecutorFailure(exit).operation).toBe("run mutation");
        expect(yield* database.rows("messageRoomOrder")).toEqual([]);
        expect(yield* database.rows("messageRoomOrderEntry")).toEqual([]);
      }),
    );
  },
);
