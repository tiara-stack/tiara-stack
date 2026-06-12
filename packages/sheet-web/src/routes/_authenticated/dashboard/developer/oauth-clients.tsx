import { useAtomSuspense } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { Effect, Exit } from "effect";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createOAuthClient,
  deleteOAuthClient,
  listOAuthClients,
  rotateOAuthClientSecret,
  updateOAuthClient,
  type OAuthClientCreateInput,
  type OAuthClientDetails,
  type OAuthClientUpdateInput,
} from "sheet-auth/client";
import { PublicOAuthScopes } from "sheet-auth/oauth";
import { Button } from "#/components/ui/button";
import { authClientAtom } from "#/lib/auth";

export const Route = createFileRoute("/_authenticated/dashboard/developer/oauth-clients")({
  component: OAuthClientsPage,
});

const allowedScopes = PublicOAuthScopes;

type ClientKind = "public" | "confidential";
type PublicType = "native" | "user-agent-based";

type ClientFormState = {
  clientId?: string;
  kind: ClientKind;
  publicType: PublicType;
  name: string;
  redirectUris: string[];
  clientUri: string;
  logoUri: string;
  contacts: string[];
  policyUri: string;
  tosUri: string;
  scopes: string[];
};

type RevealedClientSecret = {
  clientId: string;
  secret: string;
  visible: boolean;
};

type ClientFormPayload = {
  input: OAuthClientCreateInput | OAuthClientUpdateInput;
  error?: string;
  created?: OAuthClientDetails;
};

const emptyForm = (): ClientFormState => ({
  kind: "confidential",
  publicType: "native",
  name: "",
  redirectUris: [""],
  clientUri: "",
  logoUri: "",
  contacts: [""],
  policyUri: "",
  tosUri: "",
  scopes: ["openid", "profile", "email"],
});

const clientIsTrusted = (client: OAuthClientDetails) =>
  typeof client.metadata === "object" &&
  client.metadata !== null &&
  !Array.isArray(client.metadata) &&
  client.metadata.trusted === true;

const splitScope = (scope: string | undefined) =>
  scope
    ?.split(" ")
    .filter((value) => allowedScopes.includes(value as (typeof allowedScopes)[number])) ?? [];

const cleanList = (values: readonly string[]) =>
  values.map((value) => value.trim()).filter((value) => value.length > 0);

const clientKind = (client: OAuthClientDetails): ClientKind =>
  client.token_endpoint_auth_method === "none" ? "public" : "confidential";

const clientPublicType = (client: OAuthClientDetails): PublicType =>
  client.type === "user-agent-based" ? "user-agent-based" : "native";

const orEmpty = (value: string | undefined) => value ?? "";

const optionalString = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const listOrUndefined = (values: readonly string[]) => {
  const cleaned = cleanList(values);
  return cleaned.length > 0 ? cleaned : undefined;
};

const editableList = (values: readonly string[] | undefined) =>
  values && values.length > 0 ? [...values] : [""];

const toForm = (client: OAuthClientDetails): ClientFormState => ({
  clientId: client.client_id,
  kind: clientKind(client),
  publicType: clientPublicType(client),
  name: orEmpty(client.client_name),
  redirectUris: editableList(client.redirect_uris),
  clientUri: orEmpty(client.client_uri),
  logoUri: orEmpty(client.logo_uri),
  contacts: editableList(client.contacts),
  policyUri: orEmpty(client.policy_uri),
  tosUri: orEmpty(client.tos_uri),
  scopes: splitScope(client.scope),
});

const formClientType = (form: ClientFormState) =>
  form.kind === "public" ? form.publicType : ("web" as const);

const makeFormPayload = (form: ClientFormState): ClientFormPayload => {
  const redirectUris = cleanList(form.redirectUris);
  if (redirectUris.length === 0) {
    return { input: {}, error: "At least one redirect URI is required" };
  }

  const scope = form.scopes.join(" ");
  if (scope.trim().length === 0) {
    return { input: {}, error: "At least one scope is required" };
  }

  return {
    input: {
      redirect_uris: redirectUris,
      scope,
      client_name: optionalString(form.name),
      client_uri: optionalString(form.clientUri),
      logo_uri: optionalString(form.logoUri),
      contacts: listOrUndefined(form.contacts),
      policy_uri: optionalString(form.policyUri),
      tos_uri: optionalString(form.tosUri),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      type: formClientType(form),
    },
  };
};

const submitOAuthClientForm = async (
  authClient: Parameters<typeof createOAuthClient>[0],
  form: ClientFormState,
): Promise<ClientFormPayload> => {
  const payload = makeFormPayload(form);
  if (payload.error) {
    return payload;
  }

  if (form.clientId) {
    await Effect.runPromise(
      updateOAuthClient(authClient, form.clientId, payload.input as OAuthClientUpdateInput),
    );
    return payload;
  }

  const created = await Effect.runPromise(
    createOAuthClient(authClient, {
      ...(payload.input as OAuthClientCreateInput),
      token_endpoint_auth_method: form.kind === "public" ? "none" : "client_secret_basic",
    }),
  );

  return { ...payload, created };
};

const messageFromUnknown = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const runUiOperation = async (
  operation: string,
  setActiveOperation: (operation: string | undefined) => void,
  setError: (error: string | undefined) => void,
  action: () => Promise<void>,
) => {
  setActiveOperation(operation);
  setError(undefined);
  try {
    await action();
  } catch (error) {
    setError(messageFromUnknown(error));
  } finally {
    setActiveOperation(undefined);
  }
};

const copyText = async (value: string) => {
  if (!navigator.clipboard?.writeText) {
    return "Clipboard copy is unavailable in this browser";
  }

  try {
    await navigator.clipboard.writeText(value);
    return undefined;
  } catch {
    return "Failed to copy secret to clipboard";
  }
};

const clientTypeLabel = (client: OAuthClientDetails) =>
  client.token_endpoint_auth_method === "none" ? "PUBLIC" : "CONFIDENTIAL";

const secretDisplayValue = (secret: RevealedClientSecret) =>
  secret.visible ? secret.secret : "••••••••••••••••••••••••";

const secretToggleTitle = (secret: RevealedClientSecret) =>
  secret.visible ? "Hide secret" : "Show secret";

const secretToggleIcon = (secret: RevealedClientSecret) => (secret.visible ? <EyeOff /> : <Eye />);

const copySecretIcon = (copiedClientId: string | undefined, secret: RevealedClientSecret) =>
  copiedClientId === secret.clientId ? <Check /> : <Copy />;

function OAuthClientsPage() {
  const authClientResult = useAtomSuspense(authClientAtom, {
    suspendOnWaiting: false,
    includeFailure: false,
  });
  const authClient = authClientResult.value;
  const [clients, setClients] = useState<readonly OAuthClientDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeOperation, setActiveOperation] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [form, setForm] = useState<ClientFormState | undefined>();
  const [revealedSecret, setRevealedSecret] = useState<RevealedClientSecret>();
  const [copiedSecretClientId, setCopiedSecretClientId] = useState<string | undefined>();
  const mountedRef = useRef(true);

  const visibleClients = useMemo(
    () => clients.filter((client) => !clientIsTrusted(client)),
    [clients],
  );
  const working = activeOperation !== undefined;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshClients = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    const result = await Effect.runPromiseExit(listOAuthClients(authClient));
    if (mountedRef.current) {
      Exit.match(result, {
        onFailure: (error) => setError(messageFromUnknown(error)),
        onSuccess: setClients,
      });
      setLoading(false);
    }
  }, [authClient]);

  useEffect(() => {
    void refreshClients();
  }, [refreshClients]);

  const saveClient = async () => {
    if (!form) {
      return;
    }

    await runUiOperation("save", setActiveOperation, setError, async () => {
      const result = await submitOAuthClientForm(authClient, form);
      if (result.error) {
        setError(result.error);
        return;
      }

      if (result.created?.client_secret) {
        setRevealedSecret({
          clientId: result.created.client_id,
          secret: result.created.client_secret,
          visible: true,
        });
      }

      setForm(undefined);
      await refreshClients();
    });
  };

  const rotateSecret = async (client: OAuthClientDetails) => {
    await runUiOperation(`rotate:${client.client_id}`, setActiveOperation, setError, async () => {
      const rotated = await Effect.runPromise(
        rotateOAuthClientSecret(authClient, client.client_id),
      );
      if (rotated.client_secret) {
        setRevealedSecret({
          clientId: client.client_id,
          secret: rotated.client_secret,
          visible: true,
        });
      }
      await refreshClients();
    });
  };

  const removeClient = async (client: OAuthClientDetails) => {
    const label = client.client_name || client.client_id;
    if (!window.confirm(`Delete OAuth client "${label}"? This cannot be undone.`)) {
      return;
    }

    await runUiOperation(`delete:${client.client_id}`, setActiveOperation, setError, async () => {
      await Effect.runPromise(deleteOAuthClient(authClient, client.client_id));
      await refreshClients();
    });
  };

  const copySecret = async () => {
    if (!revealedSecret) {
      return;
    }

    const copyError = await copyText(revealedSecret.secret);
    if (copyError) {
      setError(copyError);
      return;
    }

    setError(undefined);
    setCopiedSecretClientId(revealedSecret.clientId);
    window.setTimeout(() => {
      if (mountedRef.current) {
        setCopiedSecretClientId(undefined);
      }
    }, 2_000);
  };

  return (
    <div className="border border-[#33ccbb]/20 bg-[#0f1615]">
      <OAuthClientsHeader disabled={working} onCreate={() => setForm(emptyForm())} />
      <ErrorBanner error={error} />
      <SecretReveal
        copiedClientId={copiedSecretClientId}
        secret={revealedSecret}
        onCopy={copySecret}
        onDismiss={() => setRevealedSecret(undefined)}
        onToggleVisible={() =>
          setRevealedSecret((current) =>
            current ? { ...current, visible: !current.visible } : current,
          )
        }
      />
      <OAuthClientsTable
        activeOperation={activeOperation}
        clients={visibleClients}
        loading={loading}
        onDelete={removeClient}
        onEdit={(nextClient) => setForm(toForm(nextClient))}
        onRotate={rotateSecret}
      />

      {form && (
        <ClientDialog
          form={form}
          working={working}
          onCancel={() => setForm(undefined)}
          onChange={setForm}
          onSave={() => void saveClient()}
        />
      )}
    </div>
  );
}

function OAuthClientsHeader({ disabled, onCreate }: { disabled: boolean; onCreate: () => void }) {
  return (
    <div className="flex flex-col gap-4 border-b border-[#33ccbb]/20 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center bg-[#33ccbb]">
          <KeyRound className="size-4 text-[#0a0f0e]" />
        </div>
        <div>
          <p className="text-[10px] font-bold tracking-[0.2em] text-[#33ccbb]">OAUTH</p>
          <h2 className="text-lg font-black text-white">CLIENTS</h2>
        </div>
      </div>
      <Button
        className="bg-[#33ccbb] text-[#0a0f0e] hover:bg-[#33ccbb]/80"
        disabled={disabled}
        onClick={onCreate}
      >
        <Plus className="size-4" />
        NEW CLIENT
      </Button>
    </div>
  );
}

function ErrorBanner({ error }: { error: string | undefined }) {
  return error ? (
    <div className="border-b border-red-400/30 bg-red-950/40 px-5 py-3 text-sm text-red-100">
      {error}
    </div>
  ) : null;
}

function SecretReveal({
  copiedClientId,
  secret,
  onCopy,
  onDismiss,
  onToggleVisible,
}: {
  copiedClientId: string | undefined;
  secret: RevealedClientSecret | undefined;
  onCopy: () => Promise<void>;
  onDismiss: () => void;
  onToggleVisible: () => void;
}) {
  if (!secret) {
    return null;
  }

  return (
    <div className="border-b border-amber-300/30 bg-amber-950/30 px-5 py-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[10px] font-bold tracking-[0.18em] text-amber-200">SECRET REVEAL</p>
          <p className="font-mono text-xs text-white/70">{secret.clientId}</p>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap border border-amber-200/20 bg-black/30 px-3 py-2 text-xs text-amber-50">
            {secretDisplayValue(secret)}
          </code>
          <IconButton title={secretToggleTitle(secret)} onClick={onToggleVisible}>
            {secretToggleIcon(secret)}
          </IconButton>
          <IconButton title="Copy secret" onClick={() => void onCopy()}>
            {copySecretIcon(copiedClientId, secret)}
          </IconButton>
          <IconButton title="Dismiss secret" onClick={onDismiss}>
            <X />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function OAuthClientsTable({
  activeOperation,
  clients,
  loading,
  onDelete,
  onEdit,
  onRotate,
}: {
  activeOperation: string | undefined;
  clients: readonly OAuthClientDetails[];
  loading: boolean;
  onDelete: (client: OAuthClientDetails) => Promise<void>;
  onEdit: (client: OAuthClientDetails) => void;
  onRotate: (client: OAuthClientDetails) => Promise<void>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] border-collapse text-left text-sm">
        <thead className="bg-[#0a0f0e] text-[10px] font-bold tracking-[0.18em] text-[#33ccbb]">
          <tr>
            <th className="px-5 py-3">NAME</th>
            <th className="px-5 py-3">CLIENT ID</th>
            <th className="px-5 py-3">TYPE</th>
            <th className="px-5 py-3">SCOPES</th>
            <th className="px-5 py-3 text-right">ACTIONS</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#33ccbb]/10">
          <OAuthClientRows
            activeOperation={activeOperation}
            clients={clients}
            loading={loading}
            onDelete={onDelete}
            onEdit={onEdit}
            onRotate={onRotate}
          />
        </tbody>
      </table>
    </div>
  );
}

function EmptyClientRow({ label }: { label: string }) {
  return (
    <tr>
      <td className="px-5 py-8 text-center text-white/40" colSpan={5}>
        {label}
      </td>
    </tr>
  );
}

function OAuthClientRows({
  activeOperation,
  clients,
  loading,
  onDelete,
  onEdit,
  onRotate,
}: {
  activeOperation: string | undefined;
  clients: readonly OAuthClientDetails[];
  loading: boolean;
  onDelete: (client: OAuthClientDetails) => Promise<void>;
  onEdit: (client: OAuthClientDetails) => void;
  onRotate: (client: OAuthClientDetails) => Promise<void>;
}) {
  if (loading) {
    return <EmptyClientRow label="LOADING" />;
  }
  if (clients.length === 0) {
    return <EmptyClientRow label="NO CLIENTS" />;
  }

  return clients.map((client) => (
    <OAuthClientRow
      key={client.client_id}
      activeOperation={activeOperation}
      client={client}
      onDelete={onDelete}
      onEdit={onEdit}
      onRotate={onRotate}
    />
  ));
}

function OAuthClientRow({
  activeOperation,
  client,
  onDelete,
  onEdit,
  onRotate,
}: {
  activeOperation: string | undefined;
  client: OAuthClientDetails;
  onDelete: (client: OAuthClientDetails) => Promise<void>;
  onEdit: (client: OAuthClientDetails) => void;
  onRotate: (client: OAuthClientDetails) => Promise<void>;
}) {
  const rotateActive = activeOperation === `rotate:${client.client_id}`;
  const deleteActive = activeOperation === `delete:${client.client_id}`;

  return (
    <tr className="bg-[#0f1615] text-white">
      <td className="px-5 py-4 font-bold">{client.client_name ?? "UNTITLED"}</td>
      <td className="px-5 py-4 font-mono text-xs text-white/60">{client.client_id}</td>
      <td className="px-5 py-4">
        <Badge>{clientTypeLabel(client)}</Badge>
      </td>
      <td className="px-5 py-4">
        <div className="flex max-w-[280px] flex-wrap gap-1">
          {splitScope(client.scope).map((scope) => (
            <Badge key={scope}>{scope}</Badge>
          ))}
        </div>
      </td>
      <td className="px-5 py-4">
        <OAuthClientRowActions
          client={client}
          deleteActive={deleteActive}
          rotateActive={rotateActive}
          onDelete={onDelete}
          onEdit={onEdit}
          onRotate={onRotate}
        />
      </td>
    </tr>
  );
}

function OAuthClientRowActions({
  client,
  deleteActive,
  rotateActive,
  onDelete,
  onEdit,
  onRotate,
}: {
  client: OAuthClientDetails;
  deleteActive: boolean;
  rotateActive: boolean;
  onDelete: (client: OAuthClientDetails) => Promise<void>;
  onEdit: (client: OAuthClientDetails) => void;
  onRotate: (client: OAuthClientDetails) => Promise<void>;
}) {
  const isConfidential = client.token_endpoint_auth_method !== "none";
  return (
    <div className="flex justify-end gap-2">
      <IconButton title="Edit client" onClick={() => onEdit(client)}>
        <Pencil />
      </IconButton>
      <RotateSecretButton
        client={client}
        disabled={rotateActive}
        visible={isConfidential}
        onRotate={onRotate}
      />
      <IconButton
        disabled={deleteActive}
        title="Delete client"
        onClick={() => void onDelete(client)}
      >
        <ActiveIcon active={deleteActive} idle={<Trash2 />} />
      </IconButton>
    </div>
  );
}

function RotateSecretButton({
  client,
  disabled,
  visible,
  onRotate,
}: {
  client: OAuthClientDetails;
  disabled: boolean;
  visible: boolean;
  onRotate: (client: OAuthClientDetails) => Promise<void>;
}) {
  if (!visible) {
    return null;
  }

  return (
    <IconButton disabled={disabled} title="Rotate secret" onClick={() => void onRotate(client)}>
      <ActiveIcon active={disabled} idle={<RotateCcw />} />
    </IconButton>
  );
}

function ActiveIcon({ active, idle }: { active: boolean; idle: ReactNode }) {
  return active ? <LoaderCircle className="animate-spin" /> : idle;
}

function ClientDialog({
  form,
  working,
  onCancel,
  onChange,
  onSave,
}: {
  form: ClientFormState;
  working: boolean;
  onCancel: () => void;
  onChange: (form: ClientFormState) => void;
  onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-20">
      <div className="w-full max-w-4xl border border-[#33ccbb]/30 bg-[#0f1615] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#33ccbb]/20 px-5 py-4">
          <div>
            <p className="text-[10px] font-bold tracking-[0.18em] text-[#33ccbb]">
              {form.clientId ? "EDIT" : "CREATE"}
            </p>
            <h3 className="text-base font-black text-white">OAUTH CLIENT</h3>
          </div>
          <IconButton title="Close" onClick={onCancel}>
            <X />
          </IconButton>
        </div>

        <div className="grid gap-5 p-5 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <Segmented
              disabled={Boolean(form.clientId)}
              value={form.kind}
              options={[
                { value: "confidential", label: "CONFIDENTIAL" },
                { value: "public", label: "PUBLIC" },
              ]}
              onChange={(kind) => onChange({ ...form, kind })}
            />
            {form.kind === "public" && (
              <Segmented
                value={form.publicType}
                options={[
                  { value: "native", label: "NATIVE" },
                  { value: "user-agent-based", label: "USER AGENT" },
                ]}
                onChange={(publicType) => onChange({ ...form, publicType })}
              />
            )}

            <Field label="NAME">
              <Input
                value={form.name}
                onChange={(value) => onChange({ ...form, name: value })}
                placeholder="Sheet tooling"
              />
            </Field>

            <ListEditor
              label="REDIRECT URIS"
              required
              values={form.redirectUris}
              placeholder="https://example.com/oauth/callback"
              onChange={(redirectUris) => onChange({ ...form, redirectUris })}
            />

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="CLIENT URI">
                <Input
                  value={form.clientUri}
                  onChange={(clientUri) => onChange({ ...form, clientUri })}
                />
              </Field>
              <Field label="LOGO URI">
                <Input
                  value={form.logoUri}
                  onChange={(logoUri) => onChange({ ...form, logoUri })}
                />
              </Field>
              <Field label="POLICY URI">
                <Input
                  value={form.policyUri}
                  onChange={(policyUri) => onChange({ ...form, policyUri })}
                />
              </Field>
              <Field label="TOS URI">
                <Input value={form.tosUri} onChange={(tosUri) => onChange({ ...form, tosUri })} />
              </Field>
            </div>

            <ListEditor
              label="CONTACTS"
              values={form.contacts}
              placeholder="ops@example.com"
              onChange={(contacts) => onChange({ ...form, contacts })}
            />
          </div>

          <div className="border border-[#33ccbb]/20 bg-[#0a0f0e] p-4">
            <p className="mb-3 text-[10px] font-bold tracking-[0.18em] text-[#33ccbb]">
              SCOPES <span className="text-white/45">REQUIRED</span>
            </p>
            <div className="space-y-2">
              {allowedScopes.map((scope) => (
                <label
                  key={scope}
                  className="flex cursor-pointer items-center gap-2 text-sm text-white/80"
                >
                  <input
                    checked={form.scopes.includes(scope)}
                    className="size-4 accent-[#33ccbb]"
                    type="checkbox"
                    onChange={(event) =>
                      onChange({
                        ...form,
                        scopes: event.target.checked
                          ? [...form.scopes, scope]
                          : form.scopes.filter((value) => value !== scope),
                      })
                    }
                  />
                  <span className="font-mono text-xs">{scope}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-[#33ccbb]/20 px-5 py-4">
          <Button variant="outline" disabled={working} onClick={onCancel}>
            <X className="size-4" />
            CANCEL
          </Button>
          <Button
            className="bg-[#33ccbb] text-[#0a0f0e] hover:bg-[#33ccbb]/80"
            disabled={working}
            onClick={onSave}
          >
            {working ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            SAVE
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  children,
  label,
  required,
}: {
  children: ReactNode;
  label: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-bold tracking-[0.18em] text-[#33ccbb]">
        {label} {required && <span className="text-white/45">REQUIRED</span>}
      </span>
      {children}
    </label>
  );
}

function Input({
  onChange,
  placeholder,
  required,
  value,
}: {
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  value: string;
}) {
  return (
    <input
      aria-required={required}
      className="h-10 w-full border border-[#33ccbb]/20 bg-[#0a0f0e] px-3 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-[#33ccbb]"
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function ListEditor({
  label,
  onChange,
  placeholder,
  required,
  values,
}: {
  label: string;
  onChange: (values: string[]) => void;
  placeholder: string;
  required?: boolean;
  values: string[];
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-bold tracking-[0.18em] text-[#33ccbb]">
        {label} {required && <span className="text-white/45">REQUIRED</span>}
      </p>
      <div className="space-y-2">
        {values.map((value, index) => (
          <div key={index} className="flex gap-2">
            <Input
              placeholder={placeholder}
              required={required}
              value={value}
              onChange={(nextValue) =>
                onChange(
                  values.map((current, currentIndex) =>
                    currentIndex === index ? nextValue : current,
                  ),
                )
              }
            />
            <IconButton
              title="Remove row"
              onClick={() =>
                onChange(
                  values.length === 1
                    ? [""]
                    : values.filter((_, currentIndex) => currentIndex !== index),
                )
              }
            >
              <Trash2 />
            </IconButton>
          </div>
        ))}
      </div>
      <Button
        className="mt-2 border-[#33ccbb]/30 text-[#33ccbb]"
        size="sm"
        variant="outline"
        onClick={() => onChange([...values, ""])}
      >
        <Plus className="size-4" />
        ADD
      </Button>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  disabled,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-px bg-[#33ccbb]/20">
      {options.map((option) => (
        <button
          key={option.value}
          className={`h-10 text-xs font-black transition-colors ${
            value === option.value
              ? "bg-[#33ccbb] text-[#0a0f0e]"
              : "bg-[#0a0f0e] text-white hover:bg-[#33ccbb]/10"
          } disabled:cursor-not-allowed disabled:opacity-50`}
          disabled={disabled}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Badge({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "green" | "muted";
}) {
  const className =
    tone === "green"
      ? "border-emerald-300/30 bg-emerald-950/30 text-emerald-100"
      : tone === "muted"
        ? "border-white/10 bg-white/5 text-white/50"
        : "border-[#33ccbb]/20 bg-[#33ccbb]/10 text-[#33ccbb]";
  return (
    <span className={`inline-flex border px-2 py-1 text-[10px] font-bold ${className}`}>
      {children}
    </span>
  );
}

function IconButton({
  children,
  disabled,
  title,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex size-9 items-center justify-center border border-[#33ccbb]/20 bg-[#0a0f0e] text-[#33ccbb] transition-colors hover:border-[#33ccbb] hover:bg-[#33ccbb]/10 disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:size-4"
      disabled={disabled}
      title={title}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
