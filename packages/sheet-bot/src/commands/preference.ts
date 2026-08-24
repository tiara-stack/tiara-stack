import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { Effect, Layer, Option, Schema } from "effect";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import type { StringOptionBuilder } from "dfx-discord-utils/utils";
import { config } from "../config";
import { prefixedUnstorageLayer } from "../discord/cache";
import {
  BotCapabilityStore,
  enqueuePreferencesDeliverStatusWorkflow,
  enqueuePreferencesUpdateAndDeliverWorkflow,
  SheetWorkflowHttpClient,
  SheetWorkflowsClient,
  SheetWorkflowsRequestContext,
  type PreferencesDeliverStatusInput,
  type PreferencesUpdateAndDeliverInput,
} from "../services";
import { makeDispatchBase } from "../utils/commandHelpers";
import { registerGlobalCommandLayer } from "../utils/registerGlobalCommandLayer";
import { enqueueSheetWorkflow } from "../utils/sheetWorkflowMigration";
import { runSheetWorkflowsDispatch } from "../utils/sheetWorkflowsDispatch";

type PreferenceDmKind = "checkin" | "monitor";

const workflowPlatform = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(
  Schema.brand("sheet-workflow-contracts/NotificationPlatform"),
);

const decodeWorkflowPlatform = (value: string) =>
  Schema.decodeUnknownEffect(workflowPlatform)(value);

const preferenceRejectedMessage = "I couldn't update your preferences. Please try again.";
const preferenceUnauthorizedMessage = "You aren't allowed to manage these preferences.";
const preferencePendingMessage =
  "Your preference update is still processing. I'll update this message when it finishes.";

const dmKindLabels = {
  checkin: "check-in DM reminders",
  monitor: "monitor DM pings",
} satisfies Record<PreferenceDmKind, string>;

const platformOption = (description: string) => (option: StringOptionBuilder) =>
  option
    .setName("platform")
    .setDescription(description)
    .addChoices({ name: "discord", value: "discord" });

const selectedPlatform = (platform: Option.Option<string>) =>
  Option.getOrElse(platform, () => "discord");

const dmKindLabel = (kind: PreferenceDmKind) => dmKindLabels[kind];

const preferenceTogglePatch = (
  kind: PreferenceDmKind,
  enabled: boolean,
  defaultClientId?: string,
) =>
  kind === "checkin"
    ? {
        checkinDmEnabled: enabled,
        ...(defaultClientId === undefined ? {} : { defaultClientId }),
      }
    : {
        monitorDmEnabled: enabled,
        ...(defaultClientId === undefined ? {} : { defaultClientId }),
      };

const makeStatusSubCommand = (kind: PreferenceDmKind) =>
  Effect.gen(function* () {
    const sheetWorkflowsClient = yield* SheetWorkflowsClient;
    const workflowClient = yield* SheetWorkflowHttpClient;
    const capabilityStore = yield* BotCapabilityStore;

    return yield* CommandHelper.makeSubCommand(
      (builder) =>
        builder
          .setName("status")
          .setDescription(`Show ${dmKindLabel(kind)} preferences`)
          .addStringOption(platformOption("The platform to inspect")),
      Effect.fn(`preference.${kind}Dm.status`)(function* (command) {
        const response = yield* InteractionResponse;
        yield* response.deferReply({ flags: MessageFlags.Ephemeral });
        const base = yield* makeDispatchBase;
        const platform = yield* decodeWorkflowPlatform(
          selectedPlatform(command.optionValueOptional("platform")),
        );

        yield* enqueueSheetWorkflow({
          response,
          operation: `the ${dmKindLabel(kind)} preference status check`,
          contractIdentity: "preferences.deliverStatus",
          contractWireVersion: "1",
          capabilityStore,
          evaluateGate: (input) =>
            workflowClient.evaluatePreferencesDeliverStatusRolloutGate(input),
          makeInput: (responseReference): PreferencesDeliverStatusInput => ({
            responseReference,
            kind,
            platform,
          }),
          enqueue: (input, options) =>
            enqueuePreferencesDeliverStatusWorkflow(workflowClient, input, options),
          dispatchLegacy: runSheetWorkflowsDispatch(
            response,
            `the ${dmKindLabel(kind)} preference status check`,
            SheetWorkflowsRequestContext.asInteractionUser(() =>
              sheetWorkflowsClient.get().dispatch.preferenceDmStatus({
                payload: { ...base, kind, platform },
              }),
            )(),
          ),
          rejectedMessage: preferenceRejectedMessage,
          unauthorizedMessage: preferenceUnauthorizedMessage,
          pendingMessage: preferencePendingMessage,
        });
      }),
    );
  });

const makeEnableSubCommand = (kind: PreferenceDmKind) =>
  Effect.gen(function* () {
    const sheetWorkflowsClient = yield* SheetWorkflowsClient;
    const workflowClient = yield* SheetWorkflowHttpClient;
    const capabilityStore = yield* BotCapabilityStore;

    return yield* CommandHelper.makeSubCommand(
      (builder) =>
        builder
          .setName("enable")
          .setDescription(`Enable ${dmKindLabel(kind)}`)
          .addStringOption(platformOption("The platform to configure"))
          .addStringOption((option) =>
            option.setName("client_id").setDescription("The bot client id to send DMs from"),
          ),
      Effect.fn(`preference.${kind}Dm.enable`)(function* (command) {
        const response = yield* InteractionResponse;
        yield* response.deferReply({ flags: MessageFlags.Ephemeral });
        const base = yield* makeDispatchBase;
        const platform = yield* decodeWorkflowPlatform(
          selectedPlatform(command.optionValueOptional("platform")),
        );
        const clientIdOption = command.optionValueOptional("client_id");
        const defaultClientId = Option.isSome(clientIdOption)
          ? clientIdOption.value
          : yield* config.sheetBotClientId;

        yield* enqueueSheetWorkflow({
          response,
          operation: `the ${dmKindLabel(kind)} preference enable update`,
          contractIdentity: "preferences.updateAndDeliver",
          contractWireVersion: "1",
          capabilityStore,
          evaluateGate: (input) =>
            workflowClient.evaluatePreferencesUpdateAndDeliverRolloutGate(input),
          makeInput: (responseReference): PreferencesUpdateAndDeliverInput => ({
            responseReference,
            platform,
            ...preferenceTogglePatch(kind, true, defaultClientId),
          }),
          enqueue: (input, options) =>
            enqueuePreferencesUpdateAndDeliverWorkflow(workflowClient, input, options),
          dispatchLegacy: runSheetWorkflowsDispatch(
            response,
            `the ${dmKindLabel(kind)} preference enable update`,
            SheetWorkflowsRequestContext.asInteractionUser(() =>
              sheetWorkflowsClient.get().dispatch.preferenceDmEnable({
                payload: { ...base, kind, platform, defaultClientId },
              }),
            )(),
          ),
          rejectedMessage: preferenceRejectedMessage,
          unauthorizedMessage: preferenceUnauthorizedMessage,
          pendingMessage: preferencePendingMessage,
        });
      }),
    );
  });

const makeDisableSubCommand = (kind: PreferenceDmKind) =>
  Effect.gen(function* () {
    const sheetWorkflowsClient = yield* SheetWorkflowsClient;
    const workflowClient = yield* SheetWorkflowHttpClient;
    const capabilityStore = yield* BotCapabilityStore;

    return yield* CommandHelper.makeSubCommand(
      (builder) =>
        builder
          .setName("disable")
          .setDescription(`Disable ${dmKindLabel(kind)}`)
          .addStringOption(platformOption("The platform to configure")),
      Effect.fn(`preference.${kind}Dm.disable`)(function* (command) {
        const response = yield* InteractionResponse;
        yield* response.deferReply({ flags: MessageFlags.Ephemeral });
        const base = yield* makeDispatchBase;
        const platform = yield* decodeWorkflowPlatform(
          selectedPlatform(command.optionValueOptional("platform")),
        );

        yield* enqueueSheetWorkflow({
          response,
          operation: `the ${dmKindLabel(kind)} preference disable update`,
          contractIdentity: "preferences.updateAndDeliver",
          contractWireVersion: "1",
          capabilityStore,
          evaluateGate: (input) =>
            workflowClient.evaluatePreferencesUpdateAndDeliverRolloutGate(input),
          makeInput: (responseReference): PreferencesUpdateAndDeliverInput => ({
            responseReference,
            platform,
            ...preferenceTogglePatch(kind, false),
          }),
          enqueue: (input, options) =>
            enqueuePreferencesUpdateAndDeliverWorkflow(workflowClient, input, options),
          dispatchLegacy: runSheetWorkflowsDispatch(
            response,
            `the ${dmKindLabel(kind)} preference disable update`,
            SheetWorkflowsRequestContext.asInteractionUser(() =>
              sheetWorkflowsClient.get().dispatch.preferenceDmDisable({
                payload: { ...base, kind, platform },
              }),
            )(),
          ),
          rejectedMessage: preferenceRejectedMessage,
          unauthorizedMessage: preferenceUnauthorizedMessage,
          pendingMessage: preferencePendingMessage,
        });
      }),
    );
  });

const makeDmKindCommandGroup = (params: {
  readonly groupName: string;
  readonly description: string;
  readonly kind: PreferenceDmKind;
}) =>
  Effect.gen(function* () {
    const statusSubCommand = yield* makeStatusSubCommand(params.kind);
    const enableSubCommand = yield* makeEnableSubCommand(params.kind);
    const disableSubCommand = yield* makeDisableSubCommand(params.kind);

    return yield* CommandHelper.makeSubCommandGroup(
      (builder) =>
        builder
          .setName(params.groupName)
          .setDescription(params.description)
          .addSubcommand(() => statusSubCommand.data)
          .addSubcommand(() => enableSubCommand.data)
          .addSubcommand(() => disableSubCommand.data),
      (command) =>
        command.subCommands({
          status: statusSubCommand.handler,
          enable: enableSubCommand.handler,
          disable: disableSubCommand.handler,
        }),
    );
  });

const makeClientSubCommand = Effect.gen(function* () {
  const sheetWorkflowsClient = yield* SheetWorkflowsClient;
  const workflowClient = yield* SheetWorkflowHttpClient;
  const capabilityStore = yield* BotCapabilityStore;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("client")
        .setDescription("Set the default DM client")
        .addStringOption((option) =>
          option
            .setName("client_id")
            .setDescription("The bot client id to send DMs from")
            .setRequired(true),
        )
        .addStringOption(platformOption("The platform to configure")),
    Effect.fn("preference.dm.client")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });
      const base = yield* makeDispatchBase;
      const platform = yield* decodeWorkflowPlatform(
        selectedPlatform(command.optionValueOptional("platform")),
      );
      const defaultClientId = command.optionValue("client_id");

      yield* enqueueSheetWorkflow({
        response,
        operation: "the DM preference client update",
        contractIdentity: "preferences.updateAndDeliver",
        contractWireVersion: "1",
        capabilityStore,
        evaluateGate: (input) =>
          workflowClient.evaluatePreferencesUpdateAndDeliverRolloutGate(input),
        makeInput: (responseReference): PreferencesUpdateAndDeliverInput => ({
          responseReference,
          platform,
          defaultClientId,
        }),
        enqueue: (input, options) =>
          enqueuePreferencesUpdateAndDeliverWorkflow(workflowClient, input, options),
        dispatchLegacy: runSheetWorkflowsDispatch(
          response,
          "the DM preference client update",
          SheetWorkflowsRequestContext.asInteractionUser(() =>
            sheetWorkflowsClient.get().dispatch.preferenceDmSetClient({
              payload: { ...base, platform, defaultClientId },
            }),
          )(),
        ),
        rejectedMessage: preferenceRejectedMessage,
        unauthorizedMessage: preferenceUnauthorizedMessage,
        pendingMessage: preferencePendingMessage,
      });
    }),
  );
});

const makeDmCommandGroup = Effect.gen(function* () {
  const clientSubCommand = yield* makeClientSubCommand;

  return yield* CommandHelper.makeSubCommandGroup(
    (builder) =>
      builder
        .setName("dm")
        .setDescription("Configure shared DM delivery settings")
        .addSubcommand(() => clientSubCommand.data),
    (command) =>
      command.subCommands({
        client: clientSubCommand.handler,
      }),
  );
});

const makePreferenceCommand = Effect.gen(function* () {
  const checkinDmCommandGroup = yield* makeDmKindCommandGroup({
    groupName: "checkin-dm",
    description: "Configure check-in DM reminders",
    kind: "checkin",
  });
  const monitorDmCommandGroup = yield* makeDmKindCommandGroup({
    groupName: "monitor-dm",
    description: "Configure monitor DM pings",
    kind: "monitor",
  });
  const dmCommandGroup = yield* makeDmCommandGroup;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("preference")
        .setDescription("Configure personal Sheet preferences")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        )
        .addSubcommandGroup(() => checkinDmCommandGroup.data)
        .addSubcommandGroup(() => monitorDmCommandGroup.data)
        .addSubcommandGroup(() => dmCommandGroup.data),
    (command) =>
      command.subCommands({
        "checkin-dm": checkinDmCommandGroup.handler,
        "monitor-dm": monitorDmCommandGroup.handler,
        dm: dmCommandGroup.handler,
      }),
  );
});

export const preferenceCommandLayer = registerGlobalCommandLayer(makePreferenceCommand).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetWorkflowHttpClient.layer,
      BotCapabilityStore.layer.pipe(Layer.provide(prefixedUnstorageLayer)),
    ),
  ),
);
