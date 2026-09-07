import {
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Random,
  Schema,
} from "effect";
import { BotTextPart, conversationRefFrom } from "sheet-bot-api";
import { makeMonitorCheckinMessage } from "sheet-message-content/checkinSummary";
import { buildRoomOrderContent } from "sheet-message-content/roomOrderContent";
import { fillParticipantFromName, hourWindowFor } from "sheet-message-content/rendering";
import * as MessageText from "sheet-message-content/text";
import { scheduleHourOrigin } from "sheet-domain";
import {
  SpreadsheetId,
  type SchedulesLoadWorkspaceSuccess,
  type WorkspaceId,
} from "sheet-workflow-contracts";
import type { EffectivePrincipal } from "sheet-auth/identity";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { config } from "@/config";
import {
  resolveAuthoritativeSheetConfigurationForWorkspace,
  resolveAuthoritativeSpreadsheetId,
} from "./authoritativeSheetConfiguration";
import { calculateRoomOrderEntries } from "@/workflows/roomOrders/createCalculation";
import {
  AutoCheckinTestProvider,
  autoCheckinTestProviderLayer,
  type AutoCheckinTestProviderParticipant,
} from "@/workflows/checkins/autoTestProvider";
import { UserScheduleProvider, userScheduleProviderLayer } from "@/workflows/schedules/provider";
import {
  missingParticipantIdMessage,
  monitorFailureMessage as getMonitorFailureMessage,
  renderParticipantMentions,
  renderTemplate,
} from "@/workflows/shared/checkinPresentation";
import { indexSchedulesByHour } from "@/workflows/shared/runnerLocalSheets";

export const CheckinGeneration = Schema.Struct({
  hour: Schema.Number,
  runningConversationId: Schema.String,
  checkinConversationId: Schema.String,
  monitorConversationId: Schema.NullOr(Schema.String),
  fillCount: Schema.Number,
  roleId: Schema.NullOr(Schema.String),
  initialMessage: Schema.NullOr(Schema.Array(BotTextPart)),
  monitorCheckinMessage: Schema.Array(BotTextPart),
  monitorUserId: Schema.NullOr(Schema.String),
  monitorCheckinRequired: Schema.Boolean,
  monitorFailureMessage: Schema.NullOr(Schema.Array(BotTextPart)),
  fillIds: Schema.Array(Schema.String),
});
type CheckinGeneration = typeof CheckinGeneration.Type;

const CheckinMessageTarget = Schema.Struct({
  workspaceId: Schema.String,
  conversationId: Schema.String,
  conversationName: Schema.String,
  eventStartEpochMs: Schema.Number,
});
type CheckinMessageTarget = typeof CheckinMessageTarget.Type;

const RoomOrderGenerationEntry = Schema.Struct({
  rank: Schema.Int,
  position: Schema.Int,
  hour: Schema.Number,
  team: Schema.String,
  tags: Schema.Array(Schema.String),
  effectValue: Schema.Number,
});

export const RoomOrderGeneration = Schema.Struct({
  content: Schema.Array(BotTextPart),
  runningConversationId: Schema.String,
  range: Schema.Struct({ minRank: Schema.Number, maxRank: Schema.Number }),
  rank: Schema.Number,
  hour: Schema.Number,
  monitor: Schema.NullOr(Schema.String),
  previousFills: Schema.Array(Schema.String),
  fills: Schema.Array(Schema.String),
  entries: Schema.Array(RoomOrderGenerationEntry),
});
export type RoomOrderGeneration = typeof RoomOrderGeneration.Type;

export class SheetDataProviderError extends Data.TaggedError("SheetDataProviderError")<{
  readonly operation:
    | "resolve-workspace"
    | "resolve-spreadsheet"
    | "resolve-conversation"
    | "read-checkin"
    | "read-room-order"
    | "read-schedules";
  readonly cause: unknown;
}> {}

/**
 * The authoritative Sheets observation raced the message-set binding. The caller should repeat
 * the complete preparation read so an older observation cannot be applied to a newer generation.
 */
class CheckinMessagePreparationRetry extends Data.TaggedError(
  "CheckinMessagePreparationRetry",
)<{}> {}

export const isCheckinMessagePreparationRetry = (
  error: unknown,
): error is CheckinMessagePreparationRetry =>
  Predicate.isTagged("CheckinMessagePreparationRetry")(error);

export const checkinMessageUpdatedBy = (principal: EffectivePrincipal): string =>
  Predicate.hasProperty(principal, "serviceId")
    ? `service:${principal.serviceId}`
    : (principal.discordAccount?.accountId ?? "unknown-user");

const isMessageSetArgumentConflict = (error: unknown): boolean => {
  const cause =
    Predicate.isObject(error) && Predicate.hasProperty(error, "cause") ? error.cause : undefined;
  return (
    Predicate.isObject(cause) &&
    Predicate.hasProperty(cause, "code") &&
    Predicate.isString(cause.code) &&
    cause.code === "CHECKIN_MESSAGE_SET_CONFLICT"
  );
};

export const resolveSavedCheckinMessage = (
  persistence: TrustedSheetPersistence["Service"],
  options: {
    readonly workspaceId: WorkspaceId;
    readonly eventStartEpochMs: number;
    readonly conversationId: string;
    readonly hour: number;
    readonly updatedBy: string;
  },
): Effect.Effect<string | null | undefined, unknown, never> =>
  Effect.gen(function* () {
    const current = yield* persistence.checkinMessages
      .getMessageSet({ workspaceId: options.workspaceId })
      .pipe(Effect.timeout("30 seconds"));
    const expectedBinding = Option.match(current, {
      onNone: () => null,
      onSome: (row) => ({
        eventStartEpochMs: row.eventStartEpochMs,
        messageSetGeneration: row.messageSetGeneration,
      }),
    });
    yield* persistence.checkinMessages
      .reconcileMessageSet({
        workspaceId: options.workspaceId,
        observedEventStartEpochMs: options.eventStartEpochMs,
        expectedBinding,
        updatedBy: options.updatedBy,
      })
      .pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((error) =>
          isMessageSetArgumentConflict(error) ? new CheckinMessagePreparationRetry() : error,
        ),
      );
    const reconciled = yield* persistence.checkinMessages
      .getMessageSet({ workspaceId: options.workspaceId })
      .pipe(Effect.timeout("30 seconds"));
    if (
      Option.isNone(reconciled) ||
      reconciled.value.eventStartEpochMs !== options.eventStartEpochMs
    ) {
      return yield* Effect.fail(new CheckinMessagePreparationRetry());
    }
    const row = yield* persistence.checkinMessages
      .getHourlyMessage({
        workspaceId: options.workspaceId,
        messageSetGeneration: reconciled.value.messageSetGeneration,
        conversationId: options.conversationId,
        hour: options.hour,
      })
      .pipe(Effect.timeout("30 seconds"));
    return Option.match(row, {
      onNone: () => null,
      onSome: ({ template }) => template,
    });
  });

type CheckinSavedMessageResolver = (observation: {
  readonly eventStartEpochMs: number;
  readonly conversationId: string;
  readonly hour: number;
}) => Effect.Effect<string | null | undefined, unknown>;

type CheckinGenerationInput = {
  readonly workspaceId: WorkspaceId;
  readonly conversationId?: string | undefined;
  readonly conversationName?: string | undefined;
  readonly hour?: number | undefined;
  readonly template?: string | undefined;
  readonly resolveSavedMessage?: CheckinSavedMessageResolver | undefined;
};

type RoomOrderGenerationInput = {
  readonly workspaceId: WorkspaceId;
  readonly conversationId?: string | undefined;
  readonly conversationName?: string | undefined;
  readonly hour?: number | undefined;
  readonly healNeeded?: number | undefined;
};

interface SheetDataProviderShape {
  readonly generateCheckin: (
    input: CheckinGenerationInput,
  ) => Effect.Effect<CheckinGeneration, SheetDataProviderError>;
  readonly resolveCheckinMessageTarget: (input: {
    readonly workspaceId: WorkspaceId;
    readonly conversationId?: string | undefined;
    readonly conversationName?: string | undefined;
  }) => Effect.Effect<CheckinMessageTarget, SheetDataProviderError>;
  readonly generateRoomOrder: (
    input: RoomOrderGenerationInput,
  ) => Effect.Effect<RoomOrderGeneration, SheetDataProviderError>;
  readonly loadWorkspaceSchedules: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<SchedulesLoadWorkspaceSuccess, SheetDataProviderError>;
  /** Resolves the currently authoritative spreadsheet without exposing source internals. */
  readonly resolveSpreadsheetId: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<Option.Option<SpreadsheetId>, SheetDataProviderError>;
}

export class SheetDataProvider extends Context.Service<SheetDataProvider, SheetDataProviderShape>()(
  "sheet-workflows/SheetDataProvider",
) {}

type Conversation = {
  readonly id: string;
  readonly name: string;
  readonly roleId: string | null;
  readonly checkinConversationId: string | null;
};

const providerError = (operation: SheetDataProviderError["operation"]) => (cause: unknown) =>
  new SheetDataProviderError({ operation, cause });

const isSheetDataProviderError = (error: unknown): error is SheetDataProviderError =>
  Predicate.isTagged("SheetDataProviderError")(error);

/**
 * Resolves schedule names to account IDs without guessing when a sheet contains duplicate names.
 * A null result means the name is not present in the identity range or is ambiguous.
 */
export const resolveSchedulePlayerAccountIds = (
  players: ReadonlyArray<{ readonly accountId: string; readonly name: string }>,
  names: ReadonlyArray<string>,
): ReadonlyArray<string | null> => {
  const accountIdsByName = new Map<string, string | null>();
  for (const player of players) {
    if (!accountIdsByName.has(player.name)) {
      accountIdsByName.set(player.name, player.accountId);
      continue;
    }

    if (accountIdsByName.get(player.name) !== player.accountId) {
      accountIdsByName.set(player.name, null);
    }
  }

  return names.map((name) => accountIdsByName.get(name) ?? null);
};

/**
 * Resolve a scheduled monitor only when the authoritative identity range gives one stable ID.
 * Missing names and duplicate names with different IDs intentionally stay unresolved.
 */
export const resolveScheduleMonitorAccountId = (
  monitors: ReadonlyArray<{ readonly accountId: string; readonly name: string }>,
  monitorName: string | null,
): string | undefined => {
  if (Predicate.isNull(monitorName)) return undefined;
  const accountIdsByName = new Map<string, string | null>();
  for (const monitor of monitors) {
    const existing = accountIdsByName.get(monitor.name);
    if (Predicate.isUndefined(existing)) {
      accountIdsByName.set(monitor.name, monitor.accountId);
    } else if (existing !== monitor.accountId) {
      accountIdsByName.set(monitor.name, null);
    }
  }
  const accountId = accountIdsByName.get(monitorName);
  return Predicate.isString(accountId) && accountId.length > 0 ? accountId : undefined;
};

export const selectCheckinTemplate = (options: {
  readonly explicitTemplate: string | undefined;
  readonly savedTemplate: string | null | undefined;
  readonly fallbackTemplate: string;
}): string =>
  Predicate.isString(options.explicitTemplate)
    ? options.explicitTemplate
    : Predicate.isString(options.savedTemplate) && options.savedTemplate.trim().length > 0
      ? options.savedTemplate
      : options.fallbackTemplate;

const loadActiveWorkspace = (
  persistence: TrustedSheetPersistence["Service"],
  workspaceId: WorkspaceId,
) =>
  Effect.gen(function* () {
    const workspace = yield* persistence.workspaces
      .getWorkspaceConfigByWorkspaceId({ workspaceId })
      .pipe(Effect.timeout("30 seconds"), Effect.mapError(providerError("resolve-workspace")));
    const workspaceConfig = Option.getOrUndefined(workspace);
    if (Predicate.isUndefined(workspaceConfig)) {
      return yield* Effect.fail(
        providerError("resolve-workspace")(new Error("Workspace was not found")),
      );
    }
    const active = yield* resolveAuthoritativeSheetConfigurationForWorkspace(
      persistence,
      workspaceId,
      Option.some(workspaceConfig),
    ).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((cause) => providerError("resolve-spreadsheet")(cause)),
    );
    if (Option.isNone(active)) {
      return yield* Effect.fail(
        providerError("resolve-spreadsheet")(new Error("Workspace sheet is not configured")),
      );
    }
    return { workspaceConfig, active: active.value };
  });

const resolveConversation = (
  persistence: TrustedSheetPersistence["Service"],
  input: {
    readonly workspaceId: WorkspaceId;
    readonly conversationId?: string;
    readonly conversationName?: string;
  },
) =>
  Effect.gen(function* () {
    const { workspaceConfig, active } = yield* loadActiveWorkspace(persistence, input.workspaceId);

    const conversations = yield* persistence.workspaces
      .getWorkspaceConversations({ workspaceId: input.workspaceId, running: true })
      .pipe(Effect.mapError(providerError("resolve-conversation")));
    const selected = Predicate.isString(input.conversationId)
      ? conversations.find(({ conversationId }) => conversationId === input.conversationId)
      : conversations.filter(
          ({ name }) =>
            Predicate.isString(input.conversationName) && name === input.conversationName,
        )[0];
    if (Predicate.isUndefined(selected)) {
      return yield* Effect.fail(
        providerError("resolve-conversation")(
          new Error("The requested running conversation was not found"),
        ),
      );
    }
    if (
      Predicate.isNull(selected.name) ||
      selected.name.trim().length === 0 ||
      selected.running !== true ||
      Predicate.isNotNull(selected.deletedAt)
    ) {
      return yield* Effect.fail(
        providerError("resolve-conversation")(new Error("The running conversation is invalid")),
      );
    }
    return {
      spreadsheetId: active.spreadsheetId,
      configuration: active.configuration,
      workspace: workspaceConfig,
      conversation: {
        id: selected.conversationId,
        name: selected.name.trim(),
        roleId: selected.roleId,
        checkinConversationId: selected.checkinConversationId,
      } satisfies Conversation,
    };
  });

type Participant = {
  readonly key: string;
  readonly name: string;
  readonly userId?: string;
};

const toParticipant = ({ accountId, name }: AutoCheckinTestProviderParticipant): Participant =>
  Predicate.isString(accountId)
    ? { key: `player:${accountId}`, name, userId: accountId }
    : { key: `name:${name}`, name };

const dedupeParticipants = (participants: ReadonlyArray<Participant>) => {
  const seen = new Set<string>();
  return participants.filter(({ key }) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const diffParticipants = (
  previousParticipants: ReadonlyArray<Participant>,
  currentParticipants: ReadonlyArray<Participant>,
) => {
  const previous = dedupeParticipants(previousParticipants);
  const current = dedupeParticipants(currentParticipants);
  const previousKeys = new Set(previous.map(({ key }) => key));
  const currentKeys = new Set(current.map(({ key }) => key));
  return {
    out: previous.filter(({ key }) => !currentKeys.has(key)),
    stay: current.filter(({ key }) => previousKeys.has(key)),
    in: current.filter(({ key }) => !previousKeys.has(key)),
  };
};

type Weighted<A> = { readonly value: A; readonly weight: number };

const checkinMessageTemplates: readonly Weighted<string>[] = [
  {
    value:
      "{{mentionsString}} Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.5,
  },
  {
    value:
      "{{mentionsString}} The goddess Miku is calling for you to fill. Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.2,
  },
  {
    value:
      "{{mentionsString}} Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}. ... Beep Boop. Beep Boop. zzzt... zzzt... zzzt...",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}.\n~~or VBS Miku will recruit you for some taste testing of her cooking.~~",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} Ebi jail AAAAAAAAAAAAAAAAAAAAAAA. Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} Miku's voice echoes in the empty SEKAI. Press the button below to check in, then {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} The clock hits 25:00. Miku whispers from the empty SEKAI. Press the button below to check in, then {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} It is ebi jail time! Check in now and {{conversationString}} {{hourString}} {{timeStampString}}.\n-# Perhaps you would encounter Miku on a purple background next time you roll if you fast CI? wink wink~",
    weight: 0.05,
  },
];

const pickCheckinTemplate = Effect.gen(function* () {
  const totalWeight = checkinMessageTemplates.reduce((total, item) => total + item.weight, 0);
  const random = yield* Random.nextBetween(0, totalWeight);
  let accumulatedWeight = 0;
  for (const item of checkinMessageTemplates) {
    accumulatedWeight += item.weight;
    if (random < accumulatedWeight) return item.value;
  }
  return checkinMessageTemplates[checkinMessageTemplates.length - 1]!.value;
});

const eventHour = (
  eventStartEpochMs: number,
  hour: number,
  scheduleHours: ReadonlyArray<number | null>,
) =>
  hourWindowFor(
    { startTime: DateTime.makeUnsafe(eventStartEpochMs) },
    hour,
    scheduleHourOrigin(scheduleHours),
  );

const asProviderError = <A>(
  operation: SheetDataProviderError["operation"],
  effect: Effect.Effect<A, unknown>,
) => effect.pipe(Effect.mapError(providerError(operation)));

const makeSheetDataProvider = (
  persistence: TrustedSheetPersistence["Service"],
  checkinProvider: AutoCheckinTestProvider["Service"],
  scheduleProvider: UserScheduleProvider["Service"],
  clientId: string,
) => {
  const resolve = <A extends { readonly workspaceId: WorkspaceId }>(input: A) =>
    resolveConversation(persistence, input);

  const generateCheckin = (input: CheckinGenerationInput) =>
    // Check-in generation keeps the read, participant movement, and rendered response together.
    // fallow-ignore-next-line complexity
    Effect.gen(function* () {
      const { spreadsheetId, configuration, workspace, conversation } = yield* resolve(input);
      const view = yield* asProviderError(
        "read-checkin",
        checkinProvider.loadCheckin(spreadsheetId, conversation.name, configuration),
      );
      const schedulesByHour = indexSchedulesByHour(view.schedules);
      // fallow-ignore-next-line code-duplication
      const hour =
        Predicate.isNumber(input.hour) && Number.isFinite(input.hour)
          ? input.hour
          : yield* Effect.gen(function* () {
              const now = yield* Effect.map(
                DateTime.now,
                DateTime.addDuration(Duration.minutes(20)),
              );
              const currentHour = DateTime.startOf(now, "hour");
              const scheduleStartHour = scheduleHourOrigin(
                view.schedules.map(({ hour: scheduleHour }) => scheduleHour),
              );
              return (
                Math.floor(
                  Duration.toHours(
                    DateTime.distance(DateTime.makeUnsafe(view.eventStartEpochMs), currentHour),
                  ),
                ) + scheduleStartHour
              );
            });
      const previous = schedulesByHour.get(hour - 1);
      const current = schedulesByHour.get(hour);
      const previousParticipants = (previous?.fills ?? []).map(toParticipant);
      const participants = (current?.fills ?? []).map(toParticipant);
      const movement = diffParticipants(previousParticipants, participants);
      const savedMessage = Predicate.isUndefined(input.resolveSavedMessage)
        ? undefined
        : yield* input.resolveSavedMessage({
            eventStartEpochMs: view.eventStartEpochMs,
            conversationId: conversation.id,
            hour,
          });
      const template = Predicate.isString(input.template)
        ? input.template
        : Predicate.isString(savedMessage) && savedMessage.trim().length > 0
          ? savedMessage
          : selectCheckinTemplate({
              explicitTemplate: undefined,
              savedTemplate: undefined,
              fallbackTemplate: yield* pickCheckinTemplate,
            });
      const window = eventHour(
        view.eventStartEpochMs,
        hour,
        view.schedules.map(({ hour: scheduleHour }) => scheduleHour),
      );
      const conversationText = Predicate.isString(conversation.roleId)
        ? MessageText.parts(MessageText.text(`head to ${conversation.name}`))
        : MessageText.parts(
            MessageText.text("head to "),
            MessageText.conversationMention(
              conversationRefFrom(
                { platform: "discord", clientId },
                input.workspaceId,
                conversation.id,
              ),
            ),
          );
      const initialMessage =
        movement.in.length === 0
          ? null
          : renderTemplate(template, {
              mentionsString: renderParticipantMentions(movement.in),
              conversationString: conversationText,
              hourString: MessageText.parts(
                MessageText.text("for "),
                MessageText.strong([MessageText.text(`hour ${hour}`)]),
              ),
              timeStampString: MessageText.parts(
                MessageText.timestamp(DateTime.toEpochMillis(window.start), "relative"),
              ),
            });
      const lookupFailedMessage = missingParticipantIdMessage(current?.fills ?? []);
      const monitorUserId = current?.monitor?.accountId ?? null;
      const previousMonitorUserId = previous?.monitor?.accountId ?? null;
      const monitorFailureMessage = getMonitorFailureMessage(current);
      const monitorCheckinMessage = makeMonitorCheckinMessage({
        initialMessage,
        empty: Math.max(5 - (current?.fills.length ?? 0) - (current?.overfillCount ?? 0), 0),
        out: movement.out,
        stay: movement.stay,
        in: movement.in,
        lookupFailedMessage,
      });
      return {
        hour,
        runningConversationId: conversation.id,
        checkinConversationId: conversation.checkinConversationId ?? conversation.id,
        monitorConversationId: workspace.monitorConversationId,
        fillCount: current?.fills.length ?? 0,
        roleId: conversation.roleId,
        initialMessage,
        monitorCheckinMessage,
        monitorUserId,
        monitorCheckinRequired:
          Predicate.isString(monitorUserId) && monitorUserId !== previousMonitorUserId,
        monitorFailureMessage,
        fillIds: [
          ...new Set(
            (current?.fills ?? []).flatMap(({ accountId }) =>
              Predicate.isNull(accountId) ? [] : [accountId],
            ),
          ),
        ],
      } satisfies CheckinGeneration;
    }).pipe(
      Effect.mapError(
        (error): SheetDataProviderError =>
          isSheetDataProviderError(error) ? error : providerError("read-checkin")(error),
      ),
    );

  const resolveCheckinMessageTarget = (input: {
    readonly workspaceId: WorkspaceId;
    readonly conversationId?: string | undefined;
    readonly conversationName?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const { spreadsheetId, configuration, conversation } = yield* resolve(input);
      const view = yield* scheduleProvider
        .loadAll(spreadsheetId, configuration)
        .pipe(Effect.mapError(providerError("read-schedules")));
      return {
        workspaceId: input.workspaceId,
        conversationId: conversation.id,
        conversationName: conversation.name,
        eventStartEpochMs: view.eventStartEpochMs,
      } satisfies CheckinMessageTarget;
    }).pipe(
      Effect.mapError(
        (error): SheetDataProviderError =>
          isSheetDataProviderError(error) ? error : providerError("read-schedules")(error),
      ),
    );

  const generateRoomOrder = (input: RoomOrderGenerationInput) =>
    // Room-order generation keeps the read, calculation, and rendered response together.
    // fallow-ignore-next-line complexity
    Effect.gen(function* () {
      const { spreadsheetId, configuration, conversation } = yield* resolve(input);
      const view = yield* asProviderError(
        "read-room-order",
        checkinProvider.loadRoomOrder(spreadsheetId, conversation.name, configuration),
      );
      const hour =
        Predicate.isNumber(input.hour) && Number.isFinite(input.hour)
          ? input.hour
          : yield* Effect.gen(function* () {
              const now = yield* Effect.map(
                DateTime.now,
                DateTime.addDuration(Duration.minutes(20)),
              );
              const currentHour = DateTime.startOf(now, "hour");
              const scheduleStartHour = scheduleHourOrigin(
                view.schedules.map(({ hour: scheduleHour }) => scheduleHour),
              );
              return (
                Math.floor(
                  Duration.toHours(
                    DateTime.distance(DateTime.makeUnsafe(view.eventStartEpochMs), currentHour),
                  ),
                ) + scheduleStartHour
              );
            });
      const schedulesByHour = indexSchedulesByHour(view.schedules);
      const previous = schedulesByHour.get(hour - 1);
      const current = schedulesByHour.get(hour);
      const fills = current?.fills ?? [];
      const entries = yield* calculateRoomOrderEntries({
        teamsByPlayer: fills.map((fill) =>
          Predicate.isNull(fill.accountId)
            ? []
            : (view.teamsByPlayerName.get(fill.name) ?? []).map((team) => ({
                ...team,
                encable: fill.enc,
                tierer: team.tags.includes("tierer_hint"),
              })),
        ),
        healNeeded: input.healNeeded ?? 0,
        hour,
      });
      if (entries.length === 0) {
        return yield* Effect.fail(
          providerError("read-room-order")(new Error("Cannot calculate room order")),
        );
      }
      const maxRank = Math.max(...entries.map(({ rank }) => rank));
      const window = eventHour(
        view.eventStartEpochMs,
        hour,
        view.schedules.map(({ hour: scheduleHour }) => scheduleHour),
      );
      return {
        content: buildRoomOrderContent(
          hour,
          window.start,
          window.end,
          current?.monitor ?? null,
          (previous?.fills ?? []).map(({ name }) => fillParticipantFromName(name)),
          fills.map(({ name }) => fillParticipantFromName(name)),
          entries.filter(({ rank }) => rank === 0),
        ),
        runningConversationId: conversation.id,
        range: { minRank: 0 as const, maxRank },
        rank: 0 as const,
        hour,
        monitor: current?.monitor ?? null,
        previousFills: (previous?.fills ?? []).map(({ name }) => name),
        fills: fills.map(({ name }) => name),
        entries,
      } satisfies RoomOrderGeneration;
    });

  const loadWorkspaceSchedules = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const { active } = yield* loadActiveWorkspace(persistence, workspaceId);
      // One provider read already batches every configured day and preserves day identity in the
      // returned schedule rows. Avoid multiplying Sheets reads by the number of configured days.
      const view = yield* scheduleProvider
        .loadAll(active.spreadsheetId, active.configuration)
        .pipe(Effect.mapError(providerError("read-schedules")));
      const populatedSchedules = view.schedules.flatMap((schedule) => {
        const conversationName = schedule.channel;
        if (!Predicate.isString(conversationName) || !Predicate.isNumber(schedule.day)) return [];
        const playerNames = [...schedule.fills, ...schedule.overfills, ...schedule.standbys];
        const monitorAccountId = resolveScheduleMonitorAccountId(view.monitors, schedule.monitor);
        return [
          {
            conversationName,
            day: schedule.day,
            visible: schedule.visible,
            hour: schedule.hour,
            break: schedule.break,
            playerNames,
            playerAccountIds: resolveSchedulePlayerAccountIds(view.players, playerNames),
            monitorName: schedule.monitor,
            ...(monitorAccountId === undefined ? {} : { monitorAccountId }),
          },
        ];
      });
      return {
        eventConfig: { startTimeEpochMs: view.eventStartEpochMs },
        populatedSchedules,
      } satisfies SchedulesLoadWorkspaceSuccess;
    });

  const resolveSpreadsheetId = (workspaceId: WorkspaceId) =>
    resolveAuthoritativeSpreadsheetId(persistence, workspaceId).pipe(
      Effect.mapError((cause) => providerError("resolve-spreadsheet")(cause)),
    );

  return {
    generateCheckin,
    resolveCheckinMessageTarget,
    generateRoomOrder,
    loadWorkspaceSchedules,
    resolveSpreadsheetId,
  };
};

export const sheetDataProviderLayer = Layer.effect(
  SheetDataProvider,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const checkinProvider = yield* AutoCheckinTestProvider;
    const scheduleProvider = yield* UserScheduleProvider;
    const clientId = yield* config.sheetBotClientId;
    return makeSheetDataProvider(persistence, checkinProvider, scheduleProvider, clientId);
  }),
).pipe(Layer.provide(autoCheckinTestProviderLayer), Layer.provide(userScheduleProviderLayer));
