import { describe, expect, it } from "@effect/vitest";
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
import { BotDependencyUnavailable, ResponseReference } from "sheet-bot-api";
import { WorkflowTransportUnavailable } from "sheet-workflow-http-client";
import type { BotCapabilityStoreShape } from "../services";
import { enqueueSheetWorkflow } from "./sheetWorkflowMigration";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("opaque-response-reference");

const interaction: APIChatInputApplicationCommandInteraction = {
  id: "123456789012345678",
  application_id: "application-1",
  type: InteractionType.ApplicationCommand,
  data: {
    id: "command-1",
    name: "workflow-test",
    type: ApplicationCommandType.ChatInput,
  },
  user: {
    id: "discord-user-1",
    username: "workflow-user",
    discriminator: "0001",
    global_name: "workflow-user",
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
  Layer.succeed(InteractionToken, {
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

const makeCapabilityStore = (
  issueResponseReference: BotCapabilityStoreShape["issueResponseReference"] = () =>
    Effect.succeed(responseReference),
) => ({
  issueResponseReference,
});

const runEnqueue = (
  options: Omit<Parameters<typeof enqueueSheetWorkflow>[0], "response" | "capabilityStore"> & {
    readonly capabilityStore: Pick<BotCapabilityStoreShape, "issueResponseReference">;
  },
  messages: Array<string | undefined> = [],
) =>
  enqueueSheetWorkflow({
    ...options,
    response: makeResponse(messages),
  }).pipe(Effect.provide(testLayer), Effect.provideService(Ix.Interaction, interaction));

describe("direct workflow enqueue boundary", () => {
  it.effect("issues one opaque response reference and enqueues the declared input", () =>
    Effect.gen(function* () {
      let enqueuedInput: unknown;
      let enqueuedInvocationId: unknown;

      yield* runEnqueue({
        operation: "workflow test",
        workspaceId: "workspace-1",
        capabilityStore: makeCapabilityStore(),
        makeInput: (reference) => ({ responseReference: reference }),
        enqueue: (input, options) => {
          enqueuedInput = input;
          enqueuedInvocationId = options.invocationId;
          return Effect.succeed({});
        },
        rejectedMessage: "rejected",
        unauthorizedMessage: "unauthorized",
        pendingMessage: "pending",
      });

      expect(enqueuedInput).toEqual({ responseReference });
      expect(enqueuedInvocationId).toBeDefined();
    }),
  );

  it.effect("reports reference issuance failure without enqueueing", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];
      let enqueues = 0;

      yield* runEnqueue(
        {
          operation: "workflow test",
          workspaceId: "workspace-1",
          capabilityStore: makeCapabilityStore(() =>
            Effect.fail(new BotDependencyUnavailable({ message: "capability store unavailable" })),
          ),
          makeInput: (reference) => ({ responseReference: reference }),
          enqueue: () => {
            enqueues += 1;
            return Effect.succeed({});
          },
          rejectedMessage: "rejected",
          unauthorizedMessage: "unauthorized",
          pendingMessage: "pending",
        },
        messages,
      );

      expect(messages).toEqual(["rejected"]);
      expect(enqueues).toBe(0);
    }),
  );

  it.effect("reports an ambiguous enqueue without a legacy fallback", () =>
    Effect.gen(function* () {
      const messages: Array<string | undefined> = [];
      let enqueues = 0;

      yield* runEnqueue(
        {
          operation: "workflow test",
          workspaceId: "workspace-1",
          capabilityStore: makeCapabilityStore(),
          makeInput: (reference) => ({ responseReference: reference }),
          enqueue: () => {
            enqueues += 1;
            return Effect.fail(
              new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: false,
                message: "enqueue outcome is ambiguous",
              }),
            );
          },
          rejectedMessage: "rejected",
          unauthorizedMessage: "unauthorized",
          pendingMessage: "pending",
        },
        messages,
      );

      expect(messages).toEqual(["pending"]);
      expect(enqueues).toBe(1);
    }),
  );
});
