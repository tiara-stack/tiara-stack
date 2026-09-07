import { Discord, Ix } from "dfx/index";
import { ModalSubmitData } from "dfx/Interactions/context";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { Cause, Exit } from "effect";
import { Duration, Effect, Option, Predicate, Schema, Stream } from "effect";
import {
  CheckinMessageExpectedVersion,
  CheckinMessageScheduleHour,
  CheckinMessageSetBinding,
  CheckinMessagesLoad,
  CheckinMessagesSave,
  WorkspaceId,
} from "sheet-workflow-contracts";
import {
  CommandHelper,
  InteractionResponse,
  MessageComponentInteractionResponse,
  makeForkedMessageComponentHandler,
  makeButtonData,
  makeMessageActionRowData,
  provideInteractionResponse,
  provideInteractionToken,
  type CommandInteractionResponseContext,
  type SubCommandBuilder,
} from "dfx-discord-utils/utils";
import { Unstorage } from "dfx-discord-utils/discord/cache";
import {
  CheckinMessagesLoadWorkflow,
  CheckinMessagesSaveWorkflow,
  SheetWorkflowHttpClient,
  SheetWorkflowHttpRequestContext,
  type SheetWorkflowHttpClientShape,
} from "../services";
import { resolveChannelId, resolveGuildId } from "../utils/commandHelpers";

const savedMessageModalPrefix = "checkin:saved:";
const savedMessageEditButtonPrefix = "checkin:saved:edit:";
const savedMessageEditSessionPrefix = "checkin:saved:edit-session:";
const savedMessageFieldId = "template";
const savedMessageLoadTimeout = Duration.seconds(20);
const savedMessageSaveTimeout = Duration.seconds(45);
const workflowObservationInitialPollInterval = Duration.millis(250);
const workflowObservationMaxPollInterval = Duration.seconds(2);
const savedMessageEditSessionTtlSeconds = 10 * 60;
const savedMessageEditSessionReadTimeout = Duration.seconds(1);

type CheckinMessagesLoadInput = Schema.Schema.Type<typeof CheckinMessagesLoad.input>;
type CheckinMessagesSaveInput = Schema.Schema.Type<typeof CheckinMessagesSave.input>;

const SavedMessageModalState = Schema.Struct({
  workspaceId: WorkspaceId,
  conversationId: Schema.String,
  hour: CheckinMessageScheduleHour,
  eventStartEpochMs: Schema.Int,
  messageSetGeneration: CheckinMessageSetBinding.fields.messageSetGeneration,
  expectedVersion: CheckinMessageExpectedVersion,
});
type SavedMessageModalState = typeof SavedMessageModalState.Type;

type TerminalWorkflowRun = { readonly result: { readonly _tag: string } };

class CheckinSavedMessageCommandError extends Schema.TaggedErrorClass<CheckinSavedMessageCommandError>()(
  "CheckinSavedMessageCommandError",
  { message: Schema.String },
) {}

const SavedMessageEditSessionId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
type SavedMessageEditSessionId = typeof SavedMessageEditSessionId.Type;

const SavedMessageEditSession = Schema.Struct({
  state: SavedMessageModalState,
  template: Schema.NullOr(Schema.String),
});
type SavedMessageEditSession = typeof SavedMessageEditSession.Type;

const makeSavedMessageModalId = (state: SavedMessageModalState): string =>
  [
    savedMessageModalPrefix.slice(0, -1),
    state.workspaceId,
    state.conversationId,
    state.hour,
    state.eventStartEpochMs,
    state.messageSetGeneration,
    state.expectedVersion,
  ].join(":");

const decodeSavedMessageModalId = (value: string): Option.Option<SavedMessageModalState> => {
  if (!value.startsWith(savedMessageModalPrefix)) return Option.none();
  const [
    namespace,
    kind,
    workspaceId,
    conversationId,
    hour,
    eventStartEpochMs,
    messageSetGeneration,
    expectedVersion,
  ] = value.split(":");
  if (`${namespace}:${kind}:` !== savedMessageModalPrefix) return Option.none();
  return Schema.decodeUnknownOption(SavedMessageModalState)({
    workspaceId,
    conversationId,
    hour: Number(hour),
    eventStartEpochMs: Number(eventStartEpochMs),
    messageSetGeneration: Number(messageSetGeneration),
    expectedVersion: Number(expectedVersion),
  });
};

const savedMessageEditSessionKey = (sessionId: SavedMessageEditSessionId) =>
  `${savedMessageEditSessionPrefix}${sessionId}`;

const saveSavedMessageEditSession = (
  storage: typeof Unstorage.Service,
  session: SavedMessageEditSession,
): Effect.Effect<SavedMessageEditSessionId, CheckinSavedMessageCommandError> => {
  const sessionId = Schema.decodeUnknownSync(SavedMessageEditSessionId)(crypto.randomUUID());
  return Effect.tryPromise({
    try: () =>
      storage.setItem(savedMessageEditSessionKey(sessionId), session, {
        ttl: savedMessageEditSessionTtlSeconds,
      }),
    catch: () =>
      new CheckinSavedMessageCommandError({
        message: "Could not prepare the check-in message editor. Try again.",
      }),
  }).pipe(Effect.as(sessionId));
};

const loadSavedMessageEditSession = (
  storage: typeof Unstorage.Service,
  sessionId: SavedMessageEditSessionId,
): Effect.Effect<SavedMessageEditSession, CheckinSavedMessageCommandError> =>
  Effect.tryPromise({
    try: () => storage.getItem<unknown>(savedMessageEditSessionKey(sessionId)),
    catch: () =>
      new CheckinSavedMessageCommandError({
        message: "Could not load the check-in message editor. Open it again.",
      }),
  }).pipe(
    Effect.flatMap((stored) =>
      Predicate.isNull(stored)
        ? Effect.fail(
            new CheckinSavedMessageCommandError({
              message: "This check-in message editor has expired. Run the command again.",
            }),
          )
        : Schema.decodeUnknownEffect(SavedMessageEditSession)(stored).pipe(
            Effect.mapError(
              () =>
                new CheckinSavedMessageCommandError({
                  message: "This check-in message editor is invalid. Run the command again.",
                }),
            ),
          ),
    ),
  );

const removeSavedMessageEditSession = (
  storage: typeof Unstorage.Service,
  sessionId: SavedMessageEditSessionId,
) => Effect.tryPromise(() => storage.removeItem(savedMessageEditSessionKey(sessionId)));

const deferSavedMessageCommand = (
  response: Pick<CommandInteractionResponseContext, "deferReply">,
) => response.deferReply({ flags: MessageFlags.Ephemeral });

const nextWorkflowObservationPollInterval = (current: Duration.Duration) =>
  Duration.min(Duration.times(current, 2), workflowObservationMaxPollInterval);

const observeTerminalRun = <Run extends TerminalWorkflowRun>(
  get: () => Stream.Stream<Option.Option<Run>, unknown, never>,
  pollInterval: Duration.Duration,
): Effect.Effect<Run, unknown> =>
  get().pipe(
    Stream.filter((run): run is Option.Some<Run> => Option.isSome(run)),
    Stream.map((run) => run.value),
    Stream.takeUntil((run) => !Predicate.isTagged("Pending")(run.result)),
    Stream.runLast,
    Effect.flatMap((observed) => {
      const pollAgain = Effect.sleep(pollInterval).pipe(
        Effect.flatMap(() =>
          Effect.suspend(() =>
            observeTerminalRun(get, nextWorkflowObservationPollInterval(pollInterval)),
          ),
        ),
      );
      return Option.match(observed, {
        onNone: () => pollAgain,
        onSome: (run) =>
          Predicate.isTagged("Pending")(run.result) ? pollAgain : Effect.succeed(run),
      });
    }),
  );

export const terminalRun = <Run extends TerminalWorkflowRun>(
  get: () => Stream.Stream<Option.Option<Run>, unknown, never>,
  timeout: Duration.Duration,
  pollInterval = workflowObservationInitialPollInterval,
): Effect.Effect<Run, unknown> =>
  observeTerminalRun(get, pollInterval).pipe(Effect.timeout(timeout));

const workflowFailureMessage = (failure: unknown): string =>
  Predicate.hasProperty(failure, "message") && Predicate.isString(failure.message)
    ? failure.message
    : "The check-in message workflow failed. Try again.";

const decodeWorkflowValue = <SchemaValue extends Schema.Top>(
  schema: SchemaValue,
  value: unknown,
  operation: string,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (error) =>
        new CheckinSavedMessageCommandError({
          message: `${operation}: ${workflowFailureMessage(error)}`,
        }),
    ),
  );

const maxDiscordMessageLength = 2_000;
const draftPreservationNotice = "\nYour draft was preserved for review:\n";

const draftPreservationMessage = (message: string, draft: string): string => {
  const availableLength = maxDiscordMessageLength - message.length;
  if (availableLength <= 0) return message.slice(0, maxDiscordMessageLength);
  if (availableLength <= draftPreservationNotice.length) {
    return `${message}${draftPreservationNotice.slice(0, availableLength)}`;
  }
  return `${message}${draftPreservationNotice}${draft.slice(
    0,
    availableLength - draftPreservationNotice.length,
  )}`;
};

// fallow-ignore-next-line complexity
const runValue = <Run extends TerminalWorkflowRun>(
  run: Run,
  operation: string,
): Effect.Effect<unknown, CheckinSavedMessageCommandError> => {
  if (run.result._tag === "Success" && Predicate.hasProperty(run.result, "value")) {
    return Effect.succeed(run.result.value);
  }
  if (run.result._tag === "Failure" && Predicate.hasProperty(run.result, "failure")) {
    const failure = run.result.failure;
    if (Predicate.hasProperty(failure, "error")) {
      return Effect.fail(
        new CheckinSavedMessageCommandError({
          message: `${operation}: ${workflowFailureMessage(failure.error)}`,
        }),
      );
    }
    return Effect.fail(
      new CheckinSavedMessageCommandError({
        message: `${operation}: ${workflowFailureMessage(failure)}`,
      }),
    );
  }
  return Effect.fail(
    new CheckinSavedMessageCommandError({ message: `${operation}: workflow did not finish.` }),
  );
};

const loadSavedMessage = (workflow: CheckinMessagesLoadWorkflow, input: CheckinMessagesLoadInput) =>
  SheetWorkflowHttpRequestContext.asInteractionUser(() =>
    Effect.gen(function* () {
      const reference = yield* workflow.enqueue(input);
      const run = yield* terminalRun(() => workflow.get(reference), savedMessageLoadTimeout);
      return yield* runValue(run, "Could not load the saved check-in message").pipe(
        Effect.flatMap((value) =>
          decodeWorkflowValue(
            CheckinMessagesLoad.success,
            value,
            "Could not load the saved check-in message",
          ),
        ),
      );
    }),
  )();

const saveSavedMessage = (workflow: CheckinMessagesSaveWorkflow, input: CheckinMessagesSaveInput) =>
  SheetWorkflowHttpRequestContext.asInteractionUser(() =>
    Effect.gen(function* () {
      const reference = yield* workflow.enqueue(input);
      const run = yield* terminalRun(() => workflow.get(reference), savedMessageSaveTimeout);
      return yield* runValue(run, "Could not save the check-in message").pipe(
        Effect.flatMap((value) =>
          decodeWorkflowValue(
            CheckinMessagesSave.success,
            value,
            "Could not save the check-in message",
          ),
        ),
      );
    }),
  )();

const resolveSavedMessageLoadInput = (command: {
  readonly optionValueOptional: (
    name: "channel_name" | "hour" | "server_id",
  ) => Option.Option<string | number | boolean>;
}) =>
  Effect.gen(function* () {
    const serverId = Option.flatMap(command.optionValueOptional("server_id"), (value) =>
      Predicate.isString(value) ? Option.some(value) : Option.none(),
    );
    const workspaceId = yield* resolveGuildId(serverId).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(WorkspaceId)(value)),
    );
    const channelName = Option.flatMap(command.optionValueOptional("channel_name"), (value) =>
      Predicate.isString(value) ? Option.some(value) : Option.none(),
    );
    const hourValue = Option.getOrUndefined(command.optionValueOptional("hour"));
    const hour = yield* Schema.decodeUnknownEffect(CheckinMessageScheduleHour)(hourValue);
    const target = Option.isSome(channelName)
      ? { conversationName: String(channelName.value) }
      : { conversationId: yield* resolveChannelId(Option.none()) };
    return { input: { workspaceId, ...target }, hour };
  });

const makeSavedMessageModal = (
  state: SavedMessageModalState,
  template: string | null,
): Discord.ModalInteractionCallbackRequestData => ({
  custom_id: makeSavedMessageModalId(state),
  title: `Check-in hour ${state.hour}`,
  components: [
    {
      type: Discord.MessageComponentTypes.ACTION_ROW,
      components: [
        {
          type: Discord.MessageComponentTypes.TEXT_INPUT,
          custom_id: savedMessageFieldId,
          style: Discord.TextInputStyleTypes.PARAGRAPH,
          label: "Message template",
          required: false,
          placeholder:
            "Use {{mentionsString}}, {{conversationString}}, {{hourString}}, or {{timeStampString}}",
          value: template ?? "",
        },
      ],
    },
  ],
});

const makeSavedMessageEditButtonId = (sessionId: SavedMessageEditSessionId) =>
  `${savedMessageEditButtonPrefix}${sessionId}`;

export const decodeSavedMessageEditButtonId = (
  value: string,
): Option.Option<SavedMessageEditSessionId> =>
  value.startsWith(savedMessageEditButtonPrefix)
    ? Schema.decodeUnknownOption(SavedMessageEditSessionId)(
        value.slice(savedMessageEditButtonPrefix.length),
      )
    : Option.none();

const makeSavedMessageEditButtonData = (sessionId: SavedMessageEditSessionId) =>
  makeMessageActionRowData((row) =>
    row.addComponents(
      makeButtonData((button) =>
        button
          .setCustomId(makeSavedMessageEditButtonId(sessionId))
          .setLabel("Edit saved message")
          .setStyle(ButtonStyle.Primary),
      ),
    ),
  ).toJSON();

export const makeSavedMessageSubCommandData = (builder: SubCommandBuilder) =>
  builder
    .setName("saved")
    .setDescription("Edit the saved check-in message for one hour")
    .addIntegerOption((option) =>
      option.setName("hour").setDescription("The event-relative hour to edit").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("channel_name").setDescription("The name of the running channel"),
    )
    .addStringOption((option) => option.setName("server_id").setDescription("The server to edit"));

type SavedMessageWorkflowClient = Pick<SheetWorkflowHttpClientShape, "checkinMessagesLoad">;

export const makeSavedMessageSubCommandWithClient = (
  workflowClient: SavedMessageWorkflowClient,
  storage: typeof Unstorage.Service,
) =>
  CommandHelper.makeSubCommand(
    makeSavedMessageSubCommandData,
    // fallow-ignore-next-line complexity
    Effect.fn("checkin.saved.load")(function* (command) {
      const response = yield* InteractionResponse;
      yield* deferSavedMessageCommand(response);
      const commandInput = yield* resolveSavedMessageLoadInput(command);
      const loaded = yield* loadSavedMessage(
        workflowClient.checkinMessagesLoad,
        commandInput.input,
      );
      const current = loaded.messages.find(({ hour }) => hour === commandInput.hour);
      const state = Schema.decodeUnknownSync(SavedMessageModalState)({
        workspaceId: loaded.workspaceId,
        conversationId: loaded.conversationId,
        hour: commandInput.hour,
        eventStartEpochMs: loaded.binding.eventStartEpochMs,
        messageSetGeneration: loaded.binding.messageSetGeneration,
        expectedVersion: current?.version ?? 0,
      });
      const sessionId = yield* saveSavedMessageEditSession(storage, {
        state,
        template: current?.template ?? null,
      });
      yield* response.editReply({
        payload: {
          content: `The saved check-in message for hour ${state.hour} is ready. Click the button to edit it.`,
          components: [makeSavedMessageEditButtonData(sessionId)],
        },
      });
    }),
  );

export const makeSavedMessageSubCommand = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const storage = yield* Unstorage;
  return yield* makeSavedMessageSubCommandWithClient(workflowClient, storage);
});

const makeSavedMessageModalHandler = Effect.gen(function* () {
  const workflowClient = yield* SheetWorkflowHttpClient;
  const handler = Effect.gen(function* () {
    const response = yield* InteractionResponse;
    yield* response.deferReply({ flags: MessageFlags.Ephemeral });
    const data = yield* ModalSubmitData;
    const state = yield* decodeSavedMessageModalId(data.custom_id).pipe(
      Option.match({
        onNone: () =>
          Effect.fail(
            new CheckinSavedMessageCommandError({
              message: "This edit form has expired. Open it again.",
            }),
          ),
        onSome: Effect.succeed,
      }),
    );
    const draft = yield* Ix.modalValue(savedMessageFieldId);
    const savedExit = yield* Effect.exit(
      saveSavedMessage(workflowClient.checkinMessagesSave, {
        workspaceId: state.workspaceId,
        conversationId: state.conversationId,
        binding: {
          eventStartEpochMs: state.eventStartEpochMs,
          messageSetGeneration: state.messageSetGeneration,
        },
        hour: state.hour,
        template: draft.length === 0 ? null : draft,
        expectedVersion: state.expectedVersion,
      }),
    );
    if (Exit.isFailure(savedExit)) {
      const error = Cause.findErrorOption(savedExit.cause);
      const message = Option.match(error, {
        onNone: () => "I couldn't save that check-in message. Try again.",
        onSome: (value) => workflowFailureMessage(value),
      });
      yield* response.editReply({
        payload: { content: draftPreservationMessage(message, draft) },
      });
      return;
    }
    const saved = savedExit.value;
    yield* response.editReply({
      payload: {
        content: `Saved the check-in message for hour ${saved.message.hour}. Blank values restore the Random default.`,
      },
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const response = yield* InteractionResponse;
        const error = Cause.findErrorOption(cause);
        const message = Option.match(error, {
          onNone: () => "I couldn't save that check-in message. Try again.",
          onSome: (value) => workflowFailureMessage(value),
        });
        yield* response.editReply({ payload: { content: message } });
      }),
    ),
  );
  const forkedHandler = yield* makeForkedMessageComponentHandler(handler);
  return provideInteractionToken(
    provideInteractionResponse(
      "command",
      Effect.gen(function* () {
        const response = yield* InteractionResponse;
        yield* forkedHandler();
        const initial = yield* response.awaitInitialResponse;
        return { files: initial.files, ...initial.payload };
      }),
    ),
  );
});

export const makeSavedMessageModalDefinition = Effect.gen(function* () {
  const handler = yield* makeSavedMessageModalHandler;
  return Ix.modalSubmit(Ix.idStartsWith(savedMessageModalPrefix), handler);
});

export const makeSavedMessageEditButtonDefinition = Effect.gen(function* () {
  const storage = yield* Unstorage;
  const handler = Effect.gen(function* () {
    const response = yield* MessageComponentInteractionResponse;
    yield* Effect.gen(function* () {
      const data = yield* Ix.MessageComponentData;
      const sessionId = yield* decodeSavedMessageEditButtonId(data.custom_id).pipe(
        Option.match({
          onNone: () =>
            Effect.fail(
              new CheckinSavedMessageCommandError({
                message: "This check-in message editor has expired. Run the command again.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      );
      const session = yield* loadSavedMessageEditSession(storage, sessionId).pipe(
        Effect.timeoutOrElse({
          duration: savedMessageEditSessionReadTimeout,
          orElse: () =>
            Effect.fail(
              new CheckinSavedMessageCommandError({
                message:
                  "The check-in message editor took too long to load. Run the command again.",
              }),
            ),
        }),
      );
      const shown = yield* response.showModal(
        makeSavedMessageModal(session.state, session.template),
      );
      if (shown) yield* removeSavedMessageEditSession(storage, sessionId).pipe(Effect.ignore);
    }).pipe(Effect.catchCause((cause) => response.respondWithError(cause).pipe(Effect.asVoid)));
    const initial = yield* response.awaitInitialResponse;
    return { files: initial.files, ...initial.payload };
  });

  return Ix.messageComponent(
    Ix.idStartsWith(savedMessageEditButtonPrefix),
    provideInteractionToken(provideInteractionResponse("message-component", handler)),
  );
});
