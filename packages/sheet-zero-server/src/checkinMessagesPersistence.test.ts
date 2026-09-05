import { expect, layer } from "@effect/vitest";
import { Cause, Context, Duration, Effect, Exit, Layer, Option } from "effect";
import { makeTestSheetZeroDatabase } from "sheet-db-schema/testdb";
import { makeTrustedSheetPersistence } from "./persistence";

class CheckinMessagesFixture extends Context.Service<CheckinMessagesFixture>()(
  "CheckinMessagesFixture",
  {
    make: Effect.gen(function* () {
      const database = yield* makeTestSheetZeroDatabase();
      const persistence = yield* makeTrustedSheetPersistence(database.executor);
      return { database, persistence };
    }),
  },
) {}

const fixtureLayer = layer(Layer.effect(CheckinMessagesFixture, CheckinMessagesFixture.make), {
  timeout: Duration.seconds(30),
});

const resetFixture = Effect.gen(function* () {
  const fixture = yield* CheckinMessagesFixture;
  yield* fixture.database.reset;
  return fixture;
});

const eventStartEpochMs = Date.UTC(2026, 8, 5, 12);
const binding = { eventStartEpochMs, messageSetGeneration: 1 } as const;

const expectConflict = <A, E>(exit: Exit.Exit<A, E>, code: string) => {
  expect(exit._tag).toBe("Failure");
  if (Exit.isFailure(exit)) {
    expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toMatchObject({ code });
  }
};

fixtureLayer(
  "trusted hourly check-in message persistence compares row versions atomically",
  (it) => {
    it.effect("rejects a stale initial writer after version one commits", () =>
      Effect.gen(function* () {
        const { persistence } = yield* resetFixture;

        yield* persistence.checkinMessages.reconcileMessageSet({
          workspaceId: "workspace-1",
          observedEventStartEpochMs: eventStartEpochMs,
          expectedBinding: null,
          updatedBy: "user-1",
        });
        yield* persistence.checkinMessages.saveHourlyMessage({
          workspaceId: "workspace-1",
          ...binding,
          conversationId: "running-1",
          hour: 12,
          template: "  Keep this text exactly.  ",
          expectedVersion: 0,
          updatedBy: "user-1",
          invocationId: "invocation-1",
          actionKey: "save-hour-12",
          inputDigest: "digest-1",
        });

        const first = Option.getOrThrow(
          yield* persistence.checkinMessages.getHourlyMessage({
            workspaceId: "workspace-1",
            messageSetGeneration: 1,
            conversationId: "running-1",
            hour: 12,
          }),
        );
        expect(first).toMatchObject({
          template: "  Keep this text exactly.  ",
          version: 1,
          createdBy: "user-1",
          updatedBy: "user-1",
        });

        const staleExit = yield* Effect.exit(
          persistence.checkinMessages.saveHourlyMessage({
            workspaceId: "workspace-1",
            ...binding,
            conversationId: "running-1",
            hour: 12,
            template: "stale edit",
            expectedVersion: 0,
            updatedBy: "user-2",
            invocationId: "invocation-2",
            actionKey: "save-hour-12",
            inputDigest: "digest-2",
          }),
        );

        expectConflict(staleExit, "CHECKIN_MESSAGE_VERSION_CONFLICT");
        expect(
          Option.getOrThrow(
            yield* persistence.checkinMessages.getHourlyMessage({
              workspaceId: "workspace-1",
              messageSetGeneration: 1,
              conversationId: "running-1",
              hour: 12,
            }),
          ),
        ).toMatchObject({
          template: "  Keep this text exactly.  ",
          version: 1,
          updatedBy: "user-1",
        });
      }),
    );
  },
);

fixtureLayer("trusted hourly check-in message persistence retains cleared rows", (it) => {
  it.effect("retains a cleared row and requires its version to recreate", () =>
    Effect.gen(function* () {
      const { persistence } = yield* resetFixture;

      yield* persistence.checkinMessages.reconcileMessageSet({
        workspaceId: "workspace-1",
        observedEventStartEpochMs: eventStartEpochMs,
        expectedBinding: null,
        updatedBy: "user-1",
      });
      yield* persistence.checkinMessages.saveHourlyMessage({
        workspaceId: "workspace-1",
        ...binding,
        conversationId: "running-1",
        hour: 12,
        template: "configured",
        expectedVersion: 0,
        updatedBy: "user-1",
        invocationId: "invocation-create",
        actionKey: "save-hour-12",
        inputDigest: "digest-create",
      });
      yield* persistence.checkinMessages.saveHourlyMessage({
        workspaceId: "workspace-1",
        ...binding,
        conversationId: "running-1",
        hour: 12,
        template: "   \n\t ",
        expectedVersion: 1,
        updatedBy: "user-2",
        invocationId: "invocation-clear",
        actionKey: "save-hour-12",
        inputDigest: "digest-clear",
      });

      expect(
        Option.getOrThrow(
          yield* persistence.checkinMessages.getHourlyMessage({
            workspaceId: "workspace-1",
            messageSetGeneration: 1,
            conversationId: "running-1",
            hour: 12,
          }),
        ),
      ).toMatchObject({ template: null, version: 2, updatedBy: "user-2" });

      const recreateFromZero = yield* Effect.exit(
        persistence.checkinMessages.saveHourlyMessage({
          workspaceId: "workspace-1",
          ...binding,
          conversationId: "running-1",
          hour: 12,
          template: "replacement",
          expectedVersion: 0,
          updatedBy: "user-3",
          invocationId: "invocation-recreate-stale",
          actionKey: "save-hour-12",
          inputDigest: "digest-recreate-stale",
        }),
      );
      expectConflict(recreateFromZero, "CHECKIN_MESSAGE_VERSION_CONFLICT");

      yield* persistence.checkinMessages.saveHourlyMessage({
        workspaceId: "workspace-1",
        ...binding,
        conversationId: "running-1",
        hour: 12,
        template: "replacement",
        expectedVersion: 2,
        updatedBy: "user-3",
        invocationId: "invocation-recreate",
        actionKey: "save-hour-12",
        inputDigest: "digest-recreate",
      });
      expect(
        Option.getOrThrow(
          yield* persistence.checkinMessages.getHourlyMessage({
            workspaceId: "workspace-1",
            messageSetGeneration: 1,
            conversationId: "running-1",
            hour: 12,
          }),
        ),
      ).toMatchObject({ template: "replacement", version: 3, updatedBy: "user-3" });
    }),
  );
});

fixtureLayer("trusted hourly check-in messages bind to the observed event", (it) => {
  it.effect("advances A to B to A without reviving the first message set", () =>
    Effect.gen(function* () {
      const { persistence } = yield* resetFixture;
      const eventB = eventStartEpochMs + 60_000;

      yield* persistence.checkinMessages.reconcileMessageSet({
        workspaceId: "workspace-1",
        observedEventStartEpochMs: eventStartEpochMs,
        expectedBinding: null,
        updatedBy: "user-1",
      });
      yield* persistence.checkinMessages.saveHourlyMessage({
        workspaceId: "workspace-1",
        ...binding,
        conversationId: "running-1",
        hour: 12,
        template: "event A generation one",
        expectedVersion: 0,
        updatedBy: "user-1",
        invocationId: "invocation-event-a-1",
        actionKey: "save-hour-12",
        inputDigest: "digest-event-a-1",
      });
      yield* persistence.checkinMessages.reconcileMessageSet({
        workspaceId: "workspace-1",
        observedEventStartEpochMs: eventB,
        expectedBinding: binding,
        updatedBy: "user-2",
      });

      const staleTransition = yield* Effect.exit(
        persistence.checkinMessages.reconcileMessageSet({
          workspaceId: "workspace-1",
          observedEventStartEpochMs: eventStartEpochMs,
          expectedBinding: binding,
          updatedBy: "stale-observer",
        }),
      );
      expectConflict(staleTransition, "CHECKIN_MESSAGE_SET_CONFLICT");
      expect(
        Option.getOrThrow(
          yield* persistence.checkinMessages.getMessageSet({
            workspaceId: "workspace-1",
          }),
        ),
      ).toMatchObject({
        eventStartEpochMs: eventB,
        messageSetGeneration: 2,
      });

      yield* persistence.checkinMessages.reconcileMessageSet({
        workspaceId: "workspace-1",
        observedEventStartEpochMs: eventStartEpochMs,
        expectedBinding: { eventStartEpochMs: eventB, messageSetGeneration: 2 },
        updatedBy: "user-3",
      });
      expect(
        Option.getOrThrow(
          yield* persistence.checkinMessages.getMessageSet({
            workspaceId: "workspace-1",
          }),
        ),
      ).toMatchObject({
        eventStartEpochMs,
        messageSetGeneration: 3,
      });
      expect(
        yield* persistence.checkinMessages.listHourlyMessages({
          workspaceId: "workspace-1",
          messageSetGeneration: 1,
          conversationId: "running-1",
        }),
      ).toHaveLength(1);
      expect(
        yield* persistence.checkinMessages.listHourlyMessages({
          workspaceId: "workspace-1",
          messageSetGeneration: 3,
          conversationId: "running-1",
        }),
      ).toEqual([]);

      const staleSave = yield* Effect.exit(
        persistence.checkinMessages.saveHourlyMessage({
          workspaceId: "workspace-1",
          ...binding,
          conversationId: "running-1",
          hour: 12,
          template: "must not revive",
          expectedVersion: 1,
          updatedBy: "stale-observer",
          invocationId: "invocation-stale-event",
          actionKey: "save-hour-12",
          inputDigest: "digest-stale-event",
        }),
      );
      expectConflict(staleSave, "CHECKIN_MESSAGE_SET_CONFLICT");
    }),
  );
});

fixtureLayer("trusted hourly check-in messages record immutable save receipts", (it) => {
  it.effect("returns the original action result without repeating its old mutation", () =>
    Effect.gen(function* () {
      const { persistence } = yield* resetFixture;
      const originalSave = {
        workspaceId: "workspace-1",
        ...binding,
        conversationId: "running-1",
        hour: 12,
        template: "original",
        expectedVersion: 0,
        updatedBy: "user-1",
        invocationId: "invocation-original",
        actionKey: "save-hour-12",
        inputDigest: "digest-original",
      } as const;

      yield* persistence.checkinMessages.reconcileMessageSet({
        workspaceId: "workspace-1",
        observedEventStartEpochMs: eventStartEpochMs,
        expectedBinding: null,
        updatedBy: "user-1",
      });
      yield* persistence.checkinMessages.saveHourlyMessage(originalSave);
      yield* persistence.checkinMessages.saveHourlyMessage({
        ...originalSave,
        template: "newer editor",
        expectedVersion: 1,
        updatedBy: "user-2",
        invocationId: "invocation-newer",
        inputDigest: "digest-newer",
      });

      yield* persistence.checkinMessages.saveHourlyMessage(originalSave);

      expect(
        Option.getOrThrow(
          yield* persistence.checkinMessages.getHourlyMessage({
            workspaceId: "workspace-1",
            messageSetGeneration: 1,
            conversationId: "running-1",
            hour: 12,
          }),
        ),
      ).toMatchObject({ template: "newer editor", version: 2, updatedBy: "user-2" });
      expect(
        Option.getOrThrow(
          yield* persistence.checkinMessages.getSaveReceipt({
            workspaceId: "workspace-1",
            invocationId: "invocation-original",
            actionKey: "save-hour-12",
          }),
        ).result,
      ).toEqual({
        workspaceId: "workspace-1",
        binding,
        message: {
          conversationId: "running-1",
          hour: 12,
          template: "original",
          version: 1,
        },
      });

      const changedReplay = yield* Effect.exit(
        persistence.checkinMessages.saveHourlyMessage({
          ...originalSave,
          template: "changed replay",
          inputDigest: "different-digest",
        }),
      );
      expectConflict(changedReplay, "CHECKIN_MESSAGE_REPLAY_CONFLICT");
    }),
  );
});

fixtureLayer("trusted hourly check-in messages serialize concurrent editors", (it) => {
  it.effect("commits exactly one save/save or save/clear race", () =>
    Effect.gen(function* () {
      const { persistence } = yield* resetFixture;
      yield* persistence.checkinMessages.reconcileMessageSet({
        workspaceId: "workspace-1",
        observedEventStartEpochMs: eventStartEpochMs,
        expectedBinding: null,
        updatedBy: "user-1",
      });
      yield* persistence.checkinMessages.saveHourlyMessage({
        workspaceId: "workspace-1",
        ...binding,
        conversationId: "running-1",
        hour: 12,
        template: "version one",
        expectedVersion: 0,
        updatedBy: "user-1",
        invocationId: "invocation-seed",
        actionKey: "save-hour-12",
        inputDigest: "digest-seed",
      });

      const raceParticipants = {
        "save-save": [
          { updatedBy: "left-save-save", identity: "left-save-save" },
          { updatedBy: "right-save-save", identity: "right-save-save" },
        ],
        "save-clear": [
          { updatedBy: "save-writer", identity: "save-clear-save" },
          { updatedBy: "clear-writer", identity: "save-clear-clear" },
        ],
      } as const;
      const race = (
        leftTemplate: string | null,
        rightTemplate: string | null,
        suffix: keyof typeof raceParticipants,
        expectedVersion: number,
      ) =>
        Effect.all(
          raceParticipants[suffix].map(({ updatedBy, identity }, index) =>
            Effect.exit(
              persistence.checkinMessages.saveHourlyMessage({
                workspaceId: "workspace-1",
                ...binding,
                conversationId: "running-1",
                hour: 12,
                template: index === 0 ? leftTemplate : rightTemplate,
                expectedVersion,
                updatedBy,
                invocationId: `invocation-${identity}`,
                actionKey: "save-hour-12",
                inputDigest: `digest-${identity}`,
              }),
            ),
          ),
          { concurrency: "unbounded" },
        );

      const saveSave = yield* race("left save", "right save", "save-save", 1);
      expect(saveSave.map(({ _tag }) => _tag).sort()).toEqual(["Failure", "Success"]);
      for (const failure of saveSave.filter(Exit.isFailure)) {
        expectConflict(failure, "CHECKIN_MESSAGE_VERSION_CONFLICT");
      }
      const saveSaveWinner = Option.getOrThrow(
        yield* persistence.checkinMessages.getHourlyMessage({
          workspaceId: "workspace-1",
          messageSetGeneration: 1,
          conversationId: "running-1",
          hour: 12,
        }),
      );
      expect(saveSaveWinner.version).toBe(2);
      expect(["left save", "right save"]).toContain(saveSaveWinner.template);

      const saveClear = yield* race("saved value", null, "save-clear", 2);
      expect(saveClear.map(({ _tag }) => _tag).sort()).toEqual(["Failure", "Success"]);
      for (const failure of saveClear.filter(Exit.isFailure)) {
        expectConflict(failure, "CHECKIN_MESSAGE_VERSION_CONFLICT");
      }
      const saveClearWinner = Option.getOrThrow(
        yield* persistence.checkinMessages.getHourlyMessage({
          workspaceId: "workspace-1",
          messageSetGeneration: 1,
          conversationId: "running-1",
          hour: 12,
        }),
      );
      expect(saveClearWinner.version).toBe(3);
      expect(["saved value", null]).toContain(saveClearWinner.template);
    }),
  );
});
