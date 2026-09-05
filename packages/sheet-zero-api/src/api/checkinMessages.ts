import type {
  DefaultSchema as RocicorpSchema,
  ReadonlyJSONValue as ZeroReadonlyJSONValue,
  Transaction,
} from "@rocicorp/zero";
import { Schema } from "effect";
import { makeArgumentError } from "typhoon-core/error";
import { ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import { zeroTableAccess } from "../accessors";
import { activeRecord } from "../timestamps";
import type { SheetZeroApiSuccessSchemas } from "./successSchemas";

const messageSetConflictCode = "CHECKIN_MESSAGE_SET_CONFLICT";
const messageVersionConflictCode = "CHECKIN_MESSAGE_VERSION_CONFLICT";
const messageReplayConflictCode = "CHECKIN_MESSAGE_REPLAY_CONFLICT";
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const messageSetBinding = Schema.Struct({
  eventStartEpochMs: Schema.Int,
  messageSetGeneration: PositiveInt,
});

const messageKey = {
  workspaceId: Schema.String,
  messageSetGeneration: PositiveInt,
  conversationId: Schema.String,
  hour: NonNegativeInt,
} as const;

const saveIdentity = {
  invocationId: Schema.String,
  actionKey: Schema.String,
} as const;

const saveHourlyMessageRequest = Schema.Struct({
  ...messageKey,
  eventStartEpochMs: Schema.Int,
  template: Schema.NullOr(Schema.String),
  expectedVersion: NonNegativeInt,
  updatedBy: Schema.String,
  ...saveIdentity,
  inputDigest: Schema.String,
});
type SaveHourlyMessageRequest = typeof saveHourlyMessageRequest.Type;
type CheckinMessagesTransaction = Transaction<RocicorpSchema, unknown>;

const bindingEquals = (
  binding: { readonly eventStartEpochMs: number; readonly messageSetGeneration: number },
  expected: { readonly eventStartEpochMs: number; readonly messageSetGeneration: number } | null,
) =>
  expected !== null &&
  binding.eventStartEpochMs === expected.eventStartEpochMs &&
  binding.messageSetGeneration === expected.messageSetGeneration;

const normalizeSavedTemplate = (template: string | null): string | null =>
  template === null || template.trim().length === 0 ? null : template;

const messageSetConflict = () =>
  makeArgumentError("The hourly check-in message set changed", {
    code: messageSetConflictCode,
  });

const getActiveMessageSet = async (tx: CheckinMessagesTransaction, workspaceId: string) =>
  activeRecord(
    await tx.run(
      zeroTableAccess.configWorkspaceCheckinMessageSet.table
        .where("workspaceId", "=", workspaceId)
        .one(),
    ),
  );

const getActiveHourlyMessage = async (
  tx: CheckinMessagesTransaction,
  key: Pick<
    SaveHourlyMessageRequest,
    "workspaceId" | "messageSetGeneration" | "conversationId" | "hour"
  >,
) =>
  activeRecord(
    await tx.run(
      zeroTableAccess.configWorkspaceCheckinMessage.table
        .where("workspaceId", "=", key.workspaceId)
        .where("messageSetGeneration", "=", key.messageSetGeneration)
        .where("conversationId", "=", key.conversationId)
        .where("hour", "=", key.hour)
        .one(),
    ),
  );

const getActiveSaveReceipt = async (
  tx: CheckinMessagesTransaction,
  identity: Pick<SaveHourlyMessageRequest, "invocationId" | "actionKey">,
) =>
  activeRecord(
    await tx.run(
      zeroTableAccess.configWorkspaceCheckinMessageMutationReceipt.table
        .where("invocationId", "=", identity.invocationId)
        .where("actionKey", "=", identity.actionKey)
        .one(),
    ),
  );

const validateReplay = (
  receipt: NonNullable<Awaited<ReturnType<typeof getActiveSaveReceipt>>>,
  args: SaveHourlyMessageRequest,
) => {
  if (receipt.workspaceId === args.workspaceId && receipt.inputDigest === args.inputDigest) return;
  throw makeArgumentError("The hourly check-in message action was replayed with different input", {
    code: messageReplayConflictCode,
  });
};

const validateSaveBinding = (
  current: Awaited<ReturnType<typeof getActiveMessageSet>>,
  args: SaveHourlyMessageRequest,
) => {
  if (current !== undefined && bindingEquals(current, args)) return current;
  throw messageSetConflict();
};

const nextMessageRow = (
  args: SaveHourlyMessageRequest,
  existing: Awaited<ReturnType<typeof getActiveHourlyMessage>>,
) => {
  const currentVersion = existing?.version ?? 0;
  if (currentVersion !== args.expectedVersion) {
    throw makeArgumentError(
      `Hourly check-in message version conflict: expected ${args.expectedVersion}, found ${currentVersion}`,
      { code: messageVersionConflictCode },
    );
  }
  return zeroTableAccess.configWorkspaceCheckinMessage.upsertWithTimestamps(
    {
      workspaceId: args.workspaceId,
      messageSetGeneration: args.messageSetGeneration,
      conversationId: args.conversationId,
      hour: args.hour,
      template: normalizeSavedTemplate(args.template),
      version: currentVersion + 1,
      createdBy: existing?.createdBy ?? args.updatedBy,
      updatedBy: args.updatedBy,
      deletedAt: null,
    },
    existing,
  );
};

const saveResult = (
  args: SaveHourlyMessageRequest,
  currentBinding: NonNullable<Awaited<ReturnType<typeof getActiveMessageSet>>>,
  row: ReturnType<typeof nextMessageRow>,
): ZeroReadonlyJSONValue => ({
  workspaceId: args.workspaceId,
  binding: {
    eventStartEpochMs: currentBinding.eventStartEpochMs,
    messageSetGeneration: currentBinding.messageSetGeneration,
  },
  message: {
    conversationId: args.conversationId,
    hour: args.hour,
    template: row.template,
    version: row.version,
  },
});

const persistSaveReceipt = async (
  tx: CheckinMessagesTransaction,
  args: SaveHourlyMessageRequest,
  result: ZeroReadonlyJSONValue,
) =>
  tx.mutate.configWorkspaceCheckinMessageMutationReceipt.upsert(
    zeroTableAccess.configWorkspaceCheckinMessageMutationReceipt.upsertWithTimestamps({
      invocationId: args.invocationId,
      actionKey: args.actionKey,
      workspaceId: args.workspaceId,
      inputDigest: args.inputDigest,
      result,
      createdBy: args.updatedBy,
      deletedAt: null,
    }),
  );

const saveHourlyMessage = async (
  tx: CheckinMessagesTransaction,
  args: SaveHourlyMessageRequest,
) => {
  const receipt = await getActiveSaveReceipt(tx, args);
  if (receipt !== undefined) return validateReplay(receipt, args);

  const currentBinding = validateSaveBinding(await getActiveMessageSet(tx, args.workspaceId), args);
  const row = nextMessageRow(args, await getActiveHourlyMessage(tx, args));
  await tx.mutate.configWorkspaceCheckinMessage.upsert(row);
  await persistSaveReceipt(tx, args, saveResult(args, currentBinding, row));
};

export const makeCheckinMessagesGroup = <const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
) =>
  ZeroApiGroup.make("checkinMessages").add(
    ZeroApiEndpoint.query("getMessageSet", {
      visibility: "service",
      request: Schema.Struct({ workspaceId: Schema.String }),
      success: success.checkinMessages.getMessageSet,
      query: ({ args: { workspaceId } }) =>
        zeroTableAccess.configWorkspaceCheckinMessageSet.getActiveByPrimaryKey(
          zeroTableAccess.configWorkspaceCheckinMessageSet.table,
          { workspaceId },
        ),
    }),
    ZeroApiEndpoint.query("getHourlyMessage", {
      visibility: "service",
      request: Schema.Struct(messageKey),
      success: success.checkinMessages.getHourlyMessage,
      query: ({ args }) =>
        zeroTableAccess.configWorkspaceCheckinMessage.getActiveByPrimaryKey(
          zeroTableAccess.configWorkspaceCheckinMessage.table,
          args,
        ),
    }),
    ZeroApiEndpoint.query("listHourlyMessages", {
      visibility: "service",
      request: Schema.Struct({
        workspaceId: Schema.String,
        messageSetGeneration: Schema.Int,
        conversationId: Schema.String,
      }),
      success: success.checkinMessages.listHourlyMessages,
      query: ({ args }) =>
        zeroTableAccess.configWorkspaceCheckinMessage.listActiveWhere(
          zeroTableAccess.configWorkspaceCheckinMessage.table
            .where("workspaceId", "=", args.workspaceId)
            .where("messageSetGeneration", "=", args.messageSetGeneration)
            .where("conversationId", "=", args.conversationId)
            .orderBy("hour", "asc"),
        ),
    }),
    ZeroApiEndpoint.query("getSaveReceipt", {
      visibility: "service",
      request: Schema.Struct({ workspaceId: Schema.String, ...saveIdentity }),
      success: success.checkinMessages.getSaveReceipt,
      query: ({ args }) =>
        zeroTableAccess.configWorkspaceCheckinMessageMutationReceipt
          .listActiveWhere(
            zeroTableAccess.configWorkspaceCheckinMessageMutationReceipt.table
              .where("workspaceId", "=", args.workspaceId)
              .where("invocationId", "=", args.invocationId)
              .where("actionKey", "=", args.actionKey),
          )
          .one(),
    }),
    ZeroApiEndpoint.mutator("reconcileMessageSet", {
      visibility: "service",
      request: Schema.Struct({
        workspaceId: Schema.String,
        observedEventStartEpochMs: Schema.Int,
        expectedBinding: Schema.NullOr(messageSetBinding),
        updatedBy: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const existing = await getActiveMessageSet(tx, args.workspaceId);

        if (existing === undefined) {
          if (args.expectedBinding !== null) {
            throw messageSetConflict();
          }
          await tx.mutate.configWorkspaceCheckinMessageSet.upsert(
            zeroTableAccess.configWorkspaceCheckinMessageSet.upsertWithTimestamps({
              workspaceId: args.workspaceId,
              eventStartEpochMs: args.observedEventStartEpochMs,
              messageSetGeneration: 1,
              updatedBy: args.updatedBy,
              deletedAt: null,
            }),
          );
          return;
        }

        if (!bindingEquals(existing, args.expectedBinding)) {
          throw messageSetConflict();
        }
        if (existing.eventStartEpochMs === args.observedEventStartEpochMs) return;

        await tx.mutate.configWorkspaceCheckinMessageSet.upsert(
          zeroTableAccess.configWorkspaceCheckinMessageSet.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              eventStartEpochMs: args.observedEventStartEpochMs,
              messageSetGeneration: existing.messageSetGeneration + 1,
              updatedBy: args.updatedBy,
              deletedAt: null,
            },
            existing,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("saveHourlyMessage", {
      visibility: "service",
      request: saveHourlyMessageRequest,
      mutator: ({ tx, args }) => saveHourlyMessage(tx, args),
    }),
  );

export type CheckinMessagesGroup<SuccessSchemas extends SheetZeroApiSuccessSchemas> = ReturnType<
  typeof makeCheckinMessagesGroup<SuccessSchemas>
>;
