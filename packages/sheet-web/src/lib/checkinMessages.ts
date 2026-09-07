import { useAtomRefresh, useAtomSet, useAtomSuspense } from "@effect/atom-react";
import { Duration, Effect, Predicate, Schema } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  CheckinMessagesLoadInput,
  CheckinMessagesLoadSuccess,
  CheckinMessagesSaveInput,
  CheckinMessagesSaveSuccess,
  type CheckinMessageSetBinding,
  type CheckinMessagesLoadSuccess as CheckinMessagesLoadSuccessValue,
  type HourlyCheckinMessage,
  type SchedulesLoadWorkspaceSuccess,
} from "sheet-workflow-contracts";
import { useCallback, useMemo } from "react";
import { runSheetWorkflow, sheetZeroClientAtom, type SheetWebZeroClient } from "#/lib/sheetZero";
import { runtimeAtom } from "#/lib/runtime";

const CheckinMessagesAsyncResultSchema = Schema.revealCodec(
  AsyncResult.Schema({
    success: CheckinMessagesLoadSuccess,
    error: Schema.Unknown,
  }),
);

export type CheckinScheduleSummary = SchedulesLoadWorkspaceSuccess["populatedSchedules"][number];

export type CheckinMessageChannel = {
  readonly name: string;
  readonly hours: ReadonlyArray<number>;
  readonly moniHours: ReadonlyArray<number>;
};

export type CheckinTemplatePart =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "placeholder"; readonly token: string };

export const checkinPlaceholderDefinitions = [
  {
    token: "{{mentionsString}}",
    label: "Participant mentions",
    description: "Mentions the fillers assigned to this hour.",
    example: "@Airi @Emu",
  },
  {
    token: "{{conversationString}}",
    label: "Running channel",
    description: "Names the running channel for this check-in.",
    example: "#event-room",
  },
  {
    token: "{{hourString}}",
    label: "Schedule hour",
    description: "Inserts the selected event-relative schedule hour.",
    example: "hour 52",
  },
  {
    token: "{{timeStampString}}",
    label: "Time window",
    description: "Shows the start and end time for the selected hour.",
    example: "12:00–13:00",
  },
] as const;

const defaultCheckinExamples = Object.fromEntries(
  checkinPlaceholderDefinitions.map(({ token, example }) => [token, example]),
) as Readonly<Record<string, string>>;

export const tokenizeCheckinTemplate = (template: string): ReadonlyArray<CheckinTemplatePart> => {
  const pattern = new RegExp(
    checkinPlaceholderDefinitions.map(({ token }) => token.replace(/[{}]/gu, "\\$&")).join("|"),
    "gu",
  );
  const parts: Array<CheckinTemplatePart> = [];
  let lastIndex = 0;
  for (const match of template.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push({ kind: "text", value: template.slice(lastIndex, index) });
    parts.push({ kind: "placeholder", token: match[0] ?? "" });
    lastIndex = index + (match[0]?.length ?? 0);
  }
  if (lastIndex < template.length) {
    parts.push({ kind: "text", value: template.slice(lastIndex) });
  }
  return parts;
};

export const renderCheckinExample = (
  template: string,
  examples: Readonly<Record<string, string>> = defaultCheckinExamples,
): string =>
  tokenizeCheckinTemplate(template)
    .map((part) => (part.kind === "text" ? part.value : (examples[part.token] ?? part.token)))
    .join("");

export const normalizeCheckinTemplate = (template: string): string | null =>
  template.trim().length === 0 ? null : template;

export const checkinMessageForHour = (
  data: CheckinMessagesLoadSuccessValue,
  hour: number,
): HourlyCheckinMessage | undefined => data.messages.find((message) => message.hour === hour);

export const withSavedCheckinMessage = (
  data: CheckinMessagesLoadSuccessValue,
  message: HourlyCheckinMessage,
): CheckinMessagesLoadSuccessValue => {
  const hasMessage = data.messages.some((candidate) => candidate.hour === message.hour);
  const messages = hasMessage
    ? data.messages.map((candidate) => (candidate.hour === message.hour ? message : candidate))
    : [...data.messages, message].sort((left, right) => left.hour - right.hour);
  return { ...data, messages };
};

export const checkinMessageChannelsFromSchedule = (
  summaries: ReadonlyArray<CheckinScheduleSummary>,
  monitorAccountId?: string,
): ReadonlyArray<CheckinMessageChannel> => {
  const byName = new Map<
    string,
    { readonly hours: Set<number>; readonly moniHours: Set<number> }
  >();
  for (const summary of summaries) {
    const name = summary.conversationName.trim();
    if (name.length === 0) continue;
    const entry = byName.get(name) ?? { hours: new Set<number>(), moniHours: new Set<number>() };
    byName.set(name, entry);
    if (Predicate.isNull(summary.hour)) continue;
    entry.hours.add(summary.hour);
    if (Predicate.isString(monitorAccountId) && summary.monitorAccountId === monitorAccountId) {
      entry.moniHours.add(summary.hour);
    }
  }
  return [...byName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => ({
      name,
      hours: [...entry.hours].sort((left, right) => left - right),
      moniHours: [...entry.moniHours].sort((left, right) => left - right),
    }))
    .filter(({ hours }) => hours.length > 0);
};

export const preferredCheckinHour = (
  hours: ReadonlyArray<number>,
  currentHour: number | undefined,
): number | undefined =>
  currentHour !== undefined && hours.includes(currentHour) ? currentHour : hours[0];

type CheckinMessagesLoadRequest = {
  readonly workspaceId: string;
  readonly conversationName: string;
};

type CheckinMessagesSaveRequest = {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly binding: CheckinMessageSetBinding;
  readonly hour: number;
  readonly template: string | null;
  readonly expectedVersion: number;
  readonly responseReference?: string;
};

const loadCheckinMessagesWithClient = (
  client: Pick<SheetWebZeroClient, "workflows">,
  request: CheckinMessagesLoadRequest,
) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(CheckinMessagesLoadInput)(request);
    return yield* runSheetWorkflow(
      client.workflows.checkinMessages.load,
      input,
      CheckinMessagesLoadSuccess,
    );
  });

const checkinMessagesAtom = Atom.family((workspaceId: string) =>
  Atom.family((conversationName: string) =>
    Atom.make<CheckinMessagesLoadSuccessValue, unknown>(
      Effect.fnUntraced(function* (get) {
        const runtime = yield* get.result(sheetZeroClientAtom);
        return yield* loadCheckinMessagesWithClient(runtime, { workspaceId, conversationName });
      }),
    ).pipe(
      Atom.withRefresh(Duration.minutes(2)),
      Atom.serializable({
        key: `checkinMessages.load.v1.${workspaceId}.${encodeURIComponent(conversationName)}`,
        schema: CheckinMessagesAsyncResultSchema,
      }),
    ),
  ),
);

const loadCheckinMessages = runtimeAtom.fn(
  Effect.fnUntraced(function* (request: CheckinMessagesLoadRequest, ctx: Atom.FnContext) {
    const runtime = yield* ctx.result(sheetZeroClientAtom);
    return yield* loadCheckinMessagesWithClient(runtime, request);
  }),
);

const saveCheckinMessage = runtimeAtom.fn(
  Effect.fnUntraced(function* (request: CheckinMessagesSaveRequest, ctx: Atom.FnContext) {
    const runtime = yield* ctx.result(sheetZeroClientAtom);
    const input = yield* Schema.decodeUnknownEffect(CheckinMessagesSaveInput)(request);
    return yield* runSheetWorkflow(
      runtime.workflows.checkinMessages.save,
      input,
      CheckinMessagesSaveSuccess,
    );
  }),
);

export const useLoadCheckinMessages = () => {
  const load = useAtomSet(loadCheckinMessages, { mode: "promise" });
  return useCallback((request: CheckinMessagesLoadRequest) => load(request), [load]);
};

export const useSaveCheckinMessage = () => {
  const save = useAtomSet(saveCheckinMessage, { mode: "promise" });
  return useCallback((request: CheckinMessagesSaveRequest) => save(request), [save]);
};

export const useCheckinMessages = (workspaceId: string, conversationName: string) => {
  const atom = useMemo(
    () => checkinMessagesAtom(workspaceId)(conversationName),
    [conversationName, workspaceId],
  );
  const result = useAtomSuspense(atom, { suspendOnWaiting: false, includeFailure: true });
  const refresh = useAtomRefresh(atom);
  return { atom, result, refresh };
};
