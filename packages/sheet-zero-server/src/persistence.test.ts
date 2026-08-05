import { describe, expect, it, layer } from "@effect/vitest";
import { Context, Duration, Effect, Layer, Option } from "effect";
import { makeTestSheetZeroDatabase } from "sheet-db-schema/testdb";
import { makeTrustedSheetPersistence, trustedSheetPersistenceCatalog } from "./persistence";

const messageKey = {
  clientPlatform: "discord",
  clientId: "client-1",
  messageId: "message-1",
} as const;

class PersistenceFixture extends Context.Service<PersistenceFixture>()("PersistenceFixture", {
  make: Effect.gen(function* () {
    const database = yield* makeTestSheetZeroDatabase();
    const persistence = yield* makeTrustedSheetPersistence(database.executor);
    return { database, persistence };
  }),
}) {}

const PersistenceFixtureLayer = Layer.effect(PersistenceFixture, PersistenceFixture.make);
const persistenceLayer = layer(PersistenceFixtureLayer, { timeout: Duration.seconds(30) });

const resetFixture = Effect.gen(function* () {
  const fixture = yield* PersistenceFixture;
  yield* fixture.database.reset;
  return fixture;
});

describe("trusted Sheet persistence policy", () => {
  it("pins the reviewed operation count", () => {
    expect(Object.values(trustedSheetPersistenceCatalog).flat()).toHaveLength(53);
  });

  persistenceLayer("executes through the policy-filtered interface", (it) => {
    it.effect("exposes exactly the reviewed runtime shape", () =>
      Effect.gen(function* () {
        const { persistence } = yield* resetFixture;

        expect(Object.keys(persistence)).toEqual(Object.keys(trustedSheetPersistenceCatalog));
        for (const group of Object.keys(trustedSheetPersistenceCatalog) as Array<
          keyof typeof trustedSheetPersistenceCatalog
        >) {
          expect(Object.keys(persistence[group])).toEqual(trustedSheetPersistenceCatalog[group]);
        }
        expect("runs" in persistence).toBe(false);
        expect("executor" in persistence).toBe(false);
        expect("queries" in persistence).toBe(false);
        expect("mutators" in persistence).toBe(false);
      }),
    );

    it.effect("persists and removes a check-in with its members atomically", () =>
      Effect.gen(function* () {
        const { database, persistence } = yield* resetFixture;

        yield* persistence.checkinState.persistMessageCheckin({
          ...messageKey,
          data: {
            initialMessage: [{ type: "text", text: "hello" }],
            hour: 12,
            runningConversationId: "running-1",
            roleId: null,
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            createdByUserId: "author-1",
          },
          memberIds: ["member-1", "member-2"],
        });

        expect(
          Option.isSome(
            (yield* persistence.checkinState.getMessageCheckinData(
              messageKey,
            )) as Option.Option<unknown>,
          ),
        ).toBe(true);
        expect(yield* persistence.checkinState.getMessageCheckinMembers(messageKey)).toHaveLength(
          2,
        );
        expect(yield* database.rows("messageCheckin")).toHaveLength(1);
        expect(yield* database.rows("messageCheckinMember")).toHaveLength(2);

        yield* persistence.checkinState.removeMessageCheckin(messageKey);

        expect(
          Option.isNone(
            (yield* persistence.checkinState.getMessageCheckinData(
              messageKey,
            )) as Option.Option<unknown>,
          ),
        ).toBe(true);
        expect(yield* persistence.checkinState.getMessageCheckinMembers(messageKey)).toEqual([]);
      }),
    );

    it.effect("preserves an existing conditional member check-in", () =>
      Effect.gen(function* () {
        const { database, persistence } = yield* resetFixture;
        yield* persistence.checkinState.persistMessageCheckin({
          ...messageKey,
          data: {
            initialMessage: [],
            hour: 12,
            runningConversationId: "running-1",
            workspaceId: null,
            conversationId: null,
            createdByUserId: null,
          },
          memberIds: ["member-1"],
        });

        yield* persistence.checkinState.setMessageCheckinMemberCheckinAtIfUnset({
          ...messageKey,
          memberId: "member-1",
          checkinAt: 100,
          checkinClaimId: "claim-1",
        });
        yield* persistence.checkinState.setMessageCheckinMemberCheckinAtIfUnset({
          ...messageKey,
          memberId: "member-1",
          checkinAt: 200,
          checkinClaimId: "claim-2",
        });

        expect((yield* database.rows("messageCheckinMember"))[0]).toMatchObject({
          checkinAt: 100,
          checkinClaimId: "claim-1",
        });
      }),
    );

    it.effect("revives soft-deleted state through the trusted operation", () =>
      Effect.gen(function* () {
        const { database, persistence } = yield* resetFixture;
        yield* database.seed({
          messageSlot: [
            {
              ...messageKey,
              day: 1,
              workspaceId: null,
              conversationId: null,
              createdByUserId: null,
              createdAt: 100,
              updatedAt: 200,
              deletedAt: 300,
            },
          ],
        });

        yield* persistence.slotState.upsertMessageSlotData({
          ...messageKey,
          day: 2,
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          createdByUserId: "user-1",
        });

        expect((yield* database.rows("messageSlot"))[0]).toMatchObject({
          day: 2,
          workspaceId: "workspace-1",
          deletedAt: null,
        });
        expect((yield* database.rows("messageSlot"))[0]?.createdAt).not.toBe(100);
      }),
    );

    it.effect("persists room-order state and preserves lease outcomes", () =>
      Effect.gen(function* () {
        const { database, persistence } = yield* resetFixture;
        yield* persistence.roomOrderState.persistMessageRoomOrder({
          ...messageKey,
          data: {
            previousFills: ["old-a"],
            fills: ["new-a"],
            hour: 14,
            rank: 2,
            tentative: true,
            monitor: "monitor-1",
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            createdByUserId: "author-1",
          },
          entries: [
            { rank: 2, position: 0, hour: 14, team: "A", tags: ["x"], effectValue: 1.5 },
            { rank: 2, position: 1, hour: 15, team: "B", tags: ["y"], effectValue: 2.5 },
          ],
        });

        expect(yield* database.rows("messageRoomOrder")).toHaveLength(1);
        expect(yield* database.rows("messageRoomOrderEntry")).toHaveLength(2);

        yield* persistence.roomOrderState.claimMessageRoomOrderSend({
          ...messageKey,
          claimId: "claim-1",
        });
        yield* persistence.roomOrderState.releaseMessageRoomOrderSendClaim({
          ...messageKey,
          claimId: "wrong-claim",
        });
        expect((yield* database.rows("messageRoomOrder"))[0]?.sendClaimId).toBe("claim-1");
        yield* persistence.roomOrderState.completeMessageRoomOrderSend({
          ...messageKey,
          claimId: "claim-1",
          sentMessageId: "sent-1",
          sentConversationId: "conversation-2",
          sentAt: 1_700_000_000_000,
        });
        expect((yield* database.rows("messageRoomOrder"))[0]).toMatchObject({
          sendClaimId: null,
          sentMessageId: "sent-1",
          sentConversationId: "conversation-2",
          sentAt: 1_700_000_000_000,
        });
      }),
    );

    it.effect("rejects invalid atomic room-order input without writing a parent row", () =>
      Effect.gen(function* () {
        const { database, persistence } = yield* resetFixture;
        const exit = yield* Effect.exit(
          persistence.roomOrderState.persistMessageRoomOrder({
            ...messageKey,
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
              { rank: 2, position: 0, hour: 15, team: "B", tags: [], effectValue: 2 },
            ],
          }),
        );

        expect(exit._tag).toBe("Failure");
        expect(yield* database.rows("messageRoomOrder")).toEqual([]);
        expect(yield* database.rows("messageRoomOrderEntry")).toEqual([]);
      }),
    );

    it.effect("rolls back the parent when a later room-order entry write fails", () =>
      Effect.gen(function* () {
        const { database, persistence } = yield* resetFixture;
        const exit = yield* Effect.exit(
          persistence.roomOrderState.persistMessageRoomOrder({
            ...messageKey,
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
                // Intentionally exceeds the rank column's integer range to trigger this write failure.
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

        expect(exit._tag).toBe("Failure");
        expect(yield* database.rows("messageRoomOrder")).toEqual([]);
        expect(yield* database.rows("messageRoomOrderEntry")).toEqual([]);
      }),
    );
  });
});
