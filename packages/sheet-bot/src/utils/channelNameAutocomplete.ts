import { Discord, Ix, IxHelpers } from "dfx/index";
import { MembersCache } from "dfx-discord-utils/discord/cache";
import type { StringOptionBuilder } from "dfx-discord-utils/utils";
import { user as interactionUser } from "dfx-discord-utils/utils";
import { Duration, Effect, Option, Predicate, Schema } from "effect";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import { SheetZeroClient } from "../services";
import { resolveGuildId } from "./commandHelpers";

const maximumChannelNameChoices = 25;

export interface ChannelNameConversation {
  readonly name: string | null;
  readonly running: boolean | null;
}

export const channelNameOption = (description: string) => (option: StringOptionBuilder) =>
  option.setName("channel_name").setDescription(description).setAutocomplete(true);

export const makeChannelNameChoices = (
  conversations: ReadonlyArray<ChannelNameConversation>,
  query: string,
) => {
  const names = new Set<string>();
  for (const conversation of conversations) {
    if (conversation.running !== true || !Predicate.isString(conversation.name)) continue;
    const name = conversation.name.trim();
    if (name.length === 0) continue;
    names.add(name);
  }

  const normalizedQuery = query.trim().toLowerCase();
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .filter((name) => name.toLowerCase().includes(normalizedQuery))
    .slice(0, maximumChannelNameChoices)
    .map((name) => ({ name, value: name }));
};

const emptyAutocompleteResponse = () =>
  Ix.response({
    type: Discord.InteractionCallbackTypes.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices: [] },
  });

const autocompleteWorkspaceId = Effect.gen(function* () {
  const data = yield* Ix.ApplicationCommand;
  const interaction = yield* Ix.Interaction;
  const serverId = Option.flatMap(
    IxHelpers.optionValue("server_id")(
      data as Discord.APIChatInputApplicationCommandInteractionData,
    ),
    (value) => (Predicate.isString(value) ? Option.some(value) : Option.none()),
  );
  return yield* resolveGuildId(
    Option.orElse(serverId, () => Option.fromNullishOr(interaction.guild_id)),
  ).pipe(Effect.flatMap((value) => Schema.decodeUnknownEffect(WorkspaceId)(value)));
});

const makeAutocompleteResponse = (
  zeroClient: typeof SheetZeroClient.Service,
  membersCache: typeof MembersCache.Service,
) =>
  Effect.gen(function* () {
    const workspaceId = yield* autocompleteWorkspaceId;
    const user = yield* interactionUser();
    yield* membersCache.get(workspaceId, user.id);
    const query = yield* Ix.focusedOptionValue;
    const conversations = yield* zeroClient.getWorkspaceConversations(workspaceId);
    const choices = makeChannelNameChoices(conversations, Predicate.isString(query) ? query : "");
    return Ix.response({
      type: Discord.InteractionCallbackTypes.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
      data: { choices },
    });
  }).pipe(
    Effect.timeout(Duration.seconds(2)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to load channel-name autocomplete choices", cause).pipe(
        Effect.as(emptyAutocompleteResponse()),
      ),
    ),
  );

export const makeChannelNameAutocomplete = Effect.fn("sheetBot.makeChannelNameAutocomplete")(
  function* (commandName: string) {
    const zeroClient = yield* SheetZeroClient;
    const membersCache = yield* MembersCache;
    return Ix.autocomplete(
      Ix.option(commandName, "channel_name"),
      makeAutocompleteResponse(zeroClient, membersCache),
    );
  },
);
