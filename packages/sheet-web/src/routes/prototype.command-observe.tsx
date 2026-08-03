/**
 * PROTOTYPE — throw this route away after TIA-65 is decided.
 * Three command-and-observe interaction models, switchable with `?variant=`.
 */
import { createFileRoute } from "@tanstack/react-router";
import { Match, Predicate, Schema, pipe } from "effect";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  Menu,
  PanelRightOpen,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";

const variants = ["inline", "rail", "receipt"] as const;
type Variant = (typeof variants)[number];

const states = [
  "ready",
  "accepting",
  "queued",
  "running",
  "taking-longer",
  "success",
  "declared-failure",
  "system-failure",
  "not-accepted",
] as const;
type PrototypeState = (typeof states)[number];

const PrototypeSearch = Schema.Struct({
  variant: Schema.optional(Schema.Literals(variants)),
});

export const Route = createFileRoute("/prototype/command-observe")({
  component: CommandObservePrototype,
  validateSearch: pipe(PrototypeSearch, Schema.toStandardSchemaV1),
});

type Snapshot = {
  readonly title: string;
  readonly detail: string;
  readonly status:
    | "Ready"
    | "Sending"
    | "Queued"
    | "In progress"
    | "Completed"
    | "Needs attention"
    | "Not accepted";
  readonly tone: "neutral" | "pending" | "success" | "failure";
  readonly accepted: boolean;
  readonly terminal: boolean;
  readonly elapsed: string;
};

const snapshots: Record<PrototypeState, Snapshot> = {
  ready: {
    title: "Ready to apply",
    detail: "No action has started yet.",
    status: "Ready",
    tone: "neutral",
    accepted: false,
    terminal: false,
    elapsed: "—",
  },
  accepting: {
    title: "Starting lockdown",
    detail: "Waiting for the server to confirm the action. Nothing has changed yet.",
    status: "Sending",
    tone: "pending",
    accepted: false,
    terminal: false,
    elapsed: "0:01",
  },
  queued: {
    title: "Lockdown queued",
    detail: "The action is safely queued. You can leave this page without stopping it.",
    status: "Queued",
    tone: "pending",
    accepted: true,
    terminal: false,
    elapsed: "0:04",
  },
  running: {
    title: "Applying lockdown",
    detail: "The lockdown is being applied. This status updates automatically.",
    status: "In progress",
    tone: "pending",
    accepted: true,
    terminal: false,
    elapsed: "0:18",
  },
  "taking-longer": {
    title: "Still working",
    detail: "This is taking longer than usual. Temporary problems are retried automatically.",
    status: "In progress",
    tone: "pending",
    accepted: true,
    terminal: false,
    elapsed: "2:14",
  },
  success: {
    title: "Lockdown applied",
    detail: "#weekly-raid now follows the configured lockdown policy.",
    status: "Completed",
    tone: "success",
    accepted: true,
    terminal: true,
    elapsed: "0:26",
  },
  "declared-failure": {
    title: "Access changed",
    detail: "Your Manage Server permission was removed before TiaraBot could finish.",
    status: "Needs attention",
    tone: "failure",
    accepted: true,
    terminal: true,
    elapsed: "0:12",
  },
  "system-failure": {
    title: "Could not finish",
    detail: "Automatic retries did not work. Trying again starts a new action.",
    status: "Needs attention",
    tone: "failure",
    accepted: true,
    terminal: true,
    elapsed: "5:00",
  },
  "not-accepted": {
    title: "Lockdown did not start",
    detail:
      "The action did not start. Nothing changed and there is no background action to follow.",
    status: "Not accepted",
    tone: "failure",
    accepted: false,
    terminal: true,
    elapsed: "0:01",
  },
};

const nextActions: Record<Snapshot["status"], string> = {
  Ready: "Start action",
  Sending: "Wait here",
  Queued: "No action needed",
  "In progress": "No action needed",
  Completed: "No action needed",
  "Needs attention": "Try again",
  "Not accepted": "Try again",
};

const variantNames: Record<Variant, string> = {
  inline: "Inline continuity",
  rail: "Persistent activity rail",
  receipt: "Confirmation + progress",
};

const editableTagNames = new Set(["INPUT", "TEXTAREA"]);
const hasTagName = Predicate.hasProperty("tagName");
const hasIsContentEditable = Predicate.hasProperty("isContentEditable");

// fallow-ignore-next-line complexity -- throwaway interaction workbench target filtering
const isEditableTarget = (target: unknown) =>
  (hasTagName(target) &&
    Predicate.isString(target.tagName) &&
    editableTagNames.has(target.tagName)) ||
  (hasIsContentEditable(target) &&
    Predicate.isBoolean(target.isContentEditable) &&
    target.isContentEditable);

// fallow-ignore-next-line complexity -- throwaway interaction workbench orchestration
function CommandObservePrototype() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const variant = search.variant ?? "inline";
  const [state, setState] = useState<PrototypeState>("ready");
  const [activityOpen, setActivityOpen] = useState(true);
  const [recentActivity, setRecentActivity] = useState<Snapshot | null>(null);
  const snapshot = snapshots[state];

  const setVariant = useCallback(
    (next: Variant) => void navigate({ search: { variant: next }, replace: true }),
    [navigate],
  );

  const cycle = useCallback(
    (direction: -1 | 1) => {
      const currentIndex = variants.indexOf(variant);
      const nextIndex = (currentIndex + direction + variants.length) % variants.length;
      const next = variants[nextIndex];
      if (next !== undefined) setVariant(next);
    },
    [setVariant, variant],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (isEditableTarget(target)) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycle]);

  const startDemo = () => {
    setState("accepting");
    window.setTimeout(() => setState("queued"), 650);
    window.setTimeout(() => setState("running"), 1_450);
    window.setTimeout(() => setState("success"), 2_850);
  };

  const startOrRetry = () => {
    if (snapshot.terminal) setRecentActivity(snapshot);
    startDemo();
  };

  const dismiss = () => {
    if (snapshot.terminal) setRecentActivity(snapshot);
    setState("ready");
  };

  if (!import.meta.env.DEV && import.meta.env.VITE_ENABLE_COMMAND_OBSERVE_PROTOTYPE !== "true")
    return null;

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#080d0c] pb-36 pt-28 text-[#f3faf7]">
      <div className="pointer-events-none absolute inset-0 opacity-50 [background-image:linear-gradient(rgba(51,204,187,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(51,204,187,0.035)_1px,transparent_1px)] [background-size:32px_32px]" />
      <div className="relative mx-auto w-full max-w-[1440px] px-4 sm:px-8">
        <PrototypeHeader variant={variant} />
        <StateWorkbench state={state} onSelect={setState} onPlay={startDemo} />
        <AnimatePresence mode="wait">
          <motion.div
            key={variant}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {Match.value(variant).pipe(
              Match.when("inline", () => (
                <InlineVariant
                  state={state}
                  snapshot={snapshot}
                  onRun={startOrRetry}
                  onDismiss={dismiss}
                />
              )),
              Match.when("rail", () => (
                <RailVariant
                  state={state}
                  snapshot={snapshot}
                  activityOpen={activityOpen}
                  onActivityOpen={setActivityOpen}
                  onRun={startOrRetry}
                  onDismiss={dismiss}
                  recentActivity={recentActivity}
                />
              )),
              Match.when("receipt", () => (
                <ReceiptVariant
                  state={state}
                  snapshot={snapshot}
                  onRun={startOrRetry}
                  onDismiss={dismiss}
                />
              )),
              Match.exhaustive,
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      <PrototypeSwitcher variant={variant} onCycle={cycle} />
    </main>
  );
}

function PrototypeHeader({ variant }: { readonly variant: Variant }) {
  return (
    <header className="mb-6 flex flex-col justify-between gap-5 border-b border-[#33ccbb]/20 pb-5 lg:flex-row lg:items-end">
      <div>
        <div className="mb-3 flex items-center gap-3">
          <span className="border border-[#ffb86b]/40 bg-[#ffb86b]/10 px-2 py-1 font-mono text-[9px] font-black tracking-[0.2em] text-[#ffd09a]">
            THROWAWAY PROTOTYPE
          </span>
          <span className="font-mono text-[10px] text-white/35">BACKGROUND ACTIONS</span>
        </div>
        <h1 className="max-w-3xl text-3xl font-black tracking-[-0.04em] sm:text-5xl">
          What happens after the click?
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-white/55">
          Apply a destructive Discord lockdown, then see its progress and result in real time.
          Current model: <span className="font-bold text-[#79e6d9]">{variantNames[variant]}</span>.
        </p>
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-px bg-[#33ccbb]/20 text-xs">
        <HeaderDatum label="ACTION" value="LOCKDOWN" />
        <HeaderDatum label="CHANNEL" value="#weekly-raid" />
      </div>
    </header>
  );
}

function HeaderDatum({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-36 bg-[#0b1210] px-4 py-3">
      <p className="font-mono text-[9px] font-bold tracking-[0.18em] text-white/35">{label}</p>
      <p className="mt-1 font-mono text-xs font-bold text-white/75">{value}</p>
    </div>
  );
}

function StateWorkbench({
  state,
  onSelect,
  onPlay,
}: {
  readonly state: PrototypeState;
  readonly onSelect: (state: PrototypeState) => void;
  readonly onPlay: () => void;
}) {
  return (
    <section className="mb-6 border border-white/10 bg-[#0b1210]/95 p-3 shadow-[8px_8px_0_rgba(51,204,187,0.04)]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[#ffb86b]" />
          <p className="font-mono text-[10px] font-black tracking-[0.18em] text-white/55">
            PROTOTYPE CONTROLS · JUMP TO A SNAPSHOT
          </p>
        </div>
        <button
          type="button"
          onClick={onPlay}
          className="flex h-8 items-center gap-2 border border-[#33ccbb]/35 bg-[#33ccbb]/10 px-3 font-mono text-[10px] font-black text-[#79e6d9] hover:bg-[#33ccbb]/20"
        >
          <Play className="h-3.5 w-3.5" /> PLAY HAPPY PATH
        </button>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {states.map((candidate, index) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={candidate === state}
            onClick={() => onSelect(candidate)}
            className={`shrink-0 border px-3 py-2 text-left transition ${
              candidate === state
                ? "border-[#ffb86b] bg-[#ffb86b]/10 text-[#ffd09a]"
                : "border-white/10 bg-black/15 text-white/45 hover:border-white/25 hover:text-white/75"
            }`}
          >
            <span className="mr-2 font-mono text-[9px] opacity-50">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="text-[10px] font-black uppercase tracking-wide">
              {candidate.replaceAll("-", " ")}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

type VariantProps = {
  readonly state: PrototypeState;
  readonly snapshot: Snapshot;
  readonly onRun: () => void;
  readonly onDismiss: () => void;
};

function InlineVariant({ state, snapshot, onRun, onDismiss }: VariantProps) {
  const active = state !== "ready";
  return (
    <section className="grid gap-px bg-[#33ccbb]/15 lg:grid-cols-[minmax(0,1fr)_390px]">
      <div className="bg-[#0a100f] p-5 sm:p-7">
        <div className="mb-7 flex items-start justify-between gap-5">
          <div>
            <p className="font-mono text-[10px] font-black tracking-[0.22em] text-[#33ccbb]">
              VARIANT A · INLINE CONTINUITY
            </p>
            <h2 className="mt-2 text-2xl font-black">Channel configuration</h2>
            <p className="mt-2 max-w-xl text-sm text-white/50">
              The form stays put. Progress occupies the same action area as the click.
            </p>
          </div>
          <span className="border border-white/10 px-2 py-1 font-mono text-[9px] text-white/40">
            LOCAL FIRST
          </span>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <FakeField label="LOGICAL NAME" value="weekly-raid" />
          <FakeField label="LOCKDOWN ROLE" value="@Raid Team" />
          <FakeField label="CHECK-IN CHANNEL" value="#raid-check-in" />
          <FakeField label="RUNNING" value="Enabled" />
        </div>

        <div className="mt-7 flex flex-wrap items-center gap-3 border-t border-white/10 pt-5">
          <button type="button" className={primaryButtonClass}>
            <Check className="h-4 w-4" /> SAVE CHANNEL
          </button>
          <span className="font-mono text-[10px] text-white/35">NO UNSAVED CHANGES</span>
        </div>
      </div>

      <aside className="bg-[#08100e] p-5 sm:p-7">
        <div className="flex h-11 w-11 items-center justify-center border border-[#33ccbb]/35 bg-[#33ccbb]/10 text-[#33ccbb]">
          <LockKeyhole className="h-5 w-5" />
        </div>
        <h3 className="mt-4 text-lg font-black">Permission lockdown</h3>
        <p className="mt-2 text-xs leading-5 text-white/50">
          Replaces explicit permission overwrites for #weekly-raid.
        </p>

        {!active ? (
          <div className="mt-6 space-y-3">
            <button type="button" onClick={onRun} className={`${primaryButtonClass} w-full`}>
              <LockKeyhole className="h-4 w-4" /> SETUP LOCKDOWN
            </button>
            <button type="button" className={`${secondaryButtonClass} w-full`}>
              <RotateCcw className="h-4 w-4" /> UNDO LOCKDOWN
            </button>
          </div>
        ) : (
          <InlineRunState state={state} snapshot={snapshot} onRun={onRun} onDismiss={onDismiss} />
        )}
      </aside>
    </section>
  );
}

// fallow-ignore-next-line complexity -- throwaway state-comparison surface
function InlineRunState({ state, snapshot, onRun, onDismiss }: VariantProps) {
  return (
    <motion.div
      key={state}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`mt-6 border p-4 ${toneClass(snapshot.tone)}`}
    >
      <div className="flex items-start gap-3">
        <StateIcon snapshot={snapshot} />
        <div className="min-w-0 flex-1">
          <p className="font-black">{snapshot.title}</p>
          <p className="mt-1 text-xs leading-5 opacity-70">{snapshot.detail}</p>
        </div>
      </div>
      <RunFacts snapshot={snapshot} compact />
      <div className="mt-4 flex flex-wrap gap-2">
        {snapshot.accepted && !snapshot.terminal ? (
          <button type="button" className={secondaryButtonClass}>
            CONTINUE IN BACKGROUND <ChevronRight className="h-4 w-4" />
          </button>
        ) : null}
        {snapshot.terminal && snapshot.tone === "failure" ? (
          <button type="button" onClick={onRun} className={primaryButtonClass}>
            TRY AGAIN <RotateCcw className="h-4 w-4" />
          </button>
        ) : null}
        {snapshot.terminal ? (
          <button type="button" onClick={onDismiss} className={secondaryButtonClass}>
            DISMISS <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </motion.div>
  );
}

// fallow-ignore-next-line complexity -- throwaway structurally distinct variant
function RailVariant({
  state,
  snapshot,
  activityOpen,
  onActivityOpen,
  onRun,
  onDismiss,
  recentActivity,
}: VariantProps & {
  readonly activityOpen: boolean;
  readonly onActivityOpen: (open: boolean) => void;
  readonly recentActivity: Snapshot | null;
}) {
  return (
    <section className="relative min-h-[610px] overflow-hidden border border-[#d7e4ff]/15 bg-[#10141d] text-[#eff4ff] shadow-[0_28px_80px_rgba(0,0,0,0.28)]">
      <header className="flex items-center justify-between border-b border-white/10 bg-[#151a25] px-5 py-4">
        <div className="flex items-center gap-3">
          <button type="button" className="grid h-9 w-9 place-items-center border border-white/10">
            <Menu className="h-4 w-4" />
          </button>
          <div>
            <p className="font-serif text-lg font-bold">Atlas Collective</p>
            <p className="text-[10px] uppercase tracking-[0.18em] text-[#8fa6cc]">
              Variant B · persistent activity rail
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onActivityOpen(!activityOpen)}
          className="flex h-9 items-center gap-2 rounded-full border border-[#8fb4ff]/25 bg-[#8fb4ff]/10 px-4 text-xs font-bold text-[#b8ceff]"
        >
          <PanelRightOpen className="h-4 w-4" /> ACTIVITY {state === "ready" ? "0" : "1"}
        </button>
      </header>

      <div
        className={`grid min-h-[552px] transition-[grid-template-columns] ${activityOpen ? "lg:grid-cols-[1fr_380px]" : "lg:grid-cols-1"}`}
      >
        <div className="p-6 sm:p-9">
          <nav className="mb-10 flex items-center gap-2 text-xs text-[#8fa6cc]">
            <span>Servers</span>
            <ChevronRight className="h-3.5 w-3.5" />
            <span>Atlas Collective</span>
            <ChevronRight className="h-3.5 w-3.5" />
            <span className="text-white">#weekly-raid</span>
          </nav>
          <div className="max-w-3xl">
            <p className="font-serif text-4xl font-bold tracking-tight">Channel permissions</p>
            <p className="mt-3 max-w-xl text-sm leading-6 text-[#a9b5cb]">
              Actions leave the page immediately and join a shell-level activity rail that survives
              navigation.
            </p>
          </div>

          <div className="mt-9 grid gap-4 sm:grid-cols-2">
            <SoftFact label="Logical name" value="weekly-raid" />
            <SoftFact label="Lockdown role" value="@Raid Team" />
          </div>

          <div className="mt-7 rounded-2xl border border-[#ffce8a]/20 bg-[#ffce8a]/[0.04] p-5">
            <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
              <div>
                <p className="font-serif text-xl font-bold">Apply lockdown policy</p>
                <p className="mt-1 text-sm text-[#a9b5cb]">
                  Existing Discord permission overwrites will be replaced.
                </p>
              </div>
              <button
                type="button"
                onClick={onRun}
                className="h-11 rounded-full bg-[#ffce8a] px-6 text-xs font-black text-[#242019] shadow-[0_8px_28px_rgba(255,206,138,0.16)] hover:bg-[#ffe0b4]"
              >
                APPLY LOCKDOWN
              </button>
            </div>
          </div>
          <button
            type="button"
            className="mt-8 flex items-center gap-2 text-xs font-bold text-[#9db9f0]"
          >
            <ArrowLeft className="h-4 w-4" /> GO TO SCHEDULE — ACTIVITY KEEPS RUNNING
          </button>
        </div>

        <AnimatePresence>
          {activityOpen ? (
            <motion.aside
              initial={{ x: 36, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 36, opacity: 0 }}
              className="border-l border-white/10 bg-[#0d1119] p-5 sm:p-6"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-serif text-xl font-bold">Activity</p>
                  <p className="mt-1 text-xs text-[#7d8ca7]">
                    Finished actions stay here until you dismiss them
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onActivityOpen(false)}
                  aria-label="Close activity"
                >
                  <X className="h-4 w-4 text-[#7d8ca7]" />
                </button>
              </div>
              <div className="mt-6 border-l border-[#8fb4ff]/35 pl-4">
                {state === "ready" && !recentActivity ? (
                  <div className="rounded-xl border border-dashed border-white/10 p-5 text-center text-sm text-[#7d8ca7]">
                    Actions you start will stay visible here while you navigate.
                  </div>
                ) : null}
                {state !== "ready" ? (
                  <RailActivity
                    state={state}
                    snapshot={snapshot}
                    onRun={onRun}
                    onDismiss={onDismiss}
                  />
                ) : null}
                {recentActivity ? (
                  <div className={state === "ready" ? "" : "mt-6"}>
                    <RecentActivity snapshot={recentActivity} />
                  </div>
                ) : null}
              </div>
            </motion.aside>
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}

function RecentActivity({ snapshot }: { readonly snapshot: Snapshot }) {
  return (
    <article className="rounded-2xl border border-white/10 bg-[#151a25]/70 p-5 opacity-75">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#8fa6cc]">
            Recent history
          </p>
          <h3 className="mt-2 font-serif text-base font-bold">{snapshot.title}</h3>
        </div>
        <span className="font-mono text-[9px] uppercase text-[#68758d]">Dismissed just now</span>
      </div>
      <p className="mt-3 text-xs leading-5 text-[#9aa8bf]">{snapshot.detail}</p>
      <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-[10px] font-bold uppercase tracking-wide">
        <span className={snapshot.tone === "failure" ? "text-[#ff8e8e]" : "text-[#72e6ae]"}>
          {snapshot.status}
        </span>
        <span className="text-[#68758d]">12:23 UTC</span>
      </div>
    </article>
  );
}

// fallow-ignore-next-line complexity -- throwaway state-comparison surface
function RailActivity({ state, snapshot, onRun, onDismiss }: VariantProps) {
  return (
    <motion.article
      key={state}
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      className="relative rounded-2xl border border-white/10 bg-[#151a25] p-5 shadow-xl"
    >
      <span
        className={`absolute -left-[23px] top-5 h-3 w-3 rounded-full border-2 border-[#0d1119] ${dotClass(snapshot.tone)}`}
      />
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#8fb4ff]">
            Lockdown · #weekly-raid
          </p>
          <h3 className="mt-2 font-serif text-lg font-bold">{snapshot.title}</h3>
        </div>
        <span className="font-mono text-[10px] text-[#68758d]">{snapshot.elapsed}</span>
      </div>
      <p className="mt-3 text-xs leading-5 text-[#9aa8bf]">{snapshot.detail}</p>
      <div className="mt-5 h-1 overflow-hidden rounded-full bg-white/10">
        <motion.div
          className={`h-full ${snapshot.tone === "failure" ? "bg-[#ff8e8e]" : snapshot.tone === "success" ? "bg-[#72e6ae]" : "bg-[#8fb4ff]"}`}
          animate={{ width: progressWidth(state) }}
        />
      </div>
      <RunFacts snapshot={snapshot} compact />
      {snapshot.terminal && snapshot.tone === "failure" ? (
        <button
          type="button"
          onClick={onRun}
          className="mt-4 flex h-9 items-center gap-2 rounded-full border border-[#8fb4ff]/25 px-4 text-xs font-bold text-[#b8ceff]"
        >
          <RotateCcw className="h-3.5 w-3.5" /> TRY AGAIN
        </button>
      ) : null}
      {snapshot.terminal ? (
        <div className="mt-4 flex flex-wrap gap-4">
          {state === "success" ? (
            <button
              type="button"
              className="flex items-center gap-2 text-xs font-bold text-[#72e6ae]"
            >
              VIEW CHANNEL <ExternalLink className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            className="flex items-center gap-2 text-xs font-bold text-[#9aa8bf]"
          >
            DISMISS <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
    </motion.article>
  );
}

// fallow-ignore-next-line complexity -- throwaway structurally distinct variant
function ReceiptVariant({ state, snapshot, onRun, onDismiss }: VariantProps) {
  const active = state !== "ready";
  return (
    <section className="min-h-[610px] border-[3px] border-[#e9f4ef] bg-[#e9f4ef] text-[#111714] shadow-[14px_14px_0_#ff5d45]">
      <header className="flex flex-col justify-between gap-4 border-b-[3px] border-[#111714] px-5 py-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center bg-[#111714] text-[#e9f4ef]">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <p className="font-mono text-[9px] font-black tracking-[0.22em]">VARIANT C</p>
            <p className="font-serif text-xl font-black">Confirmation + progress</p>
          </div>
        </div>
        <p className="max-w-md text-xs font-bold leading-5 text-[#4f5e57]">
          High-consequence actions get a dedicated handoff. The user chooses when to background it.
        </p>
      </header>

      {!active ? (
        <div className="grid min-h-[520px] lg:grid-cols-[1fr_1fr]">
          <div className="border-b-[3px] border-[#111714] p-7 sm:p-10 lg:border-b-0 lg:border-r-[3px]">
            <p className="font-mono text-[10px] font-black tracking-[0.2em] text-[#ff5d45]">
              BEFORE YOU CONTINUE
            </p>
            <h2 className="mt-5 max-w-xl font-serif text-4xl font-black leading-[0.95] sm:text-6xl">
              Replace every permission overwrite?
            </h2>
            <p className="mt-6 max-w-lg text-base leading-7 text-[#4f5e57]">
              TiaraBot will apply the configured lockdown policy to <strong>#weekly-raid</strong>.
              Existing explicit overwrites will be removed.
            </p>
          </div>
          <div className="flex flex-col justify-between p-7 sm:p-10">
            <div className="space-y-0 border-[3px] border-[#111714]">
              <ReceiptLine label="SERVER" value="Atlas Collective" />
              <ReceiptLine label="CHANNEL" value="#weekly-raid" />
              <ReceiptLine label="POLICY" value="@Raid Team lockdown" />
              <ReceiptLine label="AUTHORITY" value="Manage Server verified" />
            </div>
            <div className="mt-8 grid gap-3">
              <button
                type="button"
                onClick={onRun}
                className="flex h-14 items-center justify-between border-[3px] border-[#111714] bg-[#ff5d45] px-5 text-sm font-black hover:bg-[#ff745f]"
              >
                REPLACE OVERWRITES <ArrowRight className="h-5 w-5" />
              </button>
              <button
                type="button"
                className="h-12 border-[3px] border-[#111714] text-sm font-black hover:bg-[#d8e6df]"
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid min-h-[520px] lg:grid-cols-[320px_1fr]">
          <div className="border-b-[3px] border-[#111714] bg-[#111714] p-7 text-[#e9f4ef] lg:border-b-0 lg:border-r-[3px]">
            <p className="font-mono text-[10px] font-black tracking-[0.2em] text-[#ff8b78]">
              LOCKDOWN PROGRESS
            </p>
            <p className="mt-4 break-all font-mono text-xs leading-6 text-white/55">
              01K1TWVMHH6BWK0Q9F
            </p>
            <div className="mt-10 space-y-6">
              <ReceiptStep label="Submitted" complete state={state} boundary="accepting" />
              <ReceiptStep
                label="Accepted"
                complete={snapshot.accepted}
                state={state}
                boundary="queued"
              />
              <ReceiptStep
                label="Executing"
                complete={snapshot.accepted && state !== "queued"}
                state={state}
                boundary="running"
              />
              <ReceiptStep
                label="Finished"
                complete={snapshot.terminal && snapshot.accepted}
                state={state}
                boundary="success"
              />
            </div>
          </div>
          <div className="flex flex-col justify-between p-7 sm:p-12">
            <motion.div key={state} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <div
                className={`grid h-16 w-16 place-items-center border-[3px] border-[#111714] ${receiptIconClass(snapshot.tone)}`}
              >
                <StateIcon snapshot={snapshot} large />
              </div>
              <p className="mt-7 font-mono text-[10px] font-black tracking-[0.2em] text-[#ff5d45]">
                {snapshot.status.toUpperCase()}
              </p>
              <h2 className="mt-3 max-w-2xl font-serif text-4xl font-black leading-tight sm:text-6xl">
                {snapshot.title}
              </h2>
              <p className="mt-5 max-w-2xl text-base leading-7 text-[#4f5e57]">{snapshot.detail}</p>
              <RunFacts snapshot={snapshot} />
            </motion.div>
            <div className="mt-8 flex flex-wrap gap-3 border-t-[3px] border-[#111714] pt-6">
              {snapshot.accepted && !snapshot.terminal ? (
                <button
                  type="button"
                  className="flex h-12 items-center gap-3 border-[3px] border-[#111714] bg-[#111714] px-5 text-xs font-black text-[#e9f4ef]"
                >
                  RUN IN BACKGROUND <ArrowRight className="h-4 w-4" />
                </button>
              ) : null}
              {snapshot.terminal && snapshot.tone === "failure" ? (
                <button
                  type="button"
                  onClick={onRun}
                  className="flex h-12 items-center gap-3 border-[3px] border-[#111714] bg-[#ff5d45] px-5 text-xs font-black"
                >
                  TRY AGAIN <RotateCcw className="h-4 w-4" />
                </button>
              ) : null}
              {snapshot.terminal ? (
                <button
                  type="button"
                  onClick={onDismiss}
                  className="h-12 border-[3px] border-[#111714] px-5 text-xs font-black"
                >
                  DISMISS
                </button>
              ) : null}
              <button
                type="button"
                className="h-12 border-[3px] border-[#111714] px-5 text-xs font-black"
              >
                VIEW SETTINGS
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ReceiptLine({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b-[3px] border-[#111714] px-4 py-3 last:border-b-0">
      <span className="font-mono text-[9px] font-black tracking-[0.18em] text-[#65736d]">
        {label}
      </span>
      <span className="text-right text-sm font-black">{value}</span>
    </div>
  );
}

function ReceiptStep({
  label,
  complete,
}: {
  readonly label: string;
  readonly complete: boolean;
  readonly state: PrototypeState;
  readonly boundary: PrototypeState;
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={`grid h-7 w-7 place-items-center border ${complete ? "border-[#ff8b78] bg-[#ff5d45] text-[#111714]" : "border-white/20 text-white/25"}`}
      >
        {complete ? <Check className="h-4 w-4" /> : <CircleDot className="h-3.5 w-3.5" />}
      </span>
      <span
        className={`font-mono text-[10px] font-black uppercase tracking-[0.16em] ${complete ? "text-white" : "text-white/30"}`}
      >
        {label}
      </span>
    </div>
  );
}

function FakeField({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <label className="block">
      <span className="text-[10px] font-black tracking-[0.13em] text-white/55">{label}</span>
      <span className="mt-2 flex h-11 items-center border border-white/15 bg-[#07100e] px-3 text-sm text-white/80">
        {value}
      </span>
    </label>
  );
}

function SoftFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#70809b]">{label}</p>
      <p className="mt-2 font-serif text-xl font-bold">{value}</p>
    </div>
  );
}

function StateIcon({
  snapshot,
  large = false,
}: {
  readonly snapshot: Snapshot;
  readonly large?: boolean;
}) {
  const className = large ? "h-7 w-7" : "mt-0.5 h-5 w-5 shrink-0";
  return Match.value(snapshot.tone).pipe(
    Match.when("success", () => <CheckCircle2 className={className} />),
    Match.when("failure", () => <XCircle className={className} />),
    Match.when("pending", () => <LoaderCircle className={`${className} animate-spin`} />),
    Match.when("neutral", () => <Clock3 className={className} />),
    Match.exhaustive,
  );
}

// fallow-ignore-next-line complexity -- throwaway state-comparison surface
function RunFacts({
  snapshot,
  compact = false,
}: {
  readonly snapshot: Snapshot;
  readonly compact?: boolean;
}) {
  return (
    <dl
      className={`grid gap-px overflow-hidden border ${compact ? "mt-4 grid-cols-2 border-current/15" : "mt-8 max-w-2xl grid-cols-2 border-[#111714] sm:grid-cols-4"}`}
    >
      <RunFact label="STATUS" value={snapshot.status} compact={compact} />
      <RunFact
        label="LEAVE PAGE"
        value={snapshot.status === "Sending" ? "Not yet" : "Yes"}
        compact={compact}
      />
      {!compact ? <RunFact label="ELAPSED" value={snapshot.elapsed} /> : null}
      {!compact ? <RunFact label="NEXT STEP" value={nextActions[snapshot.status]} /> : null}
    </dl>
  );
}

function RunFact({
  label,
  value,
  compact = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly compact?: boolean;
}) {
  return (
    <div className={compact ? "bg-black/10 p-2.5" : "bg-[#e9f4ef] p-3"}>
      <dt className="font-mono text-[8px] font-black tracking-[0.14em] opacity-45">{label}</dt>
      <dd className="mt-1 text-[10px] font-black">{value}</dd>
    </div>
  );
}

function PrototypeSwitcher({
  variant,
  onCycle,
}: {
  readonly variant: Variant;
  readonly onCycle: (direction: -1 | 1) => void;
}) {
  return (
    <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 bg-[#050807]/95 p-1.5 text-white shadow-[0_16px_64px_rgba(0,0,0,0.55)] backdrop-blur-xl">
      <button
        type="button"
        onClick={() => onCycle(-1)}
        aria-label="Previous variant"
        className="grid h-9 w-9 place-items-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <div className="min-w-[220px] px-3 text-center">
        <p className="font-mono text-[8px] font-black tracking-[0.18em] text-[#33ccbb]">
          PROTOTYPE VARIANT
        </p>
        <p className="mt-0.5 text-xs font-black">
          {variants.indexOf(variant) + 1} / {variants.length} · {variantNames[variant]}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onCycle(1)}
        aria-label="Next variant"
        className="grid h-9 w-9 place-items-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"
      >
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}

const primaryButtonClass =
  "inline-flex h-10 items-center justify-center gap-2 border border-[#33ccbb] bg-[#33ccbb] px-4 text-xs font-black tracking-wide text-[#07100e] transition hover:bg-[#79e6d9] disabled:cursor-not-allowed disabled:opacity-35";
const secondaryButtonClass =
  "inline-flex h-10 items-center justify-center gap-2 border border-white/15 bg-[#0a100f] px-4 text-xs font-black tracking-wide text-white/70 transition hover:border-[#33ccbb]/45 hover:text-white disabled:cursor-not-allowed disabled:opacity-35";

const toneClass = (tone: Snapshot["tone"]) =>
  Match.value(tone).pipe(
    Match.when("success", () => "border-[#33ccbb]/35 bg-[#33ccbb]/10 text-[#79e6d9]"),
    Match.when("failure", () => "border-[#ff6257]/35 bg-[#ff6257]/10 text-[#ffaaa4]"),
    Match.when("pending", () => "border-[#ffb86b]/35 bg-[#ffb86b]/10 text-[#ffd09a]"),
    Match.when("neutral", () => "border-white/15 bg-white/[0.03] text-white/70"),
    Match.exhaustive,
  );

const dotClass = (tone: Snapshot["tone"]) =>
  Match.value(tone).pipe(
    Match.when("success", () => "bg-[#72e6ae]"),
    Match.when("failure", () => "bg-[#ff8e8e]"),
    Match.when("pending", () => "bg-[#8fb4ff]"),
    Match.when("neutral", () => "bg-[#68758d]"),
    Match.exhaustive,
  );

const receiptIconClass = (tone: Snapshot["tone"]) =>
  Match.value(tone).pipe(
    Match.when("success", () => "bg-[#53d69c]"),
    Match.when("failure", () => "bg-[#ff5d45]"),
    Match.when("pending", () => "bg-[#ffd15c]"),
    Match.when("neutral", () => "bg-[#e9f4ef]"),
    Match.exhaustive,
  );

const progressWidth = (state: PrototypeState) =>
  Match.value(state).pipe(
    Match.when("ready", () => "0%"),
    Match.when("accepting", () => "12%"),
    Match.when("queued", () => "28%"),
    Match.when("running", () => "58%"),
    Match.when("taking-longer", () => "72%"),
    Match.orElse(() => "100%"),
  );
