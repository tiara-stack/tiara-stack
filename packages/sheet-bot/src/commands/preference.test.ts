import { expect, layer } from "@effect/vitest";
import { Ix } from "dfx";
import type { APIChatInputApplicationCommandInteraction } from "dfx/types";
import { InteractionToken } from "dfx-discord-utils/utils";
import {
  ApplicationCommandType,
  ChannelType,
  InteractionType,
  Locale,
} from "discord-api-types/v10";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import type { CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import { ResponseReference } from "sheet-bot-api/references";
import type {
  BotCapabilityStoreShape,
  SheetWorkflowHttpClientShape,
  SheetWorkflowsClientShape,
} from "../services";
import { enqueuePreferenceStatus } from "./preference";

const replacementRolloutGateDecision = {
  gateKey: "gate-key",
  revision: 1,
  matched: true,
  executionPath: "replacement" as const,
  reason: "replacement-enabled",
};

const preferenceTestLayer = Layer.mergeAll(
  Layer.succeed(InteractionToken, {
    applicationId: "application-1",
    token: "interaction-token",
  }),
  ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: "discord-main" })),
);

const interaction: APIChatInputApplicationCommandInteraction = {
  id: "123456789012345678",
  application_id: "application-1",
  type: InteractionType.ApplicationCommand,
  data: {
    id: "command-1",
    name: "preference",
    type: ApplicationCommandType.ChatInput,
  },
  user: {
    id: "discord-user-1",
    username: "preference-user",
    discriminator: "0001",
    global_name: "preference-user",
    avatar: null,
  },
  channel_id: "channel-1",
  channel: { id: "channel-1", type: ChannelType.GuildText },
  token: "interaction-token",
  version: 1,
  app_permissions: "0",
  locale: Locale.EnglishUS,
  entitlements: [],
  authorizing_integration_owners: {},
  attachment_size_limit: 8_000_000,
  guild: { id: "123456789012345678", features: [], locale: Locale.EnglishUS },
};

const responseReference = Schema.decodeUnknownSync(ResponseReference)("opaque-response-reference");

const response = {
  editReply: () => Effect.void,
} as Pick<CommandInteractionResponseContext, "editReply">;

const sheetWorkflowsClient = {
  get: () => ({
    dispatch: {
      preferenceDmStatus: () => Effect.succeed({}),
    },
  }),
} as unknown as SheetWorkflowsClientShape;

layer(preferenceTestLayer)("preference command workflow enqueue", (it) => {
  it.effect("passes a guild interaction as the Rollout Gate workspace scope", () =>
    Effect.gen(function* () {
      let evaluatedWorkspaceId: string | undefined;
      let issuedWorkspaceId: string | undefined;
      let replacementEnqueued = false;
      const capabilityStore = {
        issueResponseReference: (input: { readonly workspaceId?: string }) => {
          issuedWorkspaceId = input.workspaceId;
          return Effect.succeed(responseReference);
        },
      } as unknown as Pick<BotCapabilityStoreShape, "issueResponseReference">;
      const workflowClient = {
        evaluatePreferencesDeliverStatusRolloutGate: (input: { readonly workspaceId?: string }) => {
          evaluatedWorkspaceId = input.workspaceId;
          return Effect.succeed(replacementRolloutGateDecision);
        },
        enqueuePreferencesDeliverStatus: () => {
          replacementEnqueued = true;
          return Effect.succeed({});
        },
      } as unknown as Pick<
        SheetWorkflowHttpClientShape,
        "enqueuePreferencesDeliverStatus" | "evaluatePreferencesDeliverStatusRolloutGate"
      >;

      yield* enqueuePreferenceStatus(
        response,
        workflowClient,
        sheetWorkflowsClient,
        capabilityStore,
        "checkin",
        undefined,
      ).pipe(Effect.provideService(Ix.Interaction, interaction));

      expect(evaluatedWorkspaceId).toBe("123456789012345678");
      expect(issuedWorkspaceId).toBe("123456789012345678");
      expect(replacementEnqueued).toBe(true);
    }),
  );
});
