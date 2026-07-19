import type { ReadonlyJSONValue } from "@rocicorp/zero";
import { expectTypeOf, it } from "vitest";
import { schema as canonicalSchema } from "../schema";
import { schema as generatedSchema } from "./schema";

it("preserves canonical table keys and representative generated column types", () => {
  expectTypeOf<keyof typeof generatedSchema.tables>().toEqualTypeOf<
    keyof typeof canonicalSchema.tables
  >();
  expectTypeOf(
    generatedSchema.tables.configWorkspace.columns.workspaceId.customType,
  ).toEqualTypeOf<string>();
  expectTypeOf(
    generatedSchema.tables.configWorkspace.columns.autoCheckin.customType,
  ).toEqualTypeOf<boolean>();
  expectTypeOf(generatedSchema.tables.messageRoomOrder.columns.fills.customType).toEqualTypeOf<
    ReadonlyArray<string>
  >();
  expectTypeOf(
    generatedSchema.tables.messageTeamSubmission.columns.parsedSubmission.customType,
  ).toEqualTypeOf<ReadonlyJSONValue>();
  expectTypeOf(generatedSchema.tables.messageTeamSubmission.primaryKey).toEqualTypeOf<
    readonly ["workspaceId", "conversationId", "messageId"]
  >();
});
