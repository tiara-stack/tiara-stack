import { Schema } from "effect";
import { ReadonlyJSONValue } from "typhoon-zero/schema";
import { expectTypeOf, it } from "vitest";
import {
  configWorkspace,
  messageCheckin,
  messageRoomOrder,
  messageRoomOrderEntry,
  messageTeamSubmission,
  schema,
  TeamSubmissionStatus,
} from "./schema";

it("preserves concrete table columns and field schemas at the public boundary", () => {
  expectTypeOf(configWorkspace.columns).toHaveProperty("workspaceId");
  expectTypeOf(messageCheckin.columns).toHaveProperty("initialMessage");
  expectTypeOf(messageRoomOrder.columns).toHaveProperty("fills");
  expectTypeOf(messageRoomOrderEntry.columns).toHaveProperty("effectValue");
  expectTypeOf(messageTeamSubmission.columns).toHaveProperty("status");

  expectTypeOf(configWorkspace.fields.workspaceId).toEqualTypeOf<typeof Schema.String>();
  expectTypeOf(configWorkspace.fields.sheetId).toMatchTypeOf<Schema.Schema<string | null>>();
  expectTypeOf(configWorkspace.fields.autoCheckin).toMatchTypeOf<Schema.Schema<boolean | null>>();
  expectTypeOf(configWorkspace.select.fields.createdAt).toEqualTypeOf<typeof Schema.Number>();
  expectTypeOf(messageRoomOrder.fields.fills).toEqualTypeOf<Schema.$Array<typeof Schema.String>>();
  expectTypeOf(messageRoomOrderEntry.fields.effectValue).toEqualTypeOf<typeof Schema.Number>();
  expectTypeOf(messageCheckin.fields.initialMessage).toEqualTypeOf<typeof ReadonlyJSONValue>();
  expectTypeOf(messageTeamSubmission.fields.status).toEqualTypeOf<typeof TeamSubmissionStatus>();
});

it("preserves the same concrete tables through the schema map", () => {
  expectTypeOf(schema.tables.configWorkspace).toEqualTypeOf<typeof configWorkspace>();
  expectTypeOf(schema.tables.messageCheckin).toEqualTypeOf<typeof messageCheckin>();
  expectTypeOf(schema.tables.messageRoomOrderEntry).toEqualTypeOf<typeof messageRoomOrderEntry>();
  expectTypeOf(schema.tables.messageTeamSubmission).toEqualTypeOf<typeof messageTeamSubmission>();
});
