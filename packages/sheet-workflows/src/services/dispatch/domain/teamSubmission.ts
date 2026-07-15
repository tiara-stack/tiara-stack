import { Duration, Effect, Option, Predicate, Schedule } from "effect";
import * as Sheet from "sheet-ingress-api/schemas/sheet";
import type {
  TeamListDispatchPayload,
  TeamListDispatchResult,
  TeamSubmissionDispatchPayload,
  TeamSubmissionDispatchResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import { makeUnknownError } from "typhoon-core/error";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { teamSubmissionConfirmationActionRow } from "../../messageComponents";
import { SheetApisClient } from "../../sheetApisClient";
import { makeSheetApisServices } from "../clients/sheetApis";
import { makeDeliveryNonce } from "../pure/deliveryNonce";
import { boundEmbedDescription, escapeMarkdown, makeEmbed } from "../pure/rendering";
import {
  ignoreDiscordCleanupFailure,
  removeTeamSubmissionReaction,
  teamSubmissionErrorColor,
  teamSubmissionReaction,
} from "./teamSubmissionCommon";

const teamSubmissionConfirmationsFeatureFlag = "team-submission-confirmations";
const teamSubmissionProgressColor = 0xfee75c;
const teamSubmissionSuccessColor = 0x57f287;
const discordEmbedCharacterLimit = 6_000;
const discordEmbedFieldCountLimit = 25;
const discordEmbedFieldNameLimit = 256;
const discordEmbedFieldValueLimit = 1_024;

type TeamListField = {
  readonly name: string;
  readonly value: string;
};

const truncateWithEllipsis = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

/** @internal */
export const boundTeamListFields = (
  fields: ReadonlyArray<TeamListField>,
  title: string,
): ReadonlyArray<TeamListField> => {
  const boundedFields = fields.map(({ name, value }) => ({
    name: truncateWithEllipsis(name, discordEmbedFieldNameLimit),
    value: truncateWithEllipsis(value, discordEmbedFieldValueLimit),
  }));
  const totalLength = boundedFields.reduce(
    (length, field) => length + field.name.length + field.value.length,
    title.length,
  );
  if (
    boundedFields.length <= discordEmbedFieldCountLimit &&
    totalLength <= discordEmbedCharacterLimit
  ) {
    return boundedFields;
  }

  const visibleFields: Array<TeamListField> = [];
  let visibleLength = title.length;
  for (const field of boundedFields) {
    const remainingCount = boundedFields.length - visibleFields.length;
    const overflowField = {
      name: "More teams",
      value: `${remainingCount} additional ${remainingCount === 1 ? "team was" : "teams were"} omitted.`,
    };
    const nextLength = field.name.length + field.value.length;
    const overflowLength = overflowField.name.length + overflowField.value.length;
    if (
      visibleFields.length >= discordEmbedFieldCountLimit - 1 ||
      visibleLength + nextLength + overflowLength > discordEmbedCharacterLimit
    ) {
      return [...visibleFields, overflowField];
    }
    visibleFields.push(field);
    visibleLength += nextLength;
  }
  return visibleFields;
};

const boundConfirmationDescription = (description: string): string => {
  const overflowSummary = "\n\n… Additional team details omitted to fit Discord limits.";
  return boundEmbedDescription(description, overflowSummary);
};

type SheetApisServices = ReturnType<typeof makeSheetApisServices>;
type TeamSubmissionDeliveryClient = ReturnType<(typeof ClientDeliveryClient.Service)["forClient"]>;

const recoverTeamSubmissionFailure = <E>({
  deliveryClient,
  description,
  error,
  logMessage,
  payload,
  progressMessageId,
  title,
}: {
  readonly deliveryClient: TeamSubmissionDeliveryClient;
  readonly description: string;
  readonly error: E;
  readonly logMessage: string;
  readonly payload: TeamSubmissionDispatchPayload;
  readonly progressMessageId: string;
  readonly title: string;
}) =>
  Effect.gen(function* () {
    yield* removeTeamSubmissionReaction(deliveryClient, payload);
    yield* deliveryClient
      .updateMessage(payload.conversationId, progressMessageId, {
        embeds: [makeEmbed({ title, description, color: teamSubmissionErrorColor })],
        components: [],
        allowedMentions: "none",
      })
      .pipe(ignoreDiscordCleanupFailure(logMessage));
    return yield* Effect.fail(error);
  });

export const makeTeamSubmissionOperations = ({
  botClient,
  playerService,
  sheetApisClient,
  workspaceConfigService,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly playerService: SheetApisServices["playerService"];
  readonly sheetApisClient: typeof SheetApisClient.Service;
  readonly workspaceConfigService: SheetApisServices["workspaceConfigService"];
}) => {
  const setConfirmationMessage = (
    payload: TeamSubmissionDispatchPayload,
    confirmationMessageId: string,
  ) =>
    sheetApisClient
      .get()
      .teamSubmission.setConfirmationMessage({
        payload: {
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          confirmationMessageId,
        },
      })
      .pipe(
        Effect.retry({
          schedule: Schedule.spaced(Duration.seconds(1)),
          times: 2,
        }),
      );

  return {
    teamList: Effect.fn("DispatchService.teamList")(function* (payload: TeamListDispatchPayload) {
      const teams = yield* playerService.getTeamsByIds(payload.workspaceId, [payload.targetUserId]);
      const formattedTeams = teams
        .flat()
        // Exclude "tierer_hint" entries: these are internal/temporary suggestions used by the
        // tiering process and should not be shown to users in the public team list.
        .filter((team) => !team.tags.includes("tierer_hint"))
        .sort((left, right) => {
          const leftName = Option.getOrElse(left.playerName, () => "");
          const rightName = Option.getOrElse(right.playerName, () => "");
          return (
            leftName.localeCompare(rightName) ||
            Sheet.Team.getEffectValue(right) - Sheet.Team.getEffectValue(left)
          );
        })
        .flatMap((team) =>
          Option.match(team.teamName, {
            onNone: () => [],
            onSome: (teamName) => [
              {
                teamName,
                tags: team.tags,
                lead: `${team.lead}`,
                backline: `${team.backline}`,
                talent: Option.match(team.talent, {
                  onSome: (talent) => `${talent}k`,
                  onNone: () => undefined,
                }),
                effectValue: `(+${Sheet.Team.getEffectValue(team)}%)`,
              },
            ],
          }),
        );

      const title = truncateWithEllipsis(
        `${escapeMarkdown(payload.targetUsername)}'s Teams`,
        discordEmbedFieldNameLimit,
      );
      const fields = boundTeamListFields(
        formattedTeams.map((team) => ({
          name: escapeMarkdown(team.teamName),
          value: [
            `Tags: ${team.tags.length === 0 ? "None" : escapeMarkdown(team.tags.join(", "))}`,
            `ISV: ${[team.lead, team.backline, team.talent].filter(Boolean).join("/")} ${
              team.effectValue
            }`,
          ].join("\n"),
        })),
        title,
      );

      yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
        embeds: [
          makeEmbed({
            title,
            description: formattedTeams.length === 0 ? "No teams found" : null,
            fields,
          }),
        ],
      });

      return {
        workspaceId: payload.workspaceId,
        targetUserId: payload.targetUserId,
        teamCount: formattedTeams.length,
      } satisfies TeamListDispatchResult;
    }),
    teamSubmission: Effect.fn("DispatchService.teamSubmission")(function* (
      payload: TeamSubmissionDispatchPayload,
    ) {
      yield* Effect.annotateCurrentSpan({
        workspaceId: payload.workspaceId,
        conversationId: payload.conversationId,
        messageId: payload.messageId,
      });
      const deliveryClient = botClient.forClient(payload.client);
      const featureFlags = yield* workspaceConfigService.getWorkspaceFeatureFlags(
        payload.workspaceId,
      );
      const confirmationsEnabled = featureFlags.some(
        (flag) => flag.flagName === teamSubmissionConfirmationsFeatureFlag,
      );

      if (!confirmationsEnabled) {
        const result = yield* sheetApisClient.get().teamSubmission.upsertFromDiscord({ payload });
        const confirmationPayload = {
          content: result.confirmationText,
          allowedMentions: "none" as const,
        };
        const confirmationSendPayload = {
          ...confirmationPayload,
          nonce: makeDeliveryNonce(`team-submission-confirmation:${payload.messageId}`),
          enforceNonce: true,
        };
        const confirmation = yield* Option.match(result.confirmationMessage, {
          onSome: (message) =>
            deliveryClient
              .updateMessage(
                message.conversation.conversationId,
                message.messageId,
                confirmationPayload,
              )
              .pipe(
                Effect.catchIf(Predicate.isTagged("DiscordBotNotFoundError"), () =>
                  deliveryClient.sendMessage(payload.conversationId, confirmationSendPayload),
                ),
              ),
          onNone: () => deliveryClient.sendMessage(payload.conversationId, confirmationSendPayload),
        }).pipe(
          Effect.catch((error) =>
            Effect.fail(
              markInteractionFailureHandled(
                makeUnknownError(
                  "Teams were added, but Tiara could not deliver the confirmation message. Please check the sheet.",
                  error,
                ),
              ),
            ),
          ),
        );

        const updatedResult = yield* setConfirmationMessage(payload, confirmation.id).pipe(
          Effect.catch((error) =>
            deliveryClient
              .updateMessage(payload.conversationId, confirmation.id, {
                content:
                  "Teams were added, but confirmation tracking failed. Please retry the command.",
                components: [],
                allowedMentions: "none",
              })
              .pipe(
                ignoreDiscordCleanupFailure(
                  "Failed to mark untracked team submission confirmation",
                ),
                Effect.andThen(Effect.fail(error)),
              ),
          ),
        );

        return updatedResult satisfies TeamSubmissionDispatchResult;
      }

      const sourceMessage = {
        conversation: {
          workspace: { client: payload.client, workspaceId: payload.workspaceId },
          conversationId: payload.conversationId,
        },
        messageId: payload.messageId,
      };
      const progressMessage = yield* deliveryClient.sendMessage(payload.conversationId, {
        embeds: [
          makeEmbed({
            title: "Adding teams to the sheet",
            description: "Tiara is parsing this submission and writing the teams now.",
            color: teamSubmissionProgressColor,
          }),
        ],
        messageReference: { message: sourceMessage, failIfNotExists: false },
        allowedMentions: "none",
        nonce: makeDeliveryNonce(`team-submission-progress:${payload.messageId}`),
        enforceNonce: true,
      });
      const result = yield* Effect.gen(function* () {
        yield* deliveryClient
          .addMessageReaction(payload.conversationId, payload.messageId, teamSubmissionReaction)
          .pipe(ignoreDiscordCleanupFailure("Failed to add team submission reaction"));
        return yield* sheetApisClient.get().teamSubmission.upsertFromDiscord({ payload });
      }).pipe(
        Effect.catch((error) =>
          recoverTeamSubmissionFailure({
            deliveryClient,
            description: "Tiara could not write this submission to the sheet.",
            error,
            logMessage: "Failed to update team submission failure reply",
            payload,
            progressMessageId: progressMessage.id,
            title: "Could not add teams",
          }),
        ),
      );

      const addedTeams =
        result.parsedTeams.length === 0
          ? "No teams were registered."
          : result.parsedTeams
              .map(
                (team) =>
                  `• ${escapeMarkdown(team.playerName)} - ${escapeMarkdown(team.teamName)} (${team.teamType})`,
              )
              .join("\n");
      const skippedTeams =
        result.skippedTeams.length === 0
          ? ""
          : `\n\nSkipped:\n${result.skippedTeams
              .map((team) => `• ${escapeMarkdown(team.teamName)} - ${escapeMarkdown(team.reason)}`)
              .join("\n")}`;

      const updatedResult = yield* Effect.gen(function* () {
        const confirmation = yield* deliveryClient.updateMessage(
          payload.conversationId,
          progressMessage.id,
          {
            embeds: [
              makeEmbed({
                title: "Teams added to the sheet",
                description: boundConfirmationDescription(`${addedTeams}${skippedTeams}`),
                color: teamSubmissionSuccessColor,
              }),
            ],
            components: [teamSubmissionConfirmationActionRow()],
            allowedMentions: "none",
          },
        );

        return yield* setConfirmationMessage(payload, confirmation.id);
      }).pipe(
        Effect.catch((error) =>
          recoverTeamSubmissionFailure({
            deliveryClient,
            description:
              "Tiara wrote the teams to the sheet, but could not finish the confirmation controls.",
            error,
            logMessage: "Failed to update team submission confirmation failure reply",
            payload,
            progressMessageId: progressMessage.id,
            title: "Teams added, but confirmation failed",
          }),
        ),
      );

      return updatedResult satisfies TeamSubmissionDispatchResult;
    }),
  };
};
