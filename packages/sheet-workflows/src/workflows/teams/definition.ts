import { Effect, Predicate, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";
import { makeAction } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { BotOutboundMessage, RespondReceipt } from "sheet-bot-api";
import { escapeMarkdown, makeEmbed } from "sheet-message-content/rendering";
import { InteractiveDeclaredFailure, TeamsDeliverList } from "sheet-workflow-contracts";
import {
  decodeWorkflowContractInputOrDie,
  workflowContractExecutionSchema,
} from "../shared/execution";
import {
  authorizeInteractiveWorkflow as authorize,
  preserveInteractiveDeclaredFailure as preserveDeclaredFailure,
} from "../shared/interactive";
import {
  boundTeamListFields,
  discordEmbedFieldNameLimit,
  truncateWithEllipsis,
} from "../shared/teamListRendering";
import { teamSheetWorkflowDefinitionVersion } from "./catalog";
import { makeTeamDeliveryKey } from "./keys";
import { UserTeamsView } from "./schema";
import { TeamWorkflowOperations } from "./service";

const effectValue = ({ backline, lead }: UserTeamsView["teams"][number]): number =>
  lead + (backline - lead) / 5;

export const selectUserTeams = (
  view: UserTeamsView,
  targetUserId: string,
): UserTeamsView["teams"] => {
  const accountIdsByName = new Map<string, Set<string>>();
  for (const player of view.players) {
    const accountIds = accountIdsByName.get(player.name) ?? new Set<string>();
    accountIds.add(player.accountId);
    accountIdsByName.set(player.name, accountIds);
  }
  const aliases = new Set(
    view.players.flatMap(({ accountId, name }) => {
      const accountIds = accountIdsByName.get(name);
      return accountId === targetUserId &&
        Predicate.isNotUndefined(accountIds) &&
        accountIds.size === 1
        ? [name]
        : [];
    }),
  );
  return view.teams
    .filter(({ playerName, tags }) => aliases.has(playerName) && !tags.includes("tierer_hint"))
    .sort(
      (left, right) =>
        left.playerName.localeCompare(right.playerName, "en") ||
        effectValue(right) - effectValue(left),
    );
};

export const makeTeamsDeliverListMessage = (
  targetUsername: string,
  teams: UserTeamsView["teams"],
): typeof BotOutboundMessage.Type => {
  const title = truncateWithEllipsis(
    `${escapeMarkdown(targetUsername)}'s Teams`,
    discordEmbedFieldNameLimit,
  );
  const fields = boundTeamListFields(
    teams.map((team) => ({
      name: escapeMarkdown(team.teamName),
      value: [
        `Tags: ${team.tags.length === 0 ? "None" : escapeMarkdown(team.tags.join(", "))}`,
        `ISV: ${[
          `${team.lead}`,
          `${team.backline}`,
          Predicate.isNull(team.talent) ? undefined : `${team.talent}k`,
        ]
          .filter(Predicate.isNotUndefined)
          .join("/")} (+${effectValue(team)}%)`,
      ].join("\n"),
    })),
    title,
  );
  return {
    embeds: [
      makeEmbed({
        title,
        description: teams.length === 0 ? "No teams found" : null,
        fields,
      }),
    ],
  };
};

const name = workflowContractKey(TeamsDeliverList);
const actionName = TeamsDeliverList.identity;
const executionSchema = workflowContractExecutionSchema(TeamsDeliverList);
const responseExecutionSchema = Schema.Struct({
  ...executionSchema.fields,
  message: BotOutboundMessage,
});

export const executeTeamsDeliverListLoadAction = (execution: typeof executionSchema.Type) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(TeamsDeliverList, execution));
    const operations = yield* TeamWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(TeamsDeliverList, execution.input);
    return yield* preserveDeclaredFailure(operations.loadUserTeams(input));
  });

export const executeTeamsDeliverListRespondAction = (
  execution: typeof responseExecutionSchema.Type,
) =>
  Effect.gen(function* () {
    yield* preserveDeclaredFailure(authorize(TeamsDeliverList, execution));
    const operations = yield* TeamWorkflowOperations;
    const input = yield* decodeWorkflowContractInputOrDie(TeamsDeliverList, execution.input);
    return yield* preserveDeclaredFailure(
      operations.respond(
        input,
        execution.message,
        makeTeamDeliveryKey(TeamsDeliverList, execution.invocationId, "respond"),
        TeamsDeliverList.authorizationPolicy.policy,
      ),
    );
  });

const TeamsDeliverListLoadAction = makeAction({
  name: `${actionName}.load-user-teams`,
  version: teamSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: executionSchema,
  success: UserTeamsView,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeTeamsDeliverListLoadAction,
});

const TeamsDeliverListRespondAction = makeAction({
  name: `${actionName}.respond`,
  version: teamSheetWorkflowDefinitionVersion,
  shardGroup: "dispatch",
  input: responseExecutionSchema,
  success: RespondReceipt,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
  execute: executeTeamsDeliverListRespondAction,
});

const TeamsDeliverListWorkflow = Workflow.make({
  name,
  payload: executionSchema,
  success: TeamsDeliverList.success,
  error: InteractiveDeclaredFailure,
  idempotencyKey: ({ invocationId }) => invocationId,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export const makeTeamsDeliverListWorkflowBody = <E, R>(actions: {
  readonly load: (execution: typeof executionSchema.Type) => Effect.Effect<UserTeamsView, E, R>;
  readonly respond: (
    execution: typeof responseExecutionSchema.Type,
  ) => Effect.Effect<typeof RespondReceipt.Type, E, R>;
}) =>
  Effect.fnUntraced(function* (execution: typeof executionSchema.Type) {
    const input = yield* decodeWorkflowContractInputOrDie(TeamsDeliverList, execution.input);
    const view = yield* actions.load(execution);
    const teams = selectUserTeams(view, input.targetUserId);
    const message = makeTeamsDeliverListMessage(input.targetUsername, teams);
    const receipt = yield* actions.respond({ ...execution, message });
    return {
      workspaceId: input.workspaceId,
      targetUserId: input.targetUserId,
      teamCount: teams.length,
      deliveryReceipts: [receipt],
    };
  });

export const makeTeamsDeliverListDefinition = () => ({
  contract: TeamsDeliverList,
  workflow: TeamsDeliverListWorkflow,
  actions: [TeamsDeliverListLoadAction, TeamsDeliverListRespondAction],
  workflowLayer: TeamsDeliverListWorkflow.toLayer(
    makeTeamsDeliverListWorkflowBody({
      load: (execution) => TeamsDeliverListLoadAction.await(execution),
      respond: (execution) => TeamsDeliverListRespondAction.await(execution),
    }),
  ),
});
