import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { messageRoomOrder, messageRoomOrderEntry, messageSlot } from "./models";

type VariantWithFields = Schema.Codec<unknown, unknown> & {
  readonly fields: Record<string, unknown>;
};

describe("sheet-db-schema model exports", () => {
  it("exposes Effect model variants from precise model exports", () => {
    for (const model of [messageRoomOrder, messageRoomOrderEntry, messageSlot]) {
      expect(model.insert).toBeDefined();
      expect(model.update).toBeDefined();
      expect(model.json).toBeDefined();
      expect(model.jsonCreate).toBeDefined();
      expect(model.jsonUpdate).toBeDefined();
      expect(model.fields).toBeDefined();
    }
  });

  it("accepts app-generated timestamps in insert and update variants", () => {
    const messageSlotInsert = messageSlot.insert as VariantWithFields;
    const messageRoomOrderEntryUpdate = messageRoomOrderEntry.update as VariantWithFields;

    expect(
      Schema.decodeUnknownSync(messageSlotInsert)({
        messageId: "message-1",
        day: 1,
        guildId: "guild-1",
        messageChannelId: "channel-1",
        createdByUserId: "user-1",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_100,
        deletedAt: null,
      }),
    ).toMatchObject({
      messageId: "message-1",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
    });

    expect(
      Schema.decodeUnknownSync(messageRoomOrderEntryUpdate)({
        messageId: "message-1",
        rank: 1,
        position: 2,
        hour: 20,
        team: "team-1",
        tags: ["tag-1"],
        effectValue: 3,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_100,
        deletedAt: null,
      }),
    ).toMatchObject({
      messageId: "message-1",
      rank: 1,
      position: 2,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
    });
  });

  it("omits app-generated timestamps from JSON write variants", () => {
    const jsonCreate = messageSlot.jsonCreate as VariantWithFields;
    const jsonUpdate = messageSlot.jsonUpdate as VariantWithFields;

    expect(Object.keys(jsonCreate.fields)).not.toContain("createdAt");
    expect(Object.keys(jsonCreate.fields)).not.toContain("updatedAt");
    expect(Object.keys(jsonUpdate.fields)).not.toContain("createdAt");
    expect(Object.keys(jsonUpdate.fields)).not.toContain("updatedAt");
  });
});
