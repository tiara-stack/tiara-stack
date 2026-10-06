import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
export const syntheticDevelopmentSeedId = "synthetic-development-v1";
const ApprovedSeedBindingsSchema = Schema.Struct({
  userPrincipal: Schema.Struct({ issuer: NonEmpty, subject: NonEmpty }),
  discordAccount: Schema.Struct({ platform: Schema.Literal("discord"), userId: NonEmpty }),
  target: Schema.Struct({ guildId: NonEmpty, channelId: NonEmpty }),
});
export type ApprovedSeedBindings = typeof ApprovedSeedBindingsSchema.Type;

const SyntheticDevelopmentSeedSchema = Schema.Struct({
  id: NonEmpty,
  identity: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bindings: ApprovedSeedBindingsSchema,
  rows: Schema.Struct({
    configUserPlatform: Schema.Array(
      Schema.Struct({
        platform: Schema.Literal("discord"),
        userId: NonEmpty,
        defaultClientId: Schema.Null,
        checkinDmEnabled: Schema.Boolean,
        monitorDmEnabled: Schema.Boolean,
        createdAt: Schema.Number,
        updatedAt: Schema.Number,
        deletedAt: Schema.Null,
      }),
    ),
    configWorkspace: Schema.Array(
      Schema.Struct({
        workspaceId: NonEmpty,
        sheetId: Schema.Null,
        autoCheckin: Schema.Boolean,
        monitorConversationId: Schema.Null,
        announcementConversationId: Schema.Null,
        createdAt: Schema.Number,
        updatedAt: Schema.Number,
        deletedAt: Schema.Null,
      }),
    ),
    configWorkspaceConversation: Schema.Array(
      Schema.Struct({
        workspaceId: NonEmpty,
        conversationId: NonEmpty,
        name: NonEmpty,
        running: Schema.Boolean,
        roleId: Schema.Null,
        checkinConversationId: Schema.Null,
        createdAt: Schema.Number,
        updatedAt: Schema.Number,
        deletedAt: Schema.Null,
      }),
    ),
  }),
});
export type SyntheticDevelopmentSeed = typeof SyntheticDevelopmentSeedSchema.Type;
export interface SyntheticDevelopmentSeedReceipt {
  readonly identity: string;
  readonly inserted: boolean;
}

const identityOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Builds inert domain rows; the trusted binding resolver supplies identities and targets. */
export const makeSyntheticDevelopmentSeed = (
  id: string,
  bindings: ApprovedSeedBindings,
): Effect.Effect<SyntheticDevelopmentSeed, Error> =>
  Schema.decodeUnknownEffect(ApprovedSeedBindingsSchema)(bindings).pipe(
    Effect.mapError(() => new Error("approved-development-bindings-required")),
    Effect.map((approved) => {
      const timestamp = 1_700_000_000_000;
      return {
        id,
        identity: identityOf({ id, bindings: approved }),
        bindings: approved,
        rows: {
          configUserPlatform: [
            {
              platform: "discord" as const,
              userId: approved.discordAccount.userId,
              defaultClientId: null,
              checkinDmEnabled: false,
              monitorDmEnabled: false,
              createdAt: timestamp,
              updatedAt: timestamp,
              deletedAt: null,
            },
          ],
          configWorkspace: [
            {
              workspaceId: approved.target.guildId,
              sheetId: null,
              autoCheckin: false,
              monitorConversationId: null,
              announcementConversationId: null,
              createdAt: timestamp,
              updatedAt: timestamp,
              deletedAt: null,
            },
          ],
          configWorkspaceConversation: [
            {
              workspaceId: approved.target.guildId,
              conversationId: approved.target.channelId,
              name: "Synthetic development fixture",
              running: false,
              roleId: null,
              checkinConversationId: null,
              createdAt: timestamp,
              updatedAt: timestamp,
              deletedAt: null,
            },
          ],
        },
      };
    }),
    Effect.flatMap((seed) =>
      Schema.decodeUnknownEffect(SyntheticDevelopmentSeedSchema)(seed).pipe(
        Effect.mapError(() => new Error("invalid-synthetic-development-seed")),
      ),
    ),
  );
