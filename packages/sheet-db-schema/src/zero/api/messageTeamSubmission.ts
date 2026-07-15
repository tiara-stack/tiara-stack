import { Predicate, Schema } from "effect";
import { ReadonlyJSONValue } from "typhoon-zero/schema";
import { ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import { TeamSubmissionStatus } from "../../teamSubmissionStatus";
import { zeroTableAccess } from "../accessors";
import { preserveOmitted } from "../timestamps";
import type { SheetZeroApiSuccessSchemas } from "./successSchemas";

export const makeMessageTeamSubmissionGroup = <
  const SuccessSchemas extends SheetZeroApiSuccessSchemas,
>(
  success: SuccessSchemas,
) =>
  ZeroApiGroup.make("messageTeamSubmission").add(
    ZeroApiEndpoint.query("getMessageTeamSubmission", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        conversationId: Schema.String,
        messageId: Schema.String,
      }),
      success: success.messageTeamSubmission.getMessageTeamSubmission,
      query: ({ args: { workspaceId, conversationId, messageId } }) =>
        zeroTableAccess.messageTeamSubmission.getActiveByPrimaryKey(
          zeroTableAccess.messageTeamSubmission.table,
          {
            workspaceId,
            conversationId,
            messageId,
          },
        ),
    }),
    ZeroApiEndpoint.query("getMessageTeamSubmissionByDiscordMessage", {
      request: Schema.Struct({
        discordGuildId: Schema.String,
        discordChannelId: Schema.String,
        messageId: Schema.String,
      }),
      success: success.messageTeamSubmission.getMessageTeamSubmissionByDiscordMessage,
      query: ({ args: { discordGuildId, discordChannelId, messageId } }) =>
        zeroTableAccess.messageTeamSubmission
          .listActiveWhere(
            zeroTableAccess.messageTeamSubmission.table
              .where("discordGuildId", "=", discordGuildId)
              .where("discordChannelId", "=", discordChannelId)
              .where("messageId", "=", messageId),
          )
          .one(),
    }),
    ZeroApiEndpoint.mutator("upsertMessageTeamSubmission", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        conversationId: Schema.String,
        messageId: Schema.String,
        clientPlatform: Schema.String,
        clientId: Schema.String,
        discordGuildId: Schema.String,
        discordChannelId: Schema.String,
        discordAuthorId: Schema.String,
        sheetId: Schema.String,
        confirmationMessageId: Schema.optional(Schema.NullOr(Schema.String)),
        parsedSubmission: ReadonlyJSONValue,
        rowMappings: ReadonlyJSONValue,
        rollbackSnapshot: Schema.optional(Schema.NullOr(ReadonlyJSONValue)),
        status: TeamSubmissionStatus,
      }),
      mutator: async ({ tx, args }) => {
        const existingSubmission = await tx.run(
          zeroTableAccess.messageTeamSubmission.table
            .where("workspaceId", "=", args.workspaceId)
            .where("conversationId", "=", args.conversationId)
            .where("messageId", "=", args.messageId)
            .one(),
        );

        await tx.mutate.messageTeamSubmission.upsert(
          zeroTableAccess.messageTeamSubmission.upsertWithTimestamps(
            {
              workspaceId: args.workspaceId,
              conversationId: args.conversationId,
              messageId: args.messageId,
              clientPlatform: args.clientPlatform,
              clientId: args.clientId,
              discordGuildId: args.discordGuildId,
              discordChannelId: args.discordChannelId,
              discordAuthorId: args.discordAuthorId,
              sheetId: args.sheetId,
              confirmationMessageId: preserveOmitted(
                args.confirmationMessageId,
                existingSubmission?.confirmationMessageId,
              ),
              parsedSubmission: args.parsedSubmission,
              rowMappings: args.rowMappings,
              rollbackSnapshot: preserveOmitted(
                args.rollbackSnapshot,
                existingSubmission?.rollbackSnapshot,
              ),
              version: Predicate.isNotNullish(existingSubmission)
                ? existingSubmission.version + 1
                : 1,
              status: args.status,
              deletedAt: null,
            },
            existingSubmission,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("setMessageTeamSubmissionConfirmation", {
      request: Schema.Struct({
        workspaceId: Schema.String,
        conversationId: Schema.String,
        messageId: Schema.String,
        confirmationMessageId: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageTeamSubmission.update(
          zeroTableAccess.messageTeamSubmission.updateWithTimestamp({
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
            messageId: args.messageId,
            confirmationMessageId: args.confirmationMessageId,
          }),
        ),
    }),
  );

export type MessageTeamSubmissionGroup<SuccessSchemas extends SheetZeroApiSuccessSchemas> =
  ReturnType<typeof makeMessageTeamSubmissionGroup<SuccessSchemas>>;
