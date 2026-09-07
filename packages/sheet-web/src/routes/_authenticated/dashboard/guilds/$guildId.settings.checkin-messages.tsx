import { useAtomRefresh, useAtomSuspense } from "@effect/atom-react";
import { createFileRoute, type RegisteredRouter, useBlocker } from "@tanstack/react-router";
import { DateTime, Duration, Effect, Option, Predicate } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Info,
  LoaderCircle,
  LockKeyhole,
  MessageSquareText,
  RotateCcw,
  Save,
  Search,
  UserRound,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { scheduleHourOrigin } from "sheet-domain";
import type {
  CheckinMessageConflict,
  CheckinMessagesLoadSuccess,
  SchedulesLoadWorkspaceSuccess,
} from "sheet-workflow-contracts";
import { ensureResultAtomData, isBrowserRuntime } from "#/lib/atomRegistry";
import { availableResultValue } from "#/lib/asyncResult";
import {
  checkinMessageChannelsFromSchedule,
  checkinMessageForHour,
  checkinPlaceholderDefinitions,
  normalizeCheckinTemplate,
  preferredCheckinHour,
  renderCheckinExample,
  tokenizeCheckinTemplate,
  useCheckinMessages,
  useLoadCheckinMessages,
  useSaveCheckinMessage,
  withSavedCheckinMessage,
  type CheckinMessageChannel,
} from "#/lib/checkinMessages";
import { computeScheduleHour, scheduleStart, workspaceScheduleAtom } from "#/lib/schedule";
import { declaredWorkflowFailure } from "#/lib/sheetZero";
import { currentUserAtom } from "#/lib/discord";
import {
  guildCapabilities,
  permissionsFromResult,
  useGuildPermissionsResult,
} from "#/lib/guildConfig";
import { useNowByHour } from "#/lib/dateTime";
import { useTimeZone } from "#/hooks/useTimeZone";
import { useZoned, zoneId } from "#/hooks/useDateTimeZoned";
import { NavigationConfirmation } from "./$guildId.settings";

export const Route = createFileRoute(
  "/_authenticated/dashboard/guilds/$guildId/settings/checkin-messages",
)({
  component: CheckinMessagesRoute,
  loader: async ({ abortController, context, params }) => {
    if (!isBrowserRuntime()) return;
    await Effect.runPromise(
      Effect.all(
        [
          ensureResultAtomData(context.atomRegistry, workspaceScheduleAtom(params.guildId)).pipe(
            Effect.catch(() => Effect.void),
          ),
          ensureResultAtomData(context.atomRegistry, currentUserAtom).pipe(
            Effect.catch(() => Effect.void),
          ),
        ],
        { concurrency: 2, discard: true },
      ),
      { signal: abortController.signal },
    );
  },
});

type ResultTag = AsyncResult.AsyncResult<unknown, unknown>["_tag"];
type EditorState = { readonly dirty: boolean; readonly saving: boolean };
type SelectionRequest = { readonly channelName: string; readonly hour: number };
type HourWindowLabel = {
  readonly date: string;
  readonly time: string;
  readonly label: string;
};
type CheckinHourOption = {
  readonly hour: number;
  readonly window: HourWindowLabel;
  readonly custom: boolean;
  readonly current: boolean;
  readonly moni: boolean;
  readonly breakHour: boolean;
  readonly searchText: string;
};

const padTimePart = (part: number) => String(part).padStart(2, "0");

const formatCheckinHourWindow = (
  eventStartEpochMs: number,
  hour: number,
  scheduleStartHour: number,
  timeZone: DateTime.TimeZone,
): HourWindowLabel => {
  const startUtc = scheduleStart(DateTime.makeUnsafe(eventStartEpochMs), hour, scheduleStartHour);
  const start = DateTime.setZone(startUtc, timeZone);
  const end = DateTime.setZone(DateTime.addDuration(startUtc, Duration.hours(1)), timeZone);
  const startParts = DateTime.toParts(start);
  const endParts = DateTime.toParts(end);
  const date = new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day, 12)));
  const time =
    padTimePart(startParts.hour) +
    ":" +
    padTimePart(startParts.minute) +
    "–" +
    padTimePart(endParts.hour) +
    ":" +
    padTimePart(endParts.minute);
  return { date, time, label: date + " · " + time };
};

const nextMatchingHour = (
  options: ReadonlyArray<CheckinHourOption>,
  selectedHour: number,
  predicate: (option: CheckinHourOption) => boolean,
): number | undefined => {
  const selectedIndex = options.findIndex(({ hour }) => hour === selectedHour);
  const next = options.slice(selectedIndex + 1).find(predicate);
  return next?.hour ?? options.slice(0, Math.max(selectedIndex, 0)).find(predicate)?.hour;
};

function CheckinMessagesRoute() {
  const { guildId } = Route.useParams();
  const permissionResult = useGuildPermissionsResult(guildId);
  const capabilities = guildCapabilities(permissionsFromResult(permissionResult), guildId);

  if (!capabilities.canLockdown && !AsyncResult.isSuccess(permissionResult)) {
    return (
      <CheckinNotice
        icon={<LoaderCircle className="animate-spin" />}
        eyebrow="LOADING ACCESS"
        title="Checking monitor access"
      >
        Waiting for the server permissions to load.
      </CheckinNotice>
    );
  }

  if (!capabilities.canLockdown) {
    return (
      <CheckinNotice
        icon={<LockKeyhole />}
        eyebrow="ACCESS DENIED"
        title="Check-in messages are restricted"
      >
        A registered TiaraBot monitor role or Discord Manage Server permission is required. No
        message configuration was changed.
      </CheckinNotice>
    );
  }

  return <CheckinMessagesSection guildId={guildId} />;
}

// fallow-ignore-next-line complexity
function CheckinMessagesSection({ guildId }: { readonly guildId: string }) {
  const scheduleAtom = useMemo(() => workspaceScheduleAtom(guildId), [guildId]);
  const scheduleResult = useAtomSuspense(scheduleAtom, {
    suspendOnWaiting: false,
    includeFailure: true,
  });
  const refreshSchedule = useAtomRefresh(scheduleAtom);
  const currentUserResult = useAtomSuspense(currentUserAtom, {
    suspendOnWaiting: false,
    includeFailure: true,
  });
  const schedule = availableResultValue(scheduleResult);
  const currentUser = availableResultValue(currentUserResult);

  if (schedule === undefined) {
    return (
      <CheckinNotice
        icon={
          scheduleResult._tag === "Failure" ? (
            <AlertTriangle />
          ) : (
            <LoaderCircle className="animate-spin" />
          )
        }
        eyebrow={scheduleResult._tag === "Failure" ? "SCHEDULE UNAVAILABLE" : "LOADING SCHEDULE"}
        title={
          scheduleResult._tag === "Failure"
            ? "Could not load running channels"
            : "Loading running channels"
        }
      >
        {scheduleResult._tag === "Failure"
          ? "The editor needs the current event schedule to choose a channel and hour. Your saved messages were not changed."
          : "Reading the current event schedule."}
        {scheduleResult._tag === "Failure" ? (
          <button
            type="button"
            className={`${secondaryButtonClass} mt-5`}
            onClick={refreshSchedule}
          >
            <RotateCcw className="h-4 w-4" />
            RETRY SCHEDULE
          </button>
        ) : null}
      </CheckinNotice>
    );
  }

  return (
    <LoadedCheckinMessagesSection guildId={guildId} schedule={schedule} currentUser={currentUser} />
  );
}

// fallow-ignore-next-line complexity
function LoadedCheckinMessagesSection({
  guildId,
  schedule,
  currentUser,
}: {
  readonly guildId: string;
  readonly schedule: SchedulesLoadWorkspaceSuccess;
  readonly currentUser: { readonly id: string } | undefined;
}) {
  const monitorAccountId = currentUser?.id;
  const channels = useMemo(
    () => checkinMessageChannelsFromSchedule(schedule.populatedSchedules, monitorAccountId),
    [monitorAccountId, schedule.populatedSchedules],
  );
  const timeZone = useTimeZone();
  const nowByHour = useNowByHour(timeZone);
  const eventStart = useMemo(
    () => DateTime.makeUnsafe(schedule.eventConfig.startTimeEpochMs),
    [schedule.eventConfig.startTimeEpochMs],
  );
  const eventStartZoned = useZoned(timeZone, eventStart);
  const allHours = useMemo(() => channels.flatMap((channel) => channel.hours), [channels]);
  const scheduleStartHour = useMemo(
    () => scheduleHourOrigin(schedule.populatedSchedules.map(({ hour }) => hour)),
    [schedule.populatedSchedules],
  );
  const maxScheduleHour = allHours.length > 0 ? Math.max(...allHours) : 0;
  const currentHour = Option.getOrUndefined(
    computeScheduleHour(eventStartZoned, nowByHour, maxScheduleHour, scheduleStartHour),
  );
  const [selectedChannelName, setSelectedChannelName] = useState<string>();
  const [selectedHour, setSelectedHour] = useState<number>();
  const [selectionRequest, setSelectionRequest] = useState<SelectionRequest>();
  const [editorState, setEditorState] = useState<EditorState>({ dirty: false, saving: false });

  const activeChannelName = channels.some(({ name }) => name === selectedChannelName)
    ? selectedChannelName
    : channels[0]?.name;
  const activeChannel = channels.find(({ name }) => name === activeChannelName);
  const activeHour = activeChannel
    ? activeChannel.hours.includes(selectedHour ?? -1)
      ? selectedHour
      : preferredCheckinHour(activeChannel.hours, currentHour)
    : undefined;

  useEffect(() => {
    if (activeChannelName !== selectedChannelName) setSelectedChannelName(activeChannelName);
    if (activeHour !== selectedHour) setSelectedHour(activeHour);
  }, [activeChannelName, activeHour, selectedChannelName, selectedHour]);

  // fallow-ignore-next-line complexity
  const selectTarget = useCallback(
    // fallow-ignore-next-line complexity
    (target: SelectionRequest) => {
      if (target.channelName === activeChannelName && target.hour === activeHour) return;
      if (editorState.dirty || editorState.saving) {
        setSelectionRequest(target);
        return;
      }
      setSelectionRequest(undefined);
      setSelectedChannelName(target.channelName);
      setSelectedHour(target.hour);
    },
    [activeChannelName, activeHour, editorState.dirty, editorState.saving],
  );

  const discardAndSelect = () => {
    if (selectionRequest === undefined) return;
    setSelectionRequest(undefined);
    setSelectedChannelName(selectionRequest.channelName);
    setSelectedHour(selectionRequest.hour);
  };

  if (channels.length === 0 || activeChannel === undefined || activeHour === undefined) {
    return (
      <CheckinNotice
        icon={<MessageSquareText />}
        eyebrow="NO RUNNING HOURS"
        title="No running schedule hours found"
      >
        Configure at least one running channel with a schedule hour before preparing check-in
        messages. This page does not change channel or sheet configuration.
      </CheckinNotice>
    );
  }

  const hasStableMonitorData = schedule.populatedSchedules.some(({ monitorAccountId: id }) =>
    Predicate.isString(id),
  );
  const identityNotice = Predicate.isUndefined(monitorAccountId)
    ? "Your Discord identity is unavailable, so moni-hour markers are hidden."
    : !hasStableMonitorData
      ? "This schedule has no stable monitor identities, so moni-hour markers are hidden rather than guessed from names."
      : undefined;

  return (
    <div className="min-w-0 bg-[#080d0c]">
      {identityNotice ? (
        <div
          role="status"
          className="flex items-start gap-2 border-b border-[#ffb86b]/25 bg-[#ffb86b]/[0.06] px-4 py-3 text-xs leading-relaxed text-[#ffca8b] sm:px-6"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{identityNotice}</span>
        </div>
      ) : null}
      {selectionRequest ? (
        <div
          role="alert"
          className="flex flex-col gap-3 border-b border-[#ffb86b]/25 bg-[#ffb86b]/[0.06] px-4 py-3 text-xs text-[#ffca8b] sm:flex-row sm:items-center sm:justify-between sm:px-6"
        >
          <p className="flex items-start gap-2 leading-relaxed">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Finish or discard the current draft before changing the selected hour.</span>
          </p>
          <div className="flex flex-wrap gap-2 sm:shrink-0">
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => setSelectionRequest(undefined)}
            >
              KEEP EDITING
            </button>
            <button
              type="button"
              className={`${secondaryButtonClass} border-[#ff6257]/45 text-[#ff8a80] hover:bg-[#ff6257]/10`}
              onClick={discardAndSelect}
              disabled={editorState.saving}
            >
              DISCARD DRAFT
            </button>
          </div>
        </div>
      ) : null}
      <div className="grid min-w-0 grid-cols-1 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <main className="min-w-0 bg-[#0a100f] lg:col-start-2 lg:row-start-1">
          <HourlyMessageEditor
            key={`${activeChannel.name}:${activeHour}`}
            workspaceId={guildId}
            channel={activeChannel}
            hour={activeHour}
            eventStartEpochMs={schedule.eventConfig.startTimeEpochMs}
            scheduleStartHour={scheduleStartHour}
            timeZone={timeZone}
            isCurrentHour={activeHour === currentHour}
            isYourMoniHour={activeChannel.moniHours.includes(activeHour)}
            onSelect={selectTarget}
            onStateChange={setEditorState}
          />
        </main>
        <ChannelHourNavigator
          className="lg:col-start-1 lg:row-start-1"
          workspaceId={guildId}
          channels={channels}
          eventStartEpochMs={schedule.eventConfig.startTimeEpochMs}
          scheduleStartHour={scheduleStartHour}
          scheduleSummaries={schedule.populatedSchedules}
          selectedChannelName={activeChannel.name}
          selectedHour={activeHour}
          currentHour={currentHour}
          moniHoursAvailable={Predicate.isString(monitorAccountId) && hasStableMonitorData}
          timeZone={timeZone}
          onSelect={selectTarget}
        />
      </div>
    </div>
  );
}

function ChannelHourNavigator({
  className,
  workspaceId,
  channels,
  eventStartEpochMs,
  scheduleStartHour,
  scheduleSummaries,
  selectedChannelName,
  selectedHour,
  currentHour,
  moniHoursAvailable,
  timeZone,
  onSelect,
}: {
  readonly className?: string;
  readonly workspaceId: string;
  readonly channels: ReadonlyArray<CheckinMessageChannel>;
  readonly eventStartEpochMs: number;
  readonly scheduleStartHour: number;
  readonly scheduleSummaries: SchedulesLoadWorkspaceSuccess["populatedSchedules"];
  readonly selectedChannelName: string;
  readonly selectedHour: number;
  readonly currentHour: number | undefined;
  readonly moniHoursAvailable: boolean;
  readonly timeZone: DateTime.TimeZone;
  readonly onSelect: (target: SelectionRequest) => void;
}) {
  const selectedChannel = channels.find(({ name }) => name === selectedChannelName) ?? channels[0]!;
  return (
    <aside
      className={`min-w-0 border-b border-t border-[#33ccbb]/15 bg-[#09110f] p-4 lg:border-b-0 lg:border-r lg:border-t-0 lg:p-5 ${className ?? ""}`}
    >
      <div>
        <p className="font-mono text-[10px] font-black tracking-[0.2em] text-[#33ccbb]">
          RUNNING CHANNELS
        </p>
        <p className="mt-2 text-xs leading-relaxed text-white/55">
          Choose a running room, then prepare one event-relative hour at a time.
        </p>
      </div>
      <nav aria-label="Running channels" className="mt-4 grid gap-1">
        {channels.map((channel) => (
          <RunningChannelButton
            key={channel.name}
            channel={channel}
            selected={channel.name === selectedChannel.name}
            currentHour={currentHour}
            onSelect={onSelect}
          />
        ))}
      </nav>

      <EventRelativeHourPicker
        workspaceId={workspaceId}
        channel={selectedChannel}
        eventStartEpochMs={eventStartEpochMs}
        scheduleStartHour={scheduleStartHour}
        scheduleSummaries={scheduleSummaries}
        selectedHour={selectedHour}
        currentHour={currentHour}
        moniHoursAvailable={moniHoursAvailable}
        timeZone={timeZone}
        onSelect={onSelect}
      />
      <div className="mt-5 flex flex-wrap gap-x-3 gap-y-2 border-t border-white/10 pt-4 text-[10px] font-bold text-white/45">
        <span className="inline-flex items-center gap-1.5">
          <Clock3 className="h-3.5 w-3.5 text-[#33ccbb]" /> CURRENT HOUR
        </span>
        {moniHoursAvailable ? (
          <span className="inline-flex items-center gap-1.5">
            <UserRound className="h-3.5 w-3.5 text-[#ffb86b]" /> YOUR MONI HOUR
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[#ffca8b]">
            <Info className="h-3.5 w-3.5" /> MONI MARKERS UNAVAILABLE
          </span>
        )}
      </div>
    </aside>
  );
}

function EventRelativeHourPicker({
  workspaceId,
  channel,
  eventStartEpochMs,
  scheduleStartHour,
  scheduleSummaries,
  selectedHour,
  currentHour,
  moniHoursAvailable,
  timeZone,
  onSelect,
}: {
  readonly workspaceId: string;
  readonly channel: CheckinMessageChannel;
  readonly eventStartEpochMs: number;
  readonly scheduleStartHour: number;
  readonly scheduleSummaries: SchedulesLoadWorkspaceSuccess["populatedSchedules"];
  readonly selectedHour: number;
  readonly currentHour: number | undefined;
  readonly moniHoursAvailable: boolean;
  readonly timeZone: DateTime.TimeZone;
  readonly onSelect: (target: SelectionRequest) => void;
}) {
  const { result: messagesResult } = useCheckinMessages(workspaceId, channel.name);
  const messageData = availableResultValue(messagesResult);
  const customHours = useMemo(
    () =>
      new Set(
        (messageData?.messages ?? [])
          .filter(({ template }) => template !== null)
          .map(({ hour }) => Number(hour)),
      ),
    [messageData],
  );
  const breakHours = useMemo(
    () =>
      new Set(
        scheduleSummaries.flatMap((summary) =>
          summary.conversationName.trim() === channel.name &&
          summary.hour !== null &&
          summary.break === true
            ? [summary.hour]
            : [],
        ),
      ),
    [channel.name, scheduleSummaries],
  );
  const options = useMemo(
    // fallow-ignore-next-line complexity
    () =>
      channel.hours.map(
        // fallow-ignore-next-line complexity
        (hour) => {
          const custom = customHours.has(hour);
          const current = hour === currentHour;
          const moni = moniHoursAvailable && channel.moniHours.includes(hour);
          const breakHour = breakHours.has(hour);
          const window = formatCheckinHourWindow(
            eventStartEpochMs,
            hour,
            scheduleStartHour,
            timeZone,
          );
          return {
            hour,
            window,
            custom,
            current,
            moni,
            breakHour,
            searchText: [
              "hour " + hour,
              window.label,
              custom ? "custom message" : "random default",
              current ? "now current" : "",
              moni ? "your moni" : "",
              breakHour ? "break" : "",
            ]
              .join(" ")
              .toLowerCase(),
          };
        },
      ),
    [
      breakHours,
      channel.hours,
      channel.moniHours,
      currentHour,
      customHours,
      eventStartEpochMs,
      moniHoursAvailable,
      scheduleStartHour,
      timeZone,
    ],
  );
  const selectedOption = options.find(({ hour }) => hour === selectedHour) ?? options[0]!;
  const customCount = options.filter(({ custom }) => custom).length;
  const messageStatus =
    messageData !== undefined
      ? customCount + " CUSTOM · " + (options.length - customCount) + " RANDOM DEFAULT"
      : messagesResult._tag === "Failure"
        ? "MESSAGE STATUS UNAVAILABLE"
        : "MESSAGE STATUS LOADING";

  return (
    <div className="mt-6 border-t border-[#33ccbb]/15 pt-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-black tracking-[0.2em] text-[#33ccbb]">
            EVENT-RELATIVE HOUR
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="text-lg font-black tracking-tight text-white">HOUR {selectedHour}</p>
            <span className="text-xs font-bold text-white/40">
              / {channel.hours[channel.hours.length - 1]}
            </span>
          </div>
        </div>
        <span className="pt-1 text-right text-[10px] font-bold text-white/35">
          {channel.hours.length} configured
        </span>
      </div>
      <p className="mt-2 text-[10px] font-bold tracking-wide text-white/55">
        {selectedOption.window.label} · {zoneId(timeZone)}
      </p>
      <HourSearchControl
        channelName={channel.name}
        options={options}
        selectedHour={selectedHour}
        onSelect={onSelect}
      />
      <HourNavigatorShortcuts
        channel={channel}
        options={options}
        selectedHour={selectedHour}
        currentHour={currentHour}
        messageStatus={messageStatus}
        moniHoursAvailable={moniHoursAvailable}
        onSelect={onSelect}
      />
      <p className="mt-3 text-[10px] leading-relaxed text-white/40">
        Type an hour, time, or status to search the full range. Nearby hours appear when search is
        empty.
      </p>
    </div>
  );
}

// fallow-ignore-next-line complexity
function HourSearchControl({
  channelName,
  options,
  selectedHour,
  onSelect,
}: {
  readonly channelName: string;
  readonly options: ReadonlyArray<CheckinHourOption>;
  readonly selectedHour: number;
  readonly onSelect: (target: SelectionRequest) => void;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    setQuery("");
    setSearchOpen(false);
  }, [channelName, selectedHour]);

  const normalizedQuery = query.trim().toLowerCase();
  const matchingOptions = options.filter(({ searchText }) => searchText.includes(normalizedQuery));
  const selectedIndex = options.findIndex(({ hour }) => hour === selectedHour);
  const nearbyOptions = options.slice(Math.max(0, selectedIndex - 2), selectedIndex + 4);
  const visibleOptions = normalizedQuery.length === 0 ? nearbyOptions : matchingOptions.slice(0, 8);

  const chooseHour = (hour: number) => {
    setQuery("");
    setSearchOpen(false);
    onSelect({ channelName, hour });
  };
  // fallow-ignore-next-line complexity
  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setQuery("");
      setSearchOpen(false);
      event.currentTarget.blur();
      return;
    }
    if (event.key !== "Enter") return;
    const exactOption = options.find(({ hour }) => String(hour) === normalizedQuery);
    const target = exactOption ?? visibleOptions[0];
    if (target === undefined) return;
    event.preventDefault();
    chooseHour(target.hour);
  };

  return (
    <div className="mt-3">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#33ccbb]"
        />
        <label htmlFor="checkin-message-hour-search" className="sr-only">
          Search event-relative hours for #{channelName}
        </label>
        <input
          id="checkin-message-hour-search"
          type="search"
          role="combobox"
          value={query}
          placeholder="Search hour, time, or status"
          autoComplete="off"
          aria-label={"Search event-relative hours for #" + channelName}
          aria-controls={searchOpen ? "checkin-message-hour-results" : undefined}
          aria-expanded={searchOpen}
          aria-autocomplete="list"
          className="min-h-11 w-full border border-[#33ccbb]/35 bg-[#0d1714] pl-8 pr-3 text-xs font-bold text-white outline-none transition-colors placeholder:text-white/35 focus:border-[#33ccbb] focus:ring-2 focus:ring-[#33ccbb]/20"
          onFocus={() => setSearchOpen(true)}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setSearchOpen(true);
          }}
          onKeyDown={handleSearchKeyDown}
        />
      </div>
      {searchOpen ? (
        <div
          id="checkin-message-hour-results"
          role="listbox"
          aria-label={"Matching hours for #" + channelName}
          className="mt-2 max-h-64 overflow-y-auto border border-[#33ccbb]/20 bg-[#07100e] p-1"
        >
          <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[10px] font-bold tracking-wide text-white/40">
            <span>{normalizedQuery.length === 0 ? "NEARBY HOURS" : "MATCHING HOURS"}</span>
            <span>
              {normalizedQuery.length === 0
                ? "TYPE TO SEARCH " + options.length
                : matchingOptions.length + " MATCHES"}
            </span>
          </div>
          {visibleOptions.length > 0 ? (
            visibleOptions.map((option) => (
              <HourSearchResult
                key={option.hour}
                option={option}
                selected={option.hour === selectedHour}
                onSelect={chooseHour}
              />
            ))
          ) : (
            <p className="px-2 py-3 text-xs text-white/55">No configured hours match “{query}”.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

// fallow-ignore-next-line complexity
function HourSearchResult({
  option,
  selected,
  onSelect,
}: {
  readonly option: CheckinHourOption;
  readonly selected: boolean;
  readonly onSelect: (hour: number) => void;
}) {
  const statusLabel = option.custom ? "CUSTOM" : "RANDOM DEFAULT";
  const accessibleLabel =
    "Hour " +
    option.hour +
    ", " +
    option.window.label +
    ", " +
    statusLabel +
    (option.current ? ", current hour" : "") +
    (option.moni ? ", your moni hour" : "") +
    (option.breakHour ? ", break" : "");
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-label={accessibleLabel}
      className={
        selected
          ? "flex min-h-11 w-full items-start gap-2 border border-[#33ccbb] bg-[#33ccbb]/[0.12] px-2 py-2 text-left text-white focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#73e9dc]"
          : option.current
            ? "flex min-h-11 w-full items-start gap-2 border border-[#33ccbb]/35 bg-[#33ccbb]/[0.05] px-2 py-2 text-left text-white/80 transition-colors hover:border-[#33ccbb]/60 hover:bg-[#33ccbb]/[0.1] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#73e9dc]"
            : "flex min-h-11 w-full items-start gap-2 border border-transparent px-2 py-2 text-left text-white/65 transition-colors hover:border-white/10 hover:bg-white/[0.04] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#73e9dc]"
      }
      onClick={() => onSelect(option.hour)}
    >
      <span className="w-16 shrink-0 text-xs font-black tabular-nums">HOUR {option.hour}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[10px] font-bold text-white/55">
          {option.window.label}
        </span>
        <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10px] font-black tracking-wide">
          <span className={option.custom ? "text-[#79e6d9]" : "text-white/40"}>{statusLabel}</span>
          {option.breakHour ? <span className="text-[#ffca8b]">BREAK</span> : null}
          {option.current ? <span className="text-[#79e6d9]">NOW</span> : null}
          {option.moni ? <span className="text-[#ffca8b]">YOUR MONI</span> : null}
        </span>
      </span>
    </button>
  );
}

// fallow-ignore-next-line complexity
function HourNavigatorShortcuts({
  channel,
  options,
  selectedHour,
  currentHour,
  messageStatus,
  moniHoursAvailable,
  onSelect,
}: {
  readonly channel: CheckinMessageChannel;
  readonly options: ReadonlyArray<CheckinHourOption>;
  readonly selectedHour: number;
  readonly currentHour: number | undefined;
  readonly messageStatus: string;
  readonly moniHoursAvailable: boolean;
  readonly onSelect: (target: SelectionRequest) => void;
}) {
  const customCount = options.filter(({ custom }) => custom).length;
  const nextCustomHour = nextMatchingHour(options, selectedHour, ({ custom }) => custom);
  const nextDefaultHour = nextMatchingHour(options, selectedHour, ({ custom }) => !custom);
  const shortcutClass =
    "inline-flex min-h-8 items-center gap-1.5 border border-white/15 bg-[#0a100f] px-2 text-[10px] font-black tracking-wide text-white/65 transition-colors hover:border-[#33ccbb]/50 hover:bg-[#33ccbb]/[0.08] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc]";
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-bold text-white/45">
        <span>{messageStatus}</span>
        <span>
          {moniHoursAvailable
            ? channel.moniHours.length +
              " MONI " +
              (channel.moniHours.length === 1 ? "HOUR" : "HOURS")
            : "MONI HOURS UNAVAILABLE"}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {currentHour !== undefined && channel.hours.includes(currentHour) ? (
          <button
            type="button"
            className={
              shortcutClass +
              " border-[#33ccbb]/35 bg-[#33ccbb]/[0.06] text-[#79e6d9] hover:border-[#33ccbb]/65 hover:bg-[#33ccbb]/[0.12]"
            }
            onClick={() => onSelect({ channelName: channel.name, hour: currentHour })}
          >
            <Clock3 className="h-3.5 w-3.5" />
            JUMP TO NOW
          </button>
        ) : null}
        {nextCustomHour !== undefined ? (
          <button
            type="button"
            className={shortcutClass}
            onClick={() => onSelect({ channelName: channel.name, hour: nextCustomHour })}
          >
            NEXT CUSTOM
          </button>
        ) : null}
        {nextDefaultHour !== undefined ? (
          <button
            type="button"
            className={shortcutClass}
            onClick={() => onSelect({ channelName: channel.name, hour: nextDefaultHour })}
          >
            NEXT DEFAULT
          </button>
        ) : null}
      </div>
      <span className="sr-only">
        {customCount} of {options.length} hours have custom messages.
      </span>
    </div>
  );
}

// fallow-ignore-next-line complexity
function RunningChannelButton({
  channel,
  selected,
  currentHour,
  onSelect,
}: {
  readonly channel: CheckinMessageChannel;
  readonly selected: boolean;
  readonly currentHour: number | undefined;
  readonly onSelect: (target: SelectionRequest) => void;
}) {
  const nextHour = preferredCheckinHour(channel.hours, currentHour);
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      className={`flex min-h-11 items-center gap-3 border px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#73e9dc] ${selected ? "border-[#33ccbb]/55 bg-[#33ccbb]/12 text-white" : "border-transparent text-white/60 hover:border-white/10 hover:bg-white/[0.03] hover:text-white"}`}
      onClick={() => {
        if (nextHour !== undefined) onSelect({ channelName: channel.name, hour: nextHour });
      }}
    >
      <MessageSquareText className="h-4 w-4 shrink-0 text-[#33ccbb]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold">#{channel.name}</span>
        <span className="mt-0.5 block text-[10px] font-bold tracking-wide text-white/40">
          {channel.hours.length} {channel.hours.length === 1 ? "HOUR" : "HOURS"}
        </span>
      </span>
      {selected ? <ChevronRight className="h-4 w-4 shrink-0 text-[#33ccbb]" /> : null}
    </button>
  );
}

// fallow-ignore-next-line complexity
function HourlyMessageEditor({
  workspaceId,
  channel,
  hour,
  eventStartEpochMs,
  scheduleStartHour,
  timeZone,
  isCurrentHour,
  isYourMoniHour,
  onSelect,
  onStateChange,
}: {
  readonly workspaceId: string;
  readonly channel: CheckinMessageChannel;
  readonly hour: number;
  readonly eventStartEpochMs: number;
  readonly scheduleStartHour: number;
  readonly timeZone: DateTime.TimeZone;
  readonly isCurrentHour: boolean;
  readonly isYourMoniHour: boolean;
  readonly onSelect: (target: SelectionRequest) => void;
  readonly onStateChange: (state: EditorState) => void;
}) {
  const { result, refresh } = useCheckinMessages(workspaceId, channel.name);
  const loadLatest = useLoadCheckinMessages();
  const saveCheckinMessage = useSaveCheckinMessage();
  const [loadedOverride, setLoadedOverride] = useState<CheckinMessagesLoadSuccess>();
  const atomLoaded = availableResultValue(result);
  const atomLoadedMessageVersion =
    atomLoaded?.messages.find(({ hour: messageHour }) => messageHour === hour)?.version ?? 0;
  const atomLoadedFingerprint =
    atomLoaded === undefined
      ? result._tag
      : [
          atomLoaded.binding.eventStartEpochMs,
          atomLoaded.binding.messageSetGeneration,
          atomLoaded.messages.length,
          atomLoadedMessageVersion,
        ].join(":");
  const observedAtomLoadedFingerprintRef = useRef(atomLoadedFingerprint);
  const loaded = loadedOverride ?? atomLoaded;
  const message = loaded === undefined ? undefined : checkinMessageForHour(loaded, hour);
  const hourWindow = formatCheckinHourWindow(eventStartEpochMs, hour, scheduleStartHour, timeZone);
  const incomingTemplate = message?.template ?? null;
  const incomingBinding = loaded?.binding;
  const incomingFingerprint = loaded
    ? `${loaded.binding.eventStartEpochMs}:${loaded.binding.messageSetGeneration}:${message?.version ?? 0}:${message?.template ?? "<random>"}`
    : undefined;
  const incomingBindingFingerprint = loaded
    ? `${loaded.binding.eventStartEpochMs}:${loaded.binding.messageSetGeneration}`
    : undefined;
  const [draft, setDraft] = useState("");
  const [savedTemplate, setSavedTemplate] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<EditorStatus>({ kind: "idle" });
  const [conflict, setConflict] = useState<ConflictReview>();
  const observedFingerprintRef = useRef<string | undefined>(undefined);
  const observedBindingFingerprintRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (observedAtomLoadedFingerprintRef.current === atomLoadedFingerprint) return;
    observedAtomLoadedFingerprintRef.current = atomLoadedFingerprint;
    setLoadedOverride(undefined);
  }, [atomLoadedFingerprint]);

  const dirty = draft !== (savedTemplate ?? "");
  const blocker = useBlocker<RegisteredRouter, true>({
    shouldBlockFn: () => dirty && !saving,
    enableBeforeUnload: false,
    withResolver: true,
  });

  // fallow-ignore-next-line complexity
  useEffect(() => {
    onStateChange({ dirty, saving });
  }, [dirty, onStateChange, saving]);

  // fallow-ignore-next-line complexity
  useEffect(() => {
    if (incomingFingerprint === undefined || loaded === undefined) return;
    const bindingChanged =
      observedBindingFingerprintRef.current !== undefined &&
      observedBindingFingerprintRef.current !== incomingBindingFingerprint;
    if (!initialized) {
      observedFingerprintRef.current = incomingFingerprint;
      observedBindingFingerprintRef.current = incomingBindingFingerprint;
      setDraft(incomingTemplate ?? "");
      setSavedTemplate(incomingTemplate);
      setInitialized(true);
      return;
    }
    if (observedFingerprintRef.current === incomingFingerprint) return;
    observedFingerprintRef.current = incomingFingerprint;
    observedBindingFingerprintRef.current = incomingBindingFingerprint;
    if (!dirty && !saving && conflict === undefined) {
      setDraft(incomingTemplate ?? "");
      setSavedTemplate(incomingTemplate);
      return;
    }
    setSavedTemplate(incomingTemplate);
    if (!saving) {
      setConflict(
        (current) =>
          current ?? {
            kind: bindingChanged ? "event-binding" : "row-version",
            latestTemplate: incomingTemplate,
            currentVersion: message?.version,
            refreshing: false,
            refreshError: undefined,
          },
      );
    }
  }, [
    conflict,
    dirty,
    incomingBindingFingerprint,
    incomingFingerprint,
    incomingTemplate,
    initialized,
    loaded,
    saving,
  ]);

  useEffect(() => {
    if (status.kind !== "success") return;
    const timeout = window.setTimeout(() => setStatus({ kind: "idle" }), 4500);
    return () => window.clearTimeout(timeout);
  }, [status]);

  const refreshLatest = useCallback(
    // fallow-ignore-next-line complexity
    async (kind: ConflictReview["kind"], currentVersion?: number) => {
      setConflict(
        // fallow-ignore-next-line complexity
        (current) => ({
          kind,
          latestTemplate:
            current?.latestTemplate !== undefined ? current.latestTemplate : savedTemplate,
          currentVersion: current?.currentVersion ?? currentVersion,
          refreshing: true,
          refreshError: undefined,
        }),
      );
      try {
        const latest = await loadLatest({ workspaceId, conversationName: channel.name });
        const latestMessage = checkinMessageForHour(latest, hour);
        setLoadedOverride(latest);
        setSavedTemplate(latestMessage?.template ?? null);
        // fallow-ignore-next-line complexity
        setConflict((current) =>
          current
            ? {
                ...current,
                latestTemplate: latestMessage?.template ?? null,
                currentVersion: latestMessage?.version ?? current?.currentVersion,
                refreshing: false,
                refreshError: undefined,
              }
            : current,
        );
      } catch {
        setConflict((current) =>
          current
            ? {
                ...current,
                refreshing: false,
                refreshError: "The latest saved value could not be loaded. Retry before saving.",
              }
            : current,
        );
      }
    },
    [channel.name, hour, loadLatest, savedTemplate, workspaceId],
  );

  // fallow-ignore-next-line complexity
  const save = useCallback(async () => {
    if (loaded === undefined || incomingBinding === undefined || saving || !dirty) return;
    setSaving(true);
    setStatus({ kind: "idle" });
    try {
      const result = await saveCheckinMessage({
        workspaceId,
        conversationId: loaded.conversationId,
        binding: incomingBinding,
        hour,
        template: normalizeCheckinTemplate(draft),
        expectedVersion: message?.version ?? 0,
        responseReference: `sheet-web:checkin-message:${globalThis.crypto.randomUUID()}`,
      });
      setLoadedOverride(withSavedCheckinMessage(loaded, result.message));
      setDraft(result.message.template ?? "");
      setSavedTemplate(result.message.template);
      setConflict(undefined);
      setStatus({
        kind: "success",
        message:
          result.message.template === null
            ? "Random default restored for this hour."
            : "Custom check-in message saved.",
      });
    } catch (error) {
      const declaredFailure = declaredWorkflowFailure(error);
      if (isCheckinMessageConflict(declaredFailure)) {
        await refreshLatest(declaredFailure.kind, declaredFailure.currentVersion);
      } else {
        setStatus({
          kind: "error",
          message: `Message not saved. Your draft is still here. ${errorText(error)}`,
        });
      }
    } finally {
      setSaving(false);
    }
  }, [
    dirty,
    draft,
    hour,
    incomingBinding,
    loaded,
    message?.version,
    refreshLatest,
    saveCheckinMessage,
    saving,
    workspaceId,
  ]);

  const retryWithDraft = () => {
    if (conflict === undefined || conflict.refreshing || conflict.refreshError !== undefined)
      return;
    setConflict(undefined);
    void save();
  };

  // fallow-ignore-next-line complexity
  const applyLatest = () => {
    if (conflict === undefined || conflict.refreshing || conflict.latestTemplate === undefined)
      return;
    setDraft(conflict.latestTemplate ?? "");
    setSavedTemplate(conflict.latestTemplate);
    setConflict(undefined);
    setStatus({ kind: "success", message: "Draft replaced with the latest saved message." });
  };

  if (loaded === undefined) {
    return (
      <MessageEditorResource
        resultTag={result._tag}
        onRetry={() => {
          setLoadedOverride(undefined);
          refresh();
        }}
      />
    );
  }

  const custom = savedTemplate !== null;
  const hourIndex = channel.hours.indexOf(hour);
  const previousHour = hourIndex > 0 ? channel.hours[hourIndex - 1] : undefined;
  const nextHour = hourIndex < channel.hours.length - 1 ? channel.hours[hourIndex + 1] : undefined;
  const preview =
    draft.trim().length === 0
      ? undefined
      : renderCheckinExample(draft, {
          "{{mentionsString}}": "@Airi @Emu",
          "{{conversationString}}": `#${channel.name}`,
          "{{hourString}}": `hour ${hour}`,
          "{{timeStampString}}": hourWindow.time,
        });

  return (
    <div className="min-w-0">
      <header className="border-b border-[#33ccbb]/20 bg-[#0f1615] px-4 py-4 sm:px-7 sm:py-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[10px] font-black tracking-[0.18em] text-[#33ccbb]">
              <span>CHECK-IN MESSAGE</span>
              <span aria-hidden="true" className="text-[#33ccbb]/40">
                /
              </span>
              <span className="text-white/55">#{channel.name}</span>
            </div>
            <h2 className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-2xl font-black tracking-tight text-white">
              <span>Schedule hour {hour}</span>
              {isCurrentHour ? (
                <span className="text-sm font-black tracking-wide text-[#33ccbb]">NOW</span>
              ) : null}
            </h2>
            <p className="mt-2 hidden text-xs leading-relaxed text-white/55 sm:block">
              Event started {formatEventStart(eventStartEpochMs)}. Selected window{" "}
              <span className="font-bold text-white/75">
                {hourWindow.label} · {zoneId(timeZone)}
              </span>
              . This saved message belongs to this running channel and event.
            </p>
            <p className="mt-2 text-[10px] font-bold leading-relaxed text-white/55 sm:hidden">
              {hourWindow.label} · {zoneId(timeZone)} ·{" "}
              <span className={custom ? "text-[#79e6d9]" : "text-white/45"}>
                {custom ? "CUSTOM" : "RANDOM DEFAULT"}
              </span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:max-w-[24rem] sm:justify-end">
            <div className="flex min-w-0 flex-1 gap-2 sm:flex-none">
              <button
                type="button"
                aria-label={
                  previousHour === undefined
                    ? "Previous hour unavailable"
                    : `Previous hour ${previousHour}`
                }
                className={hourStepButtonClass}
                disabled={previousHour === undefined}
                onClick={() => {
                  if (previousHour !== undefined) {
                    onSelect({ channelName: channel.name, hour: previousHour });
                  }
                }}
              >
                <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                <span>PREVIOUS</span>
              </button>
              <button
                type="button"
                aria-label={
                  nextHour === undefined ? "Next hour unavailable" : `Next hour ${nextHour}`
                }
                className={hourStepButtonClass}
                disabled={nextHour === undefined}
                onClick={() => {
                  if (nextHour !== undefined) {
                    onSelect({ channelName: channel.name, hour: nextHour });
                  }
                }}
              >
                <span>NEXT</span>
                <ChevronRight aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
            <div className="hidden flex-wrap gap-2 sm:flex sm:justify-end">
              {isCurrentHour ? (
                <StateBadge icon={<Clock3 />} tone="teal">
                  CURRENT HOUR
                </StateBadge>
              ) : null}
              {isYourMoniHour ? (
                <StateBadge icon={<UserRound />} tone="amber">
                  YOUR MONI HOUR
                </StateBadge>
              ) : null}
              <StateBadge tone={custom ? "white" : "muted"}>
                {custom ? "CUSTOM MESSAGE" : "RANDOM DEFAULT"}
              </StateBadge>
            </div>
          </div>
        </div>
      </header>

      <div className="grid min-w-0 gap-px bg-[#33ccbb]/15 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <form
          className="min-w-0 space-y-5 bg-[#0a100f] p-4 sm:space-y-6 sm:p-7"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div>
            <label htmlFor="checkin-message-template" className="text-xs font-black tracking-wide">
              MESSAGE TEXT
            </label>
            <p
              id="checkin-message-template-help"
              className="mb-2 mt-1 max-w-2xl text-xs leading-relaxed text-white/55"
            >
              <span className="sm:hidden">
                Optional. Blank restores the random default for this hour.
              </span>
              <span className="hidden sm:inline">
                Optional template used when this hour opens. Leave it blank to restore TiaraBot’s
                randomized default. Editing stays in a native text area for reliable keyboard and
                IME behavior.
              </span>
            </p>
            <TemplateEditor
              id="checkin-message-template"
              value={draft}
              disabled={saving}
              ariaDescribedBy="checkin-message-template-help"
              onChange={setDraft}
            />
            <p className="mt-2 hidden text-[10px] font-bold tracking-wide text-white/40 sm:block">
              Supported placeholders are optional and highlighted above. Unknown template text is
              preserved as written.
            </p>
          </div>

          {conflict ? (
            <ConflictReview
              conflict={conflict}
              draft={draft}
              onRetryRefresh={() => void refreshLatest(conflict.kind, conflict.currentVersion)}
              onUseLatest={applyLatest}
              onRetryWithDraft={retryWithDraft}
            />
          ) : null}

          <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-5">
            <button
              type="submit"
              disabled={!dirty || saving || conflict !== undefined}
              className={primaryButtonClass}
            >
              {saving ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {saving ? "SAVING" : "SAVE MESSAGE"}
            </button>
            <span className={`font-mono text-xs ${dirty ? "text-[#ffb86b]" : "text-white/45"}`}>
              {dirty ? "UNSAVED DRAFT" : "SAVED"}
            </span>
          </div>
          <EditorStatusMessage status={status} />
          <p className="flex items-start gap-2 text-xs leading-relaxed text-white/40">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#33ccbb]/70" />
            <span>Saving a blank value restores the random default for this hour only.</span>
          </p>
        </form>

        <aside className="min-w-0 space-y-6 bg-[#0b1210] p-4 sm:p-7">
          <PlaceholderReference />
          <ExamplePreview
            channelName={channel.name}
            hour={hour}
            hourWindow={hourWindow}
            timeZone={timeZone}
            preview={preview}
          />
        </aside>
      </div>
      <NavigationConfirmation blocker={blocker} subject="check-in message draft" />
      {loaded.conversationName === null ? (
        <div className="border-t border-[#ffb86b]/25 bg-[#ffb86b]/[0.04] px-4 py-3 text-xs text-[#ffca8b] sm:px-7">
          The selected running channel no longer has a display name. Refresh the schedule before
          trying another save.
        </div>
      ) : null}
    </div>
  );
}

type EditorStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "success"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

type ConflictReview = {
  readonly kind: "event-binding" | "row-version" | "replayed-input";
  readonly latestTemplate: string | null | undefined;
  readonly currentVersion: number | undefined;
  readonly refreshing: boolean;
  readonly refreshError: string | undefined;
};

type ConflictCopy = {
  readonly title: string;
  readonly description: string;
  readonly overwriteLabel: string;
};

const conflictCopy: Record<ConflictReview["kind"], ConflictCopy> = {
  "event-binding": {
    title: "The event changed while you were editing",
    description:
      "The event binding changed. Your draft is preserved; refresh it before applying the message to the new event.",
    overwriteLabel: "REAPPLY TO NEW EVENT",
  },
  "replayed-input": {
    title: "This save was already received",
    description:
      "This save request was already accepted. Your draft is preserved; confirm the saved value below.",
    overwriteLabel: "USE SAVED VALUE",
  },
  "row-version": {
    title: "This hour was saved somewhere else",
    description:
      "A newer value exists. Your draft is preserved. Use the latest value or explicitly overwrite it.",
    overwriteLabel: "OVERWRITE WITH MY DRAFT",
  },
};

type ConflictDiffLine = {
  readonly kind: "same" | "added" | "removed";
  readonly value: string;
};

// fallow-ignore-next-line complexity
const diffCheckinTemplateLines = (
  draft: string,
  latestTemplate: string | null,
): ReadonlyArray<ConflictDiffLine> => {
  const draftLines = (draft.length > 0 ? draft : "(empty draft)").split(/\r?\n/u);
  const latestLines = (latestTemplate ?? "(random default)").split(/\r?\n/u);
  const matrix = Array.from({ length: draftLines.length + 1 }, () =>
    Array<number>(latestLines.length + 1).fill(0),
  );

  for (let draftIndex = draftLines.length - 1; draftIndex >= 0; draftIndex -= 1) {
    for (let latestIndex = latestLines.length - 1; latestIndex >= 0; latestIndex -= 1) {
      matrix[draftIndex]![latestIndex] =
        draftLines[draftIndex] === latestLines[latestIndex]
          ? matrix[draftIndex + 1]![latestIndex + 1]! + 1
          : Math.max(matrix[draftIndex + 1]![latestIndex]!, matrix[draftIndex]![latestIndex + 1]!);
    }
  }

  const lines: Array<ConflictDiffLine> = [];
  let draftIndex = 0;
  let latestIndex = 0;
  while (draftIndex < draftLines.length || latestIndex < latestLines.length) {
    if (
      draftIndex < draftLines.length &&
      latestIndex < latestLines.length &&
      draftLines[draftIndex] === latestLines[latestIndex]
    ) {
      lines.push({ kind: "same", value: draftLines[draftIndex]! });
      draftIndex += 1;
      latestIndex += 1;
    } else if (
      latestIndex < latestLines.length &&
      (draftIndex === draftLines.length ||
        matrix[draftIndex]![latestIndex + 1]! >= matrix[draftIndex + 1]![latestIndex]!)
    ) {
      lines.push({ kind: "added", value: latestLines[latestIndex]! });
      latestIndex += 1;
    } else {
      lines.push({ kind: "removed", value: draftLines[draftIndex]! });
      draftIndex += 1;
    }
  }
  return lines;
};

function ConflictDiff({
  draft,
  latestTemplate,
}: {
  readonly draft: string;
  readonly latestTemplate: string | null;
}) {
  const lines = diffCheckinTemplateLines(draft, latestTemplate);
  const hasChanges = lines.some(({ kind }) => kind !== "same");
  return (
    <div
      role="region"
      aria-label="Difference between your draft and the latest saved value"
      className="mt-4 border border-white/10 bg-[#07100e] p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-black tracking-[0.16em] text-white/50">INLINE DIFF</p>
        <span className="text-[10px] font-bold text-white/40">
          {hasChanges ? "DRAFT VS LATEST" : "VALUES MATCH"}
        </span>
      </div>
      <div className="mt-2 overflow-x-auto font-mono text-xs leading-5">
        {lines.map((line, index) => (
          <ConflictDiffRow key={index} line={line} />
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-white/40">
        Added lines are in the latest saved value; removed lines exist only in your draft.
      </p>
    </div>
  );
}

function ConflictDiffRow({ line }: { readonly line: ConflictDiffLine }) {
  const marker = { same: " ", added: "+", removed: "-" }[line.kind];
  const lineClass = {
    same: "text-white/55",
    added: "bg-[#33ccbb]/10 text-[#9af3e7]",
    removed: "bg-[#ff6257]/10 text-[#ffaaa3]",
  }[line.kind];
  return (
    <div className={lineClass}>
      <span aria-hidden="true" className="inline-block w-4 select-none text-center">
        {marker}
      </span>
      <span className="whitespace-pre">{line.value || " "}</span>
    </div>
  );
}

// fallow-ignore-next-line complexity
function ConflictReview({
  conflict,
  draft,
  onRetryRefresh,
  onUseLatest,
  onRetryWithDraft,
}: {
  readonly conflict: ConflictReview;
  readonly draft: string;
  readonly onRetryRefresh: () => void;
  readonly onUseLatest: () => void;
  readonly onRetryWithDraft: () => void;
}) {
  const { title, description, overwriteLabel } = conflictCopy[conflict.kind];
  return (
    <div role="alert" className="border border-[#ffb86b]/45 bg-[#ffb86b]/[0.06] p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#ffb86b]" />
        <div className="min-w-0">
          <h3 className="text-sm font-black text-[#ffca8b]">{title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-white/60">{description}</p>
          {conflict.currentVersion !== undefined ? (
            <p className="mt-2 text-[10px] font-bold tracking-wide text-white/45">
              LATEST SAVED VERSION {conflict.currentVersion}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <ReviewValue label="YOUR DRAFT" value={draft} />
        <ReviewValue
          label={conflict.refreshError ? "LAST KNOWN SAVED VALUE" : "LATEST SAVED VALUE"}
          value={conflict.latestTemplate}
          loading={conflict.refreshing}
        />
      </div>
      {conflict.latestTemplate !== undefined ? (
        <ConflictDiff draft={draft} latestTemplate={conflict.latestTemplate} />
      ) : null}
      {conflict.refreshError ? (
        <p className="mt-3 text-xs font-bold text-[#ff9b94]">{conflict.refreshError}</p>
      ) : null}
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          className={
            secondaryButtonClass + " border-[#ffb86b]/40 text-[#ffca8b] hover:bg-[#ffb86b]/10"
          }
          onClick={onRetryRefresh}
          disabled={conflict.refreshing}
        >
          {conflict.refreshing ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCcw className="h-4 w-4" />
          )}
          REFRESH LATEST
        </button>
        <button
          type="button"
          className={primaryButtonClass}
          onClick={onUseLatest}
          disabled={conflict.refreshing || conflict.latestTemplate === undefined}
        >
          {conflict.kind === "replayed-input" ? "USE SAVED VALUE" : "USE LATEST"}
        </button>
        {conflict.kind !== "replayed-input" ? (
          <button
            type="button"
            className={
              secondaryButtonClass + " border-[#ffb86b]/40 text-[#ffca8b] hover:bg-[#ffb86b]/10"
            }
            onClick={onRetryWithDraft}
            disabled={
              conflict.refreshing ||
              conflict.refreshError !== undefined ||
              conflict.latestTemplate === undefined
            }
          >
            {overwriteLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// fallow-ignore-next-line complexity
function ReviewValue({
  label,
  value,
  loading = false,
}: {
  readonly label: string;
  readonly value: string | null | undefined;
  readonly loading?: boolean;
}) {
  return (
    <div className="min-w-0 border border-white/10 bg-[#07100e] p-3">
      <p className="text-[10px] font-black tracking-[0.16em] text-white/40">{label}</p>
      <div className="mt-2 min-h-16 whitespace-pre-wrap break-words text-xs leading-relaxed text-white/75">
        {loading ? (
          <span className="inline-flex items-center gap-2 text-[#ffca8b]">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            Loading latest value…
          </span>
        ) : value === undefined ? (
          "Latest value unavailable."
        ) : value === null || value.length === 0 ? (
          <span className="text-white/45">Random default</span>
        ) : (
          value
        )}
      </div>
    </div>
  );
}

function TemplateEditor({
  id,
  value,
  disabled,
  ariaDescribedBy,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly ariaDescribedBy: string;
  readonly onChange: (value: string) => void;
}) {
  const highlightRef = useRef<HTMLDivElement>(null);
  return (
    <div className="relative min-h-56 border border-[#33ccbb]/30 bg-[#07100e] transition-colors focus-within:border-[#33ccbb] focus-within:ring-2 focus-within:ring-[#33ccbb]/15">
      <div
        ref={highlightRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-sm leading-6 text-white/85"
      >
        {tokenizeCheckinTemplate(value).map((part, index) =>
          part.kind === "placeholder" ? (
            <mark
              key={`${part.token}-${index}`}
              className="border border-[#33ccbb]/45 bg-[#33ccbb]/20 px-1 text-[#b8fff5]"
            >
              {part.token}
            </mark>
          ) : (
            <span key={`${part.value}-${index}`}>{part.value}</span>
          ),
        )}
        {value.endsWith("\n") ? " " : null}
      </div>
      <textarea
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={ariaDescribedBy}
        aria-label="Check-in message template"
        rows={8}
        spellCheck
        className="relative block min-h-56 w-full resize-y overflow-auto bg-transparent p-4 font-mono text-sm leading-6 text-transparent caret-[#73e9dc] outline-none placeholder:text-white/30 selection:bg-[#33ccbb]/30 disabled:cursor-not-allowed disabled:opacity-45"
        placeholder="Example: {{mentionsString}} check in for {{hourString}}."
        onScroll={(event) => {
          if (highlightRef.current === null) return;
          highlightRef.current.scrollTop = event.currentTarget.scrollTop;
          highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function PlaceholderReference() {
  return (
    <section aria-labelledby="placeholder-reference-title">
      <div className="flex items-center justify-between gap-3">
        <h3 id="placeholder-reference-title" className="text-sm font-black text-white">
          Placeholder reference
        </h3>
        <span className="font-mono text-[10px] font-black tracking-[0.16em] text-[#33ccbb]">
          OPTIONAL
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-white/55">
        These values are filled in when TiaraBot prepares the selected hour. You can use any, all,
        or none of them.
      </p>
      <dl className="mt-4 space-y-3">
        {checkinPlaceholderDefinitions.map(({ token, label, description }) => (
          <div key={token} className="border-t border-white/10 pt-3">
            <dt>
              <code className="break-all border border-[#33ccbb]/35 bg-[#33ccbb]/[0.08] px-1.5 py-1 font-mono text-xs text-[#b8fff5]">
                {token}
              </code>
            </dt>
            <dd className="mt-2 text-xs leading-relaxed text-white/60">
              <span className="font-bold text-white/80">{label}.</span> {description}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ExamplePreview({
  channelName,
  hour,
  hourWindow,
  timeZone,
  preview,
}: {
  readonly channelName: string;
  readonly hour: number;
  readonly hourWindow: HourWindowLabel;
  readonly timeZone: DateTime.TimeZone;
  readonly preview: string | undefined;
}) {
  return (
    <section aria-labelledby="checkin-example-title" className="border-t border-[#33ccbb]/20 pt-5">
      <div className="flex items-center gap-2">
        <MessageSquareText className="h-4 w-4 text-[#33ccbb]" />
        <h3 id="checkin-example-title" className="text-sm font-black text-white">
          EXAMPLE PREVIEW
        </h3>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-white/55">
        Illustrative values for <span className="font-bold text-white/75">#{channelName}</span>,
        schedule hour {hour} · {hourWindow.label} · {zoneId(timeZone)}.
      </p>
      <div className="mt-4 border border-[#33ccbb]/25 bg-[#07100e] p-4">
        {preview === undefined ? (
          <div>
            <p className="font-mono text-[10px] font-black tracking-[0.16em] text-[#33ccbb]">
              RANDOM DEFAULT
            </p>
            <p className="mt-2 text-xs leading-relaxed text-white/60">
              A randomized check-in message will be selected when this hour opens.
            </p>
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-white/85">
            {preview}
          </p>
        )}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-white/40">
        This is a preview only. The saved template is rendered with the live participants and time
        window when TiaraBot prepares a check-in.
      </p>
    </section>
  );
}

function EditorStatusMessage({ status }: { readonly status: EditorStatus }) {
  return (
    <>
      <div role="status" aria-live="polite">
        {status.kind === "success" ? (
          <div className="flex items-start gap-2 border border-[#33ccbb]/35 bg-[#33ccbb]/10 px-3 py-2 text-xs font-bold text-[#79e6d9]">
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
            {status.message}
          </div>
        ) : null}
      </div>
      <div role="alert" aria-live="assertive">
        {status.kind === "error" ? (
          <div className="flex items-start gap-2 border border-[#ff6257]/35 bg-[#ff6257]/10 px-3 py-2 text-xs font-bold text-[#ff9b94]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {status.message}
          </div>
        ) : null}
      </div>
    </>
  );
}

// fallow-ignore-next-line complexity
function MessageEditorResource({
  resultTag,
  onRetry,
}: {
  readonly resultTag: ResultTag;
  readonly onRetry: () => void;
}) {
  const failed = resultTag === "Failure";
  return (
    <div className="flex min-h-[32rem] items-center justify-center bg-[#0a100f] p-8">
      <div className="max-w-md text-center">
        {failed ? (
          <AlertTriangle className="mx-auto h-7 w-7 text-[#ffb86b]" />
        ) : (
          <div className="mx-auto grid w-full max-w-xs gap-3" aria-hidden="true">
            <div className="h-4 animate-pulse bg-[#33ccbb]/10" />
            <div className="h-24 animate-pulse bg-white/[0.05]" />
            <div className="h-4 w-2/3 animate-pulse bg-white/[0.05]" />
          </div>
        )}
        <p className="mt-5 font-mono text-[10px] font-black tracking-[0.22em] text-[#33ccbb]">
          {failed ? "MESSAGE LOAD FAILED" : "LOADING MESSAGE"}
        </p>
        <h2 className="mt-2 text-xl font-black">
          {failed ? "Could not load this hour" : "Reading saved message"}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-white/55">
          {failed
            ? "No message was changed. Retry when the workflow service is available."
            : "Waiting for the current event binding and saved value."}
        </p>
        {failed ? (
          <button type="button" className={`${secondaryButtonClass} mt-5`} onClick={onRetry}>
            <RotateCcw className="h-4 w-4" />
            RETRY MESSAGE
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CheckinNotice({
  icon,
  eyebrow,
  title,
  children,
}: {
  readonly icon: ReactNode;
  readonly eyebrow: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-[32rem] items-center justify-center bg-[#0a100f] p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center border border-[#33ccbb]/30 bg-[#33ccbb]/5 text-[#33ccbb]">
          {icon}
        </div>
        <p className="mt-5 font-mono text-[10px] font-black tracking-[0.22em] text-[#33ccbb]">
          {eyebrow}
        </p>
        <h2 className="mt-2 text-xl font-black">{title}</h2>
        <div className="mt-2 text-sm leading-relaxed text-white/55">{children}</div>
      </div>
    </div>
  );
}

function StateBadge({
  icon,
  tone,
  children,
}: {
  readonly icon?: ReactNode;
  readonly tone: "teal" | "amber" | "white" | "muted";
  readonly children: ReactNode;
}) {
  const toneClass = {
    teal: "border-[#33ccbb]/45 bg-[#33ccbb]/12 text-[#79e6d9]",
    amber: "border-[#ffb86b]/45 bg-[#ffb86b]/10 text-[#ffca8b]",
    white: "border-white/20 bg-white/[0.04] text-white/75",
    muted: "border-white/10 text-white/45",
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[10px] font-black tracking-wide ${toneClass}`}
    >
      {icon ? <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span> : null}
      {children}
    </span>
  );
}

const errorText = (error: unknown) =>
  Predicate.isError(error) ? error.message : "The request failed. Try again.";

const isCheckinMessageConflict = (error: unknown): error is CheckinMessageConflict =>
  Predicate.isTagged("CheckinMessageConflict")(error);

const formatEventStart = (epochMs: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(epochMs),
  );

const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 border border-[#33ccbb] bg-[#33ccbb] px-4 py-2 text-xs font-black tracking-wide text-[#07100e] transition hover:bg-[#79e6d9] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc] active:translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-35";
const hourStepButtonClass =
  "inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 border border-[#33ccbb]/45 bg-[#33ccbb]/[0.06] px-3 py-2 text-[10px] font-black tracking-wide text-[#79e6d9] transition hover:border-[#33ccbb] hover:bg-[#33ccbb]/[0.12] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc] disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-transparent disabled:text-white/25 sm:flex-none";
const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 border border-white/15 bg-[#0a100f] px-4 py-2 text-xs font-black tracking-wide text-white/70 transition hover:border-[#33ccbb]/45 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#73e9dc] active:translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-35";
