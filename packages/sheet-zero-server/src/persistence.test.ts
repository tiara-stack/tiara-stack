import { describe, expect, it, layer } from "@effect/vitest";
import { Context, Duration, Effect, Exit, Layer, Option } from "effect";
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
    expect(Object.values(trustedSheetPersistenceCatalog).flat()).toHaveLength(76);
  });

  persistenceLayer("executes through the policy-filtered interface", (it) => {
    it.effect("exposes exactly the reviewed runtime shape", () =>
      Effect.gen(function* () {
        const { persistence } = yield* resetFixture;

        expect(Object.keys(persistence)).toEqual(Object.keys(trustedSheetPersistenceCatalog));
        for (const group of Object.keys(trustedSheetPersistenceCatalog) as Array<
          keyof typeof trustedSheetPersistenceCatalog
        >) {
          const persistedGroup = persistence[group];
          expect(persistedGroup).toBeDefined();
          expect(Object.keys(persistedGroup)).toEqual(trustedSheetPersistenceCatalog[group]);
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

    it.effect("establishes timing metadata without changing the draft or event identity", () =>
      Effect.gen(function* () {
        const { database, persistence } = yield* resetFixture;
        const initialSource = {
          kind: "legacy",
          binding: {
            status: "bound",
            expectedTitle: "Thee's Sheet Settings",
            spreadsheetId: "spreadsheet-1",
            sheetId: 1,
            layoutVersion: "legacy-settings-layout-v1",
          },
        } as const;
        const initialDraft = {
          schemaVersion: 1,
          spreadsheetId: "spreadsheet-1",
          users: {
            userIds: { sheetId: 2, startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
            userSheetNames: { sheetId: 2, startRow: 0, endRow: 1, startColumn: 1, endColumn: 2 },
          },
          teams: [],
          event: { startTimeEpochMs: 1_000 },
          schedules: [],
          runners: [],
        } as const;
        yield* database.seed({
          configWorkspaceSheet: [
            {
              workspaceId: "workspace-1",
              source: initialSource,
              legacyBinding: initialSource.binding,
              draftVersion: 3,
              baseRevisionId: "revision-1",
              baselineDigest: "legacy-baseline",
              draft: initialDraft,
              diagnostics: [],
              activeRevisionId: "revision-1",
              updatedBy: "user-1",
              createdAt: 10,
              updatedAt: 20,
              deletedAt: null,
            },
          ],
        });
        const initial = (yield* database.rows("configWorkspaceSheet"))[0];
        const referenceSource = {
          kind: "legacy",
          binding: {
            ...initialSource.binding,
            scheduleTimeReference: {
              kind: "chapter-start",
              instantEpochMs: Date.UTC(2026, 8, 9, 3),
              hour: 49,
            },
            scheduleTimeReferenceBaselineDigest: "timing-baseline",
          },
        } as const;
        const request = {
          workspaceId: "workspace-1",
          expectedDraftVersion: 3,
          expectedBaselineDigest: "timing-baseline",
          source: referenceSource,
          invocationId: "timing-reference-1",
          effectivePrincipal: { kind: "user", userId: "user-1" },
          actorProvenance: null,
        } as const;

        const staleBaseline = yield* Effect.exit(
          persistence.sheetConfiguration.establishSheetConfigurationScheduleTimeReference({
            ...request,
            expectedBaselineDigest: "stale-baseline",
          }),
        );
        expect(Exit.isFailure(staleBaseline)).toBe(true);
        expect((yield* database.rows("configWorkspaceSheet"))[0]).toEqual(initial);
        expect(yield* database.rows("auditSheetConfiguration")).toHaveLength(0);

        yield* persistence.sheetConfiguration.establishSheetConfigurationScheduleTimeReference(
          request,
        );

        const first = (yield* database.rows("configWorkspaceSheet"))[0];
        expect(first).toMatchObject({
          draftVersion: 4,
          baseRevisionId: "revision-1",
          baselineDigest: "legacy-baseline",
          activeRevisionId: "revision-1",
          draft: { schemaVersion: 2, event: { startTimeEpochMs: 1_000 } },
          source: referenceSource,
        });
        expect(first?.draft).toMatchObject({
          ...initialDraft,
          schemaVersion: 2,
        });
        expect(yield* database.rows("auditSheetConfiguration")).toHaveLength(1);

        const repeated = yield* Effect.exit(
          persistence.sheetConfiguration.establishSheetConfigurationScheduleTimeReference(request),
        );
        expect(Exit.isSuccess(repeated)).toBe(true);
        expect((yield* database.rows("configWorkspaceSheet"))[0]).toEqual(first);
        expect(yield* database.rows("auditSheetConfiguration")).toHaveLength(2);

        const afterIdempotent = (yield* database.rows("configWorkspaceSheet"))[0];
        if (afterIdempotent === undefined)
          throw new Error("Expected persisted Sheet Configuration");
        yield* persistence.sheetConfiguration.upsertSheetConfigurationDraft({
          workspaceId: "workspace-1",
          expectedDraftVersion: afterIdempotent.draftVersion,
          source: referenceSource,
          legacyBinding: referenceSource.binding,
          baseRevisionId: afterIdempotent.baseRevisionId,
          baselineDigest: afterIdempotent.baselineDigest,
          draft: afterIdempotent.draft,
          diagnostics: [],
          invocationId: "timing-reference-intervening-change",
          effectivePrincipal: { kind: "user", userId: "user-1" },
          actorProvenance: null,
        });
        const afterInterveningChange = (yield* database.rows("configWorkspaceSheet"))[0];
        expect(afterInterveningChange?.draftVersion).toBe((first?.draftVersion ?? 0) + 1);

        const changedReferenceSource = {
          ...referenceSource,
          binding: {
            ...referenceSource.binding,
            scheduleTimeReference: {
              kind: "chapter-start" as const,
              instantEpochMs: Date.UTC(2026, 8, 9, 3),
              hour: 50,
            },
          },
        } as const;
        const changedReference = yield* Effect.exit(
          persistence.sheetConfiguration.establishSheetConfigurationScheduleTimeReference({
            ...request,
            expectedDraftVersion: 4,
            source: changedReferenceSource,
          }),
        );
        expect(Exit.isFailure(changedReference)).toBe(true);
        expect((yield* database.rows("configWorkspaceSheet"))[0]).toEqual(afterInterveningChange);
        expect(yield* database.rows("auditSheetConfiguration")).toHaveLength(3);

        const staleAfterInterveningChange = yield* Effect.exit(
          persistence.sheetConfiguration.establishSheetConfigurationScheduleTimeReference(request),
        );
        expect(Exit.isFailure(staleAfterInterveningChange)).toBe(true);
        expect((yield* database.rows("configWorkspaceSheet"))[0]).toEqual(afterInterveningChange);
        expect(yield* database.rows("auditSheetConfiguration")).toHaveLength(3);
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
              workspaceId: "workspace-1",
              conversationId: "conversation-1",
              createdByUserId: "user-1",
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

    it.effect("soft-deletes the active slot state through the trusted operation", () =>
      Effect.gen(function* () {
        const { database, persistence } = yield* resetFixture;
        yield* persistence.slotState.upsertMessageSlotData({
          ...messageKey,
          day: 2,
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          createdByUserId: "user-1",
        });

        yield* persistence.slotState.removeMessageSlotData({
          clientPlatform: messageKey.clientPlatform,
          clientId: messageKey.clientId,
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          expectedMessageId: messageKey.messageId,
        });

        expect(
          Option.isNone(
            yield* persistence.slotState.getMessageSlotDataByConversation({
              clientPlatform: messageKey.clientPlatform,
              clientId: messageKey.clientId,
              workspaceId: "workspace-1",
              conversationId: "conversation-1",
            }),
          ),
        ).toBe(true);
        const rows = yield* database.rows("messageSlot");
        expect(rows).toHaveLength(1);
        expect(rows[0]?.deletedAt).toEqual(expect.any(Number));
      }),
    );

    it.effect("rejects stale slot removal and replacement bindings", () =>
      Effect.gen(function* () {
        const { persistence } = yield* resetFixture;
        yield* persistence.slotState.upsertMessageSlotData({
          ...messageKey,
          day: 2,
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          createdByUserId: "user-1",
        });

        yield* persistence.slotState.replaceMessageSlotData({
          clientPlatform: messageKey.clientPlatform,
          clientId: messageKey.clientId,
          messageId: "message-2",
          day: 3,
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          createdByUserId: "user-1",
          expectedMessageId: messageKey.messageId,
        });

        const staleRemoval = yield* Effect.exit(
          persistence.slotState.removeMessageSlotData({
            clientPlatform: messageKey.clientPlatform,
            clientId: messageKey.clientId,
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            expectedMessageId: messageKey.messageId,
          }),
        );

        expect(staleRemoval._tag).toBe("Failure");
        expect(
          yield* persistence.slotState.getMessageSlotDataByConversation({
            clientPlatform: messageKey.clientPlatform,
            clientId: messageKey.clientId,
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
          }),
        ).toMatchObject({
          _tag: "Some",
          value: { messageId: "message-2", day: 3 },
        });
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

    it.effect("binds room-order state only when the canonical message is absent", () =>
      Effect.gen(function* () {
        const { database, persistence } = yield* resetFixture;
        const initial = {
          ...messageKey,
          data: {
            previousFills: ["old-a"],
            fills: ["new-a"],
            hour: 14,
            rank: 0,
            tentative: false,
            monitor: "monitor-1",
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            createdByUserId: "author-1",
          },
          entries: [{ rank: 0, position: 0, hour: 14, team: "A", tags: ["x"], effectValue: 1.5 }],
        } as const;
        yield* persistence.roomOrderState.bindMessageRoomOrderIfAbsent(initial);
        yield* persistence.roomOrderState.bindMessageRoomOrderIfAbsent({
          ...initial,
          data: { ...initial.data, hour: 99 },
          entries: [{ rank: 0, position: 0, hour: 99, team: "conflict", tags: [], effectValue: 9 }],
        });

        expect(yield* database.rows("messageRoomOrder")).toHaveLength(1);
        expect((yield* database.rows("messageRoomOrder"))[0]).toMatchObject({
          hour: 14,
          tentative: false,
        });
        expect(yield* database.rows("messageRoomOrderEntry")).toEqual([
          expect.objectContaining({ hour: 14, team: "A", effectValue: 1.5 }),
        ]);

        yield* database.reset;
        yield* database.seed({
          messageRoomOrder: [
            {
              ...messageKey,
              ...initial.data,
              sendClaimId: null,
              sendClaimedAt: null,
              sentMessageId: null,
              sentConversationId: null,
              sentAt: null,
              tentativeUpdateClaimId: null,
              tentativeUpdateClaimedAt: null,
              tentativePinClaimId: null,
              tentativePinClaimedAt: null,
              tentativePinnedAt: null,
              createdAt: 100,
              updatedAt: 200,
              deletedAt: 300,
            },
          ],
          messageRoomOrderEntry: [
            {
              ...messageKey,
              ...initial.entries[0],
              createdAt: 100,
              updatedAt: 200,
              deletedAt: null,
            },
          ],
        });

        yield* persistence.roomOrderState.bindMessageRoomOrderIfAbsent({
          ...initial,
          data: { ...initial.data, hour: 99 },
          entries: [{ rank: 0, position: 0, hour: 99, team: "conflict", tags: [], effectValue: 9 }],
        });

        expect(yield* database.rows("messageRoomOrder")).toHaveLength(1);
        expect((yield* database.rows("messageRoomOrder"))[0]).toMatchObject({
          hour: 14,
          deletedAt: 300,
        });
        expect(yield* database.rows("messageRoomOrderEntry")).toEqual([
          expect.objectContaining({ hour: 14, team: "A", effectValue: 1.5 }),
        ]);
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
