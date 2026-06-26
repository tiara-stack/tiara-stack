import { createFileRoute } from "@tanstack/react-router";
import { Bell, Check, Loader2, Save } from "lucide-react";
import { Cause, Option } from "effect";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useMemo, useState } from "react";
import { useCurrentUser } from "#/lib/discord";
import {
  useDiscordUserPlatformConfigResult,
  useSupportedNotificationClientsResult,
  useUpsertCurrentUserPlatformConfig,
  type SupportedNotificationClient,
  type UserPlatformConfig,
} from "#/lib/userConfig";

export const Route = createFileRoute("/_authenticated/dashboard/preferences")({
  component: PreferencesPage,
});

type PreferencesForm = {
  readonly checkinDmEnabled: boolean;
  readonly defaultClientId: string;
};

type FormSetter = Dispatch<SetStateAction<PreferencesForm>>;

const emptyForm = (): PreferencesForm => ({
  checkinDmEnabled: false,
  defaultClientId: "",
});

const messageFromUnknown = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const asyncResultError = (result: { readonly _tag: string; readonly cause?: unknown }) =>
  result._tag === "Failure" && result.cause !== undefined
    ? messageFromUnknown(Cause.squash(result.cause as Cause.Cause<unknown>))
    : undefined;

const configValue = (result: ReturnType<typeof useDiscordUserPlatformConfigResult>) => {
  if (result._tag === "Success") {
    return result.value;
  }
  return Option.match(result.previousSuccess, {
    onNone: () => Option.none(),
    onSome: (previous) => previous.value,
  });
};

const clientsValue = (result: ReturnType<typeof useSupportedNotificationClientsResult>) => {
  if (result._tag === "Success") {
    return result.value;
  }
  return Option.match(result.previousSuccess, {
    onNone: () => [] as readonly SupportedNotificationClient[],
    onSome: (previous) => previous.value,
  });
};

const onlyDiscordClientId = (discordClients: readonly SupportedNotificationClient[]) =>
  discordClients.length === 1 ? (discordClients[0]?.clientId ?? "") : "";

const defaultClientIdFor = (
  config: Option.Option<UserPlatformConfig>,
  discordClients: readonly SupportedNotificationClient[],
) =>
  Option.match(config, {
    onNone: () => onlyDiscordClientId(discordClients),
    onSome: (value) =>
      Option.getOrNull(value.defaultClientId) ?? onlyDiscordClientId(discordClients),
  });

const checkinDmEnabledFor = (config: Option.Option<UserPlatformConfig>) =>
  Option.match(config, {
    onNone: () => false,
    onSome: (value) => value.checkinDmEnabled,
  });

const initialForm = (
  config: Option.Option<UserPlatformConfig>,
  discordClients: readonly SupportedNotificationClient[],
): PreferencesForm => ({
  checkinDmEnabled: checkinDmEnabledFor(config),
  defaultClientId: defaultClientIdFor(config, discordClients),
});

const validationErrorFor = (form: PreferencesForm) =>
  form.checkinDmEnabled && form.defaultClientId.length === 0
    ? "Select a Discord client before enabling check-in DM reminders."
    : undefined;

const payloadDefaultClientId = (form: PreferencesForm) =>
  form.defaultClientId.length > 0 ? form.defaultClientId : null;

function PreferencesHeader(props: { readonly displayName: string; readonly userId: string }) {
  return (
    <div className="border-b border-[#33ccbb]/20 px-6 py-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center bg-[#33ccbb]">
            <Bell className="h-5 w-5 text-[#0a0f0e]" />
          </div>
          <div>
            <p className="text-[10px] font-bold tracking-[0.2em] text-[#33ccbb]">PREFERENCES</p>
            <h2 className="text-lg font-black tracking-tight">CHECK-IN REMINDERS</h2>
          </div>
        </div>
        <div className="text-left md:text-right">
          <p className="text-xs font-bold uppercase tracking-wide text-white/50">Discord</p>
          <p className="font-mono text-sm text-white">{props.displayName}</p>
          <p className="font-mono text-xs text-white/50">{props.userId}</p>
        </div>
      </div>
    </div>
  );
}

function ErrorBanner(props: { readonly error: string | undefined }) {
  if (props.error === undefined) {
    return null;
  }
  return (
    <div className="border-b border-red-400/30 bg-red-950/30 px-6 py-3 text-sm text-red-100">
      {props.error}
    </div>
  );
}

function ReminderInfo() {
  return (
    <section className="bg-[#0f1615] p-6">
      <p className="text-xs font-black uppercase tracking-[0.18em] text-[#33ccbb]">
        Check-in DM reminders
      </p>
      <p className="mt-3 text-sm leading-6 text-white/65">
        Receive a short Discord DM when a manual or automatic check-in opens for you.
      </p>
    </section>
  );
}

function SaveButtonIcon(props: { readonly saving: boolean; readonly saved: boolean }) {
  if (props.saving) {
    return <Loader2 className="h-4 w-4 animate-spin" />;
  }
  if (props.saved) {
    return <Check className="h-4 w-4" />;
  }
  return <Save className="h-4 w-4" />;
}

function SaveButtonLabel(props: { readonly saving: boolean; readonly saved: boolean }) {
  return <span>{props.saving ? "SAVING" : props.saved ? "SAVED" : "SAVE"}</span>;
}

function ClientSummary(props: { readonly clientCount: number }) {
  return (
    <p className="text-xs text-white/45">
      {props.clientCount === 1
        ? "The only configured Discord client is selected automatically."
        : `${props.clientCount} Discord clients are available.`}
    </p>
  );
}

function ReminderToggle(props: {
  readonly disabled: boolean;
  readonly form: PreferencesForm;
  readonly setForm: FormSetter;
}) {
  return (
    <label className="flex items-center justify-between gap-4 border border-[#33ccbb]/20 bg-black/20 px-4 py-3">
      <span>
        <span className="block text-sm font-bold text-white">Check-in DM reminders</span>
        <span className="block text-xs text-white/50">Personal Discord reminder setting</span>
      </span>
      <input
        checked={props.form.checkinDmEnabled}
        className="h-5 w-5 accent-[#33ccbb]"
        disabled={props.disabled}
        type="checkbox"
        onChange={(event) =>
          props.setForm((current) => ({
            ...current,
            checkinDmEnabled: event.target.checked,
          }))
        }
      />
    </label>
  );
}

function ClientSelect(props: {
  readonly disabled: boolean;
  readonly discordClients: readonly SupportedNotificationClient[];
  readonly form: PreferencesForm;
  readonly setForm: FormSetter;
}) {
  return (
    <label className="block">
      <span className="text-xs font-bold uppercase tracking-wide text-white/55">
        Default Discord client
      </span>
      <select
        className="mt-2 w-full border border-[#33ccbb]/20 bg-[#09110f] px-3 py-3 font-mono text-sm text-white outline-none transition focus:border-[#33ccbb]"
        disabled={props.disabled || props.discordClients.length <= 1}
        value={props.form.defaultClientId}
        onChange={(event) =>
          props.setForm((current) => ({
            ...current,
            defaultClientId: event.target.value,
          }))
        }
      >
        <option value="">Select a Discord client</option>
        {props.discordClients.map((client) => (
          <option key={client.clientId} value={client.clientId}>
            {client.clientId}
          </option>
        ))}
      </select>
    </label>
  );
}

function ReminderForm(props: {
  readonly disabled: boolean;
  readonly discordClients: readonly SupportedNotificationClient[];
  readonly form: PreferencesForm;
  readonly saved: boolean;
  readonly saving: boolean;
  readonly setForm: FormSetter;
  readonly validationError: string | undefined;
  readonly onSave: () => void;
}) {
  return (
    <section className="space-y-5 bg-[#0f1615] p-6">
      <ReminderToggle disabled={props.disabled} form={props.form} setForm={props.setForm} />
      <ClientSelect
        disabled={props.disabled}
        discordClients={props.discordClients}
        form={props.form}
        setForm={props.setForm}
      />

      {props.validationError ? (
        <p className="text-sm text-red-200">{props.validationError}</p>
      ) : null}

      <div className="flex items-center justify-between gap-4 border-t border-[#33ccbb]/20 pt-5">
        <ClientSummary clientCount={props.discordClients.length} />
        <button
          className="inline-flex min-w-28 items-center justify-center gap-2 bg-[#33ccbb] px-4 py-3 text-sm font-black text-[#0a0f0e] transition hover:bg-white disabled:cursor-not-allowed disabled:bg-white/20 disabled:text-white/40"
          disabled={props.disabled || props.validationError !== undefined}
          type="button"
          onClick={props.onSave}
        >
          <SaveButtonIcon saved={props.saved} saving={props.saving} />
          <SaveButtonLabel saved={props.saved} saving={props.saving} />
        </button>
      </div>
    </section>
  );
}

function usePreferenceData() {
  const currentUser = useCurrentUser();
  const configResult = useDiscordUserPlatformConfigResult();
  const clientsResult = useSupportedNotificationClientsResult();
  const config = configValue(configResult);
  const discordClients = useMemo(
    () => clientsValue(clientsResult).filter((client) => client.platform === "discord"),
    [clientsResult],
  );

  return {
    currentUser,
    config,
    discordClients,
    loadError: asyncResultError(configResult) ?? asyncResultError(clientsResult),
    waiting: configResult.waiting || clientsResult.waiting,
  };
}

function useInitializedForm(props: {
  readonly config: Option.Option<UserPlatformConfig>;
  readonly discordClients: readonly SupportedNotificationClient[];
  readonly waiting: boolean;
}) {
  const [form, setForm] = useState<PreferencesForm>(emptyForm);
  const [formInitialized, setFormInitialized] = useState(false);

  useEffect(() => {
    if (!formInitialized && !props.waiting) {
      setForm(initialForm(props.config, props.discordClients));
      setFormInitialized(true);
    }
  }, [formInitialized, props.config, props.discordClients, props.waiting]);

  return { form, setForm };
}

function useSavePreference(props: {
  readonly form: PreferencesForm;
  readonly validationError: string | undefined;
}) {
  const upsertConfig = useUpsertCurrentUserPlatformConfig();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();

  useEffect(() => {
    setSaved(false);
  }, [props.form, props.validationError]);

  const save = async () => {
    if (props.validationError !== undefined) {
      return;
    }
    setSaving(true);
    setSaved(false);
    setSaveError(undefined);
    try {
      await upsertConfig({
        platform: "discord",
        checkinDmEnabled: props.form.checkinDmEnabled,
        defaultClientId: payloadDefaultClientId(props.form),
      });
      setSaved(true);
    } catch (error) {
      setSaveError(messageFromUnknown(error));
    } finally {
      setSaving(false);
    }
  };

  return { save, saveError, saved, saving };
}

function PreferencesPage() {
  const data = usePreferenceData();
  const { form, setForm } = useInitializedForm(data);
  const validationError = validationErrorFor(form);
  const saveState = useSavePreference({ form, validationError });
  const loadError = saveState.saveError ?? data.loadError;
  const disabled = saveState.saving || data.waiting;
  const displayName = data.currentUser.global_name ?? data.currentUser.username;

  return (
    <div className="border border-[#33ccbb]/20 bg-[#0f1615]">
      <PreferencesHeader displayName={displayName} userId={data.currentUser.id} />
      <ErrorBanner error={loadError} />

      <div className="grid gap-px bg-[#33ccbb]/20 md:grid-cols-[1fr_1.2fr]">
        <ReminderInfo />
        <ReminderForm
          disabled={disabled}
          discordClients={data.discordClients}
          form={form}
          saved={saveState.saved}
          saving={saveState.saving}
          setForm={setForm}
          validationError={validationError}
          onSave={saveState.save}
        />
      </div>
    </div>
  );
}
