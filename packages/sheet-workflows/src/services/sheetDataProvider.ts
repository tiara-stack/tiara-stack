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
import { type SchedulesLoadWorkspaceSuccess, type WorkspaceId } from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { config } from "@/config";
import { calculateRoomOrderEntries } from "@/workflows/roomOrders/createCalculation";
import {
  AutoCheckinTestProvider,
  autoCheckinTestProviderLayer,
  type AutoCheckinTestProviderParticipant,
} from "@/workflows/checkins/autoTestProvider";
import { UserScheduleProvider, userScheduleProviderLayer } from "@/workflows/schedules/provider";

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
    | "resolve-conversation"
    | "read-checkin"
    | "read-room-order"
    | "read-schedules";
  readonly cause: unknown;
}> {}

type CheckinGenerationInput = {
  readonly workspaceId: WorkspaceId;
  readonly conversationId?: string | undefined;
  readonly conversationName?: string | undefined;
  readonly hour?: number | undefined;
  readonly template?: string | undefined;
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
  readonly generateRoomOrder: (
    input: RoomOrderGenerationInput,
  ) => Effect.Effect<RoomOrderGeneration, SheetDataProviderError>;
  readonly loadWorkspaceSchedules: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<SchedulesLoadWorkspaceSuccess, SheetDataProviderError>;
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

const resolveConversation = (
  persistence: TrustedSheetPersistence["Service"],
  input: {
    readonly workspaceId: WorkspaceId;
    readonly conversationId?: string;
    readonly conversationName?: string;
  },
) =>
  Effect.gen(function* () {
    const workspace = yield* persistence.workspaces
      .getWorkspaceConfigByWorkspaceId({ workspaceId: input.workspaceId })
      .pipe(Effect.mapError(providerError("resolve-workspace")));
    const workspaceConfig = Option.getOrUndefined(workspace);
    if (Predicate.isUndefined(workspaceConfig)) {
      return yield* Effect.fail(
        providerError("resolve-workspace")(new Error("Workspace was not found")),
      );
    }
    if (Predicate.isNull(workspaceConfig.sheetId)) {
      return yield* Effect.fail(
        providerError("resolve-workspace")(new Error("Workspace sheet is not configured")),
      );
    }

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
      spreadsheetId: workspaceConfig.sheetId,
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

const renderStaticTemplateSegment = (value: string): ReadonlyArray<BotTextPart> =>
  value
    .split("~~")
    .flatMap((segment, index) =>
      segment.length === 0
        ? []
        : index % 2 === 0
          ? [MessageText.text(segment)]
          : [{ type: "strikethrough" as const, parts: [MessageText.text(segment)] }],
    );

const renderTemplate = (
  template: string,
  context: Readonly<Record<string, ReadonlyArray<BotTextPart>>>,
) => {
  const result: Array<BotTextPart> = [];
  const pattern = /\{\{\{?(\w+)\}?\}\}/gu;
  let lastIndex = 0;
  for (const match of template.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex)
      result.push(...renderStaticTemplateSegment(template.slice(lastIndex, index)));
    result.push(...(context[match[1] ?? ""] ?? renderStaticTemplateSegment(match[0])));
    lastIndex = index + match[0].length;
  }
  if (lastIndex < template.length)
    result.push(...renderStaticTemplateSegment(template.slice(lastIndex)));
  return result;
};

const renderParticipantMentions = (participants: ReadonlyArray<Participant>) =>
  participants.flatMap((participant, index) =>
    MessageText.parts(
      index === 0 ? undefined : MessageText.text(" "),
      Predicate.isString(participant.userId)
        ? MessageText.userMention(participant.userId)
        : MessageText.text(participant.name),
    ),
  );

const eventHour = (eventStartEpochMs: number, hour: number) =>
  hourWindowFor({ startTime: DateTime.makeUnsafe(eventStartEpochMs) }, hour);

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
      const { spreadsheetId, workspace, conversation } = yield* resolve(input);
      const view = yield* asProviderError(
        "read-checkin",
        checkinProvider.loadCheckin(spreadsheetId, conversation.name),
      );
      const schedulesByHour = new Map(
        view.schedules.flatMap((schedule) =>
          Predicate.isNull(schedule.hour) ? [] : ([[schedule.hour, schedule]] as const),
        ),
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
              return (
                Math.floor(
                  Duration.toHours(
                    DateTime.distance(DateTime.makeUnsafe(view.eventStartEpochMs), currentHour),
                  ),
                ) + 1
              );
            });
      const previous = schedulesByHour.get(hour - 1);
      const current = schedulesByHour.get(hour);
      const previousParticipants = (previous?.fills ?? []).map(toParticipant);
      const participants = (current?.fills ?? []).map(toParticipant);
      const movement = diffParticipants(previousParticipants, participants);
      const template = input.template ?? (yield* pickCheckinTemplate);
      const window = eventHour(view.eventStartEpochMs, hour);
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
      const lookupFailures = (current?.fills ?? []).flatMap(({ accountId, name }) =>
        Predicate.isNull(accountId) ? [name] : [],
      );
      const lookupFailedMessage =
        lookupFailures.length === 0
          ? Option.none<string>()
          : Option.some(
              `Cannot look up ID for ${lookupFailures.join(", ")}. They would need to check in manually.`,
            );
      const monitorUserId = current?.monitor?.accountId ?? null;
      const previousMonitorUserId = previous?.monitor?.accountId ?? null;
      const monitorFailureMessage = Predicate.isUndefined(current)
        ? null
        : Predicate.isNull(current.monitor)
          ? [MessageText.text("Cannot ping monitor: monitor not assigned for this hour.")]
          : Predicate.isNull(current.monitor.accountId)
            ? [
                MessageText.text(
                  `Cannot ping monitor: monitor "${current.monitor.name}" is missing an ID in the sheet.`,
                ),
              ]
            : null;
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
    });

  const generateRoomOrder = (input: RoomOrderGenerationInput) =>
    // Room-order generation keeps the read, calculation, and rendered response together.
    // fallow-ignore-next-line complexity
    Effect.gen(function* () {
      const { spreadsheetId, conversation } = yield* resolve(input);
      const view = yield* asProviderError(
        "read-room-order",
        checkinProvider.loadRoomOrder(spreadsheetId, conversation.name),
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
              return (
                Math.floor(
                  Duration.toHours(
                    DateTime.distance(DateTime.makeUnsafe(view.eventStartEpochMs), currentHour),
                  ),
                ) + 1
              );
            });
      const schedulesByHour = new Map(
        view.schedules.flatMap((schedule) =>
          Predicate.isNull(schedule.hour) ? [] : ([[schedule.hour, schedule]] as const),
        ),
      );
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
      const window = eventHour(view.eventStartEpochMs, hour);
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
      const workspace = yield* persistence.workspaces
        .getWorkspaceConfigByWorkspaceId({ workspaceId })
        .pipe(Effect.mapError(providerError("resolve-workspace")));
      const workspaceConfig = Option.getOrUndefined(workspace);
      if (Predicate.isUndefined(workspaceConfig) || Predicate.isNull(workspaceConfig.sheetId)) {
        return yield* Effect.fail(
          providerError("resolve-workspace")(new Error("Workspace sheet is not configured")),
        );
      }
      const spreadsheetId = workspaceConfig.sheetId;
      const views = yield* Effect.forEach(
        [1, 2, 3, 4, 5, 6, 7],
        (day) =>
          scheduleProvider
            .load(spreadsheetId, day)
            .pipe(Effect.mapError(providerError("read-schedules"))),
        { concurrency: "unbounded" },
      );
      const populatedSchedules = views.flatMap((view, viewIndex) =>
        view.schedules.flatMap((schedule) => {
          const conversationName = schedule.channel;
          if (!Predicate.isString(conversationName)) return [];
          return [
            {
              conversationName,
              day: schedule.day ?? viewIndex + 1,
              visible: schedule.visible,
              hour: schedule.hour,
              playerNames: [...schedule.fills, ...schedule.overfills, ...schedule.standbys],
              monitorName: schedule.monitor,
            },
          ];
        }),
      );
      return {
        eventConfig: { startTimeEpochMs: views[0]?.eventStartEpochMs ?? 0 },
        populatedSchedules,
      } satisfies SchedulesLoadWorkspaceSuccess;
    });

  return { generateCheckin, generateRoomOrder, loadWorkspaceSchedules };
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
