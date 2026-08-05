import type { ReadonlyJSONValue } from "@rocicorp/zero";
import { expectTypeOf, it } from "vitest";
import { schema as generatedSchema } from "sheet-zero-api/schema";
import { schema as canonicalSchema } from "./schema";

it("preserves canonical table keys and representative generated column types", () => {
  expectTypeOf<keyof typeof generatedSchema.tables>().toEqualTypeOf<
    Exclude<keyof typeof canonicalSchema.tables, "workflowCommand">
  >();
  expectTypeOf(
    generatedSchema.tables.configWorkspace.columns.workspaceId.customType,
  ).toEqualTypeOf<string>();
  expectTypeOf(
    generatedSchema.tables.configWorkspace.columns.autoCheckin.customType,
  ).toEqualTypeOf<boolean>();
  expectTypeOf(
    generatedSchema.tables.configWorkspace.columns.monitorConversationId.customType,
  ).toEqualTypeOf<string>();
  expectTypeOf(generatedSchema.tables.messageRoomOrder.columns.fills.customType).toEqualTypeOf<
    ReadonlyArray<string>
  >();
  expectTypeOf(
    generatedSchema.tables.messageTeamSubmission.columns.parsedSubmission.customType,
  ).toEqualTypeOf<ReadonlyJSONValue>();
  expectTypeOf(generatedSchema.tables.workflowRun.columns).not.toHaveProperty("executionId");
  expectTypeOf(generatedSchema.tables.workflowRun.columns).not.toHaveProperty("idempotencyKey");
  expectTypeOf(generatedSchema.tables.workflowRun.columns).not.toHaveProperty("principal");
  expectTypeOf(generatedSchema.tables.workflowRun.columns).not.toHaveProperty("input");
  expectTypeOf(generatedSchema.tables.workflowRun.columns).not.toHaveProperty("maxAttempts");
  expectTypeOf(
    generatedSchema.tables.workflowRun.columns.result.customType,
  ).toEqualTypeOf<ReadonlyJSONValue>();
  expectTypeOf(
    generatedSchema.tables.workflowRun.columns.error.customType,
  ).toEqualTypeOf<ReadonlyJSONValue>();
  expectTypeOf(generatedSchema.tables.messageTeamSubmission.primaryKey).toEqualTypeOf<
    readonly ["workspaceId", "conversationId", "messageId"]
  >();
});
