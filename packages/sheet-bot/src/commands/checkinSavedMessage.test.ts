import { Ix } from "dfx";
import { CommandHelper as DfxCommandHelper } from "dfx/Interactions/commandHelper";
import type { APIChatInputApplicationCommandInteraction } from "dfx/types";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandHelper,
  InteractionResponse,
  type CommandInteractionResponseContext,
  SubCommandBuilder,
} from "dfx-discord-utils/utils";
import { Unstorage } from "dfx-discord-utils/discord/cache";
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  InteractionType,
  Locale,
} from "discord-api-types/v10";
import { Deferred, Duration, Effect, Fiber, Option, Predicate, Stream } from "effect";
import type { CheckinMessagesLoadWorkflow, SheetWorkflowHttpClientShape } from "../services";
import { CheckinMessagesLoad } from "sheet-workflow-contracts";
import { workflowInvocationIdFromString } from "sheet-workflow-http-client";
import {
  makeSavedMessageSubCommandData,
  makeSavedMessageSubCommandWithClient,
  terminalRun,
} from "./checkinSavedMessage";

describe("saved check-in message command", () => {
  it("places the required hour option before optional options", () => {
    const data = makeSavedMessageSubCommandData(new SubCommandBuilder()).toJSON();

    expect(data.options?.map((option) => option.name)).toEqual([
      "hour",
      "channel_name",
      "server_id",
    ]);
    expect(
      data.options?.map((option) =>
        Predicate.hasProperty(option, "required") ? option.required === true : false,
      ),
    ).toEqual([true, false, false]);
  });

  it.effect("acknowledges before waiting for the workflow", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = [];
        const enqueueStarted = yield* Deferred.make<void>();
        const commandOptions = [
          {
            type: ApplicationCommandOptionType.Integer,
            name: "hour",
            value: 49,
          },
          {
            type: ApplicationCommandOptionType.String,
            name: "channel_name",
            value: "g1",
          },
        ] as const;
        const interaction: APIChatInputApplicationCommandInteraction = {
          id: "123456789012345678",
          application_id: "application-1",
          type: InteractionType.ApplicationCommand,
          data: {
            id: "command-1",
            name: "checkin",
            type: ApplicationCommandType.ChatInput,
            options: [
              {
                type: ApplicationCommandOptionType.Subcommand,
                name: "saved",
                options: [...commandOptions],
              },
            ],
          },
          user: {
            id: "123456789012345679",
            username: "test-user",
            discriminator: "0001",
            global_name: "test-user",
            avatar: null,
          },
          channel_id: "123456789012345681",
          channel: { id: "123456789012345681", type: ChannelType.GuildText },
          token: "interaction-token",
          version: 1,
          app_permissions: "0",
          locale: Locale.EnglishUS,
          entitlements: [],
          authorizing_integration_owners: {},
          attachment_size_limit: 8_000_000,
          guild: { id: "123456789012345680", features: [], locale: Locale.EnglishUS },
        };
        const commandHelper = CommandHelper.wrapCommandHelper(new DfxCommandHelper(interaction));
        const loadReference = {
          invocationId: workflowInvocationIdFromString("123e4567-e89b-42d3-a456-426614174000"),
          contractIdentity: CheckinMessagesLoad.identity,
          wireVersion: CheckinMessagesLoad.wireVersion,
        } satisfies Effect.Success<ReturnType<CheckinMessagesLoadWorkflow["enqueue"]>>;
        const workflowClient = {
          checkinMessagesLoad: {
            enqueue: () =>
              Effect.gen(function* () {
                events.push("enqueue");
                yield* Deferred.succeed(enqueueStarted, undefined);
                return loadReference;
              }),
            get: () => Stream.never,
            list: () => Stream.never,
          },
        } satisfies Pick<SheetWorkflowHttpClientShape, "checkinMessagesLoad">;
        const response: CommandInteractionResponseContext = {
          getAcknowledgementState: Effect.succeed("none"),
          reply: () => Effect.die("reply should not be called"),
          showModal: () => Effect.die("showModal should not be called"),
          replyWithFiles: () => Effect.die("replyWithFiles should not be called"),
          deferReply: () =>
            Effect.sync(() => {
              events.push("defer");
              return true;
            }),
          followUp: () => Effect.die("followUp should not be called"),
          editReply: () => Effect.die("editReply should not be called"),
          editReplyWithFiles: () => Effect.die("editReplyWithFiles should not be called"),
          respondWithError: () => Effect.die("respondWithError should not be called"),
          awaitInitialResponse: Effect.never,
        };
        const storage = yield* Unstorage;
        const subCommand = yield* makeSavedMessageSubCommandWithClient(workflowClient, storage);
        const fiber = yield* subCommand
          .handler(commandHelper)
          .pipe(
            Effect.provideService(InteractionResponse, response),
            Effect.provideService(Ix.Interaction, interaction),
            Effect.forkScoped,
          );

        yield* Deferred.await(enqueueStarted);
        expect(events).toEqual(["defer", "enqueue"]);
        yield* Fiber.interrupt(fiber);
      }),
    ).pipe(Effect.provide(Unstorage.memoryLayer)),
  );

  it.effect("polls one-shot workflow snapshots until a terminal result", () =>
    Effect.gen(function* () {
      let observationCount = 0;
      const pending = { result: { _tag: "Pending", phase: "Queued" } } as const;
      const success = { result: { _tag: "Success", value: "loaded" } } as const;

      const observed = yield* terminalRun(
        () => {
          observationCount += 1;
          return Stream.succeed(Option.some(observationCount === 1 ? pending : success));
        },
        Duration.seconds(1),
        Duration.zero,
      );

      expect(observed).toEqual(success);
      expect(observationCount).toBe(2);
    }),
  );
});
