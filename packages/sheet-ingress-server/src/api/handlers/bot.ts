import { Effect, FileSystem, Predicate, Schema } from "effect";
import {
  type DiscordBotRestError,
  DiscordBotRestErrorSchema,
  makeDiscordBotRestError,
} from "dfx-discord-utils/discord/schema";
import { type Unauthorized } from "typhoon-core/error";
import { SheetBotForwardingClient } from "../../services/sheetBotForwardingClient";
import { forwardSheetBot, forwardSheetBotPayload } from "../../services/sheetBotProxy";
import { buildFileUploadFormData } from "../fileUpload";
import type { IngressHandlerTable } from "../types";

const isDiscordBotRestError = Schema.is(DiscordBotRestErrorSchema);
const isUnauthorized = (error: unknown): error is Unauthorized =>
  Predicate.isTagged("Unauthorized")(error);
const proxyErrorMessage = (error: unknown) =>
  Predicate.isObject(error) &&
  Predicate.hasProperty(error, "message") &&
  Predicate.isString(error.message)
    ? error.message
    : "Sheet bot request failed";
const mapSheetBotProxyError = (error: unknown): DiscordBotRestError | Unauthorized => {
  if (isDiscordBotRestError(error) || isUnauthorized(error)) {
    return error;
  }
  return makeDiscordBotRestError({
    message: proxyErrorMessage(error),
    status: Predicate.isTagged("ArgumentError")(error) ? 400 : undefined,
  });
};

const updateOriginalInteractionResponseWithFiles = (
  group: "bot" | "ingressBot",
  interactionToken: string,
  payload: Parameters<typeof buildFileUploadFormData>[0],
) =>
  Effect.gen(function* () {
    const client = yield* SheetBotForwardingClient;
    const fs = yield* FileSystem.FileSystem;
    const formData = yield* buildFileUploadFormData(payload, fs, interactionToken);
    return yield* client.bot.updateOriginalInteractionResponseWithFilesByPayload({
      payload: formData,
    });
  }).pipe(
    Effect.mapError(mapSheetBotProxyError),
    Effect.withSpan(`ingress.${group}.updateOriginalInteractionResponseWithFiles`),
  );

export const botHandlers = {
  bot: (handlers) =>
    handlers
      .handle(
        "createInteractionResponse",
        forwardSheetBotPayload("bot", "createInteractionResponse"),
      )
      .handle("sendMessage", forwardSheetBot("bot", "sendMessage"))
      .handle("updateMessage", forwardSheetBot("bot", "updateMessage"))
      .handle(
        "updateOriginalInteractionResponse",
        forwardSheetBot("bot", "updateOriginalInteractionResponse"),
      )
      .handle(
        "updateOriginalInteractionResponseWithFiles",
        ({ params: { interactionToken }, payload }) =>
          updateOriginalInteractionResponseWithFiles("bot", interactionToken, payload),
      )
      .handle("createPin", forwardSheetBot("bot", "createPin"))
      .handle("deleteMessage", forwardSheetBot("bot", "deleteMessage"))
      .handle("addGuildMemberRole", forwardSheetBot("bot", "addGuildMemberRole"))
      .handle("removeGuildMemberRole", forwardSheetBot("bot", "removeGuildMemberRole")),
  ingressBot: (handlers) =>
    handlers
      .handle("updateOriginalInteractionResponse", ({ payload }) =>
        Effect.gen(function* () {
          const client = yield* SheetBotForwardingClient;
          return yield* client.bot.updateOriginalInteractionResponseByPayload(payload);
        }).pipe(Effect.mapError(mapSheetBotProxyError)),
      )
      .handle("updateOriginalInteractionResponseWithFiles", ({ payload }) =>
        updateOriginalInteractionResponseWithFiles("ingressBot", payload.interactionToken, payload),
      ),
  cache: (handlers) =>
    handlers
      .handle("getGuild", forwardSheetBot("cache", "getGuild"))
      .handle("getGuildSize", forwardSheetBot("cache", "getGuildSize"))
      .handle("getChannel", forwardSheetBot("cache", "getChannel"))
      .handle("getRole", forwardSheetBot("cache", "getRole"))
      .handle("getMember", forwardSheetBot("cache", "getMember"))
      .handle("getChannelsForParent", forwardSheetBot("cache", "getChannelsForParent"))
      .handle("getRolesForParent", forwardSheetBot("cache", "getRolesForParent"))
      .handle("getMembersForParent", forwardSheetBot("cache", "getMembersForParent"))
      .handle("getChannelsForResource", forwardSheetBot("cache", "getChannelsForResource"))
      .handle("getRolesForResource", forwardSheetBot("cache", "getRolesForResource"))
      .handle("getMembersForResource", forwardSheetBot("cache", "getMembersForResource"))
      .handle("getChannelsSize", forwardSheetBot("cache", "getChannelsSize"))
      .handle("getRolesSize", forwardSheetBot("cache", "getRolesSize"))
      .handle("getMembersSize", forwardSheetBot("cache", "getMembersSize"))
      .handle("getChannelsSizeForParent", forwardSheetBot("cache", "getChannelsSizeForParent"))
      .handle("getRolesSizeForParent", forwardSheetBot("cache", "getRolesSizeForParent"))
      .handle("getMembersSizeForParent", forwardSheetBot("cache", "getMembersSizeForParent"))
      .handle("getChannelsSizeForResource", forwardSheetBot("cache", "getChannelsSizeForResource"))
      .handle("getRolesSizeForResource", forwardSheetBot("cache", "getRolesSizeForResource"))
      .handle("getMembersSizeForResource", forwardSheetBot("cache", "getMembersSizeForResource")),
} satisfies Pick<IngressHandlerTable, "bot" | "ingressBot" | "cache">;
