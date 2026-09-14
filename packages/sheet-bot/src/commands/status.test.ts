import { describe, expect, it } from "@effect/vitest";
import { Ix } from "dfx";
import type { APIChatInputApplicationCommandInteraction } from "dfx/types";
import { InteractionToken, type CommandInteractionResponseContext } from "dfx-discord-utils/utils";
import {
  ApplicationCommandType,
  ChannelType,
  InteractionType,
  Locale,
} from "discord-api-types/v10";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { ResponseReference } from "sheet-bot-api/references";
import { workflowInvocationIdFromString } from "sheet-workflow-http-client";
import type {
  ServicesDeliverStatusInput,
  ServicesDeliverStatusReference,
  SheetWorkflowHttpClientShape,
} from "../services";
import type { BotCapabilityStoreShape } from "../services";
import { enqueueStatus } from "./status";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("opaque-response-reference");

const interaction: APIChatInputApplicationCommandInteraction = {
  id: "123456789012345678",
  application_id: "application-1",
  type: InteractionType.ApplicationCommand,
  data: {
    id: "command-1",
    name: "status",
    type: ApplicationCommandType.ChatInput,
  },
  user: {
    id: "discord-user-1",
    username: "status-user",
    discriminator: "0001",
    global_name: "status-user",
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
  guild: { id: "workspace-1", features: [], locale: Locale.EnglishUS },
};

const testLayer = Layer.mergeAll(
  InteractionToken.testLayer({
    applicationId: "application-1",
    token: "interaction-token",
  }),
  ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: "discord-main" })),
);

const makeResponse = (messages: Array<string | undefined>) =>
  ({
    editReply: ({ payload }: { readonly payload: { readonly content?: string } }) => {
      messages.push(payload.content);
      return Effect.void;
    },
  }) as Pick<CommandInteractionResponseContext, "editReply">;

describe("status command protected enqueue path", () => {
  it.effect("passes the interaction response through the bot client interface", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];
      const calls: Array<{
        readonly input: ServicesDeliverStatusInput;
        readonly clientSuppliedInvocationId:
          | ServicesDeliverStatusReference["invocationId"]
          | undefined;
      }> = [];
      const workflowClient: Pick<SheetWorkflowHttpClientShape, "enqueueServicesDeliverStatus"> = {
        enqueueServicesDeliverStatus: (input, options) => {
          const invocationId =
            options?.invocationId ??
            workflowInvocationIdFromString("123e4567-e89b-42d3-a456-426614174000");
          calls.push({ input, clientSuppliedInvocationId: options?.invocationId });
          return Effect.succeed({
            invocationId,
            contractIdentity: "services.deliverStatus",
            wireVersion: "1",
          });
        },
      };
      const capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference"> = {
        issueResponseReference: () => Effect.succeed(responseReference),
      };

      yield* enqueueStatus(makeResponse(messages), workflowClient, capabilityStore).pipe(
        Effect.provide(testLayer),
        Effect.provideService(Ix.Interaction, interaction),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toEqual({ responseReference });
      expect(calls[0]?.clientSuppliedInvocationId).toBeUndefined();
      expect(messages).toEqual([]);
    }),
  );
});
