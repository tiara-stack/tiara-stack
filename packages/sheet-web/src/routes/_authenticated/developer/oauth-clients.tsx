import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Cause, Effect, Option, Schema } from "effect";
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
import type { Dispatch, KeyboardEvent, ReactNode, RefObject, SetStateAction } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  OAuthClientCreateInput,
  OAuthClientDetails,
  OAuthClientUpdateInput,
} from "sheet-auth/client";
import { PublicOAuthScopes } from "sheet-auth/oauth";
import { Button } from "#/components/ui/button";
import {
  OAuthClientCreateInputSchema,
  OAuthClientUpdateInputSchema,
  normalizeOAuthClientCreateInput,
  normalizeOAuthClientUpdateInput,
  useCreateOAuthClient,
  useDeleteOAuthClient,
  useOAuthClientsResult,
  useRotateOAuthClientSecret,
  useUpdateOAuthClient,
} from "#/lib/oauthClients";

export const Route = createFileRoute("/_authenticated/developer/oauth-clients")({
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
  preservedScopes: string[];
};

type RevealedClientSecret = {
  clientId: string;
  secret: string;
  visible: boolean;
};

type ActiveOperation = {
  id: number;
  name: string;
};

type ClientFormPayload = {
  input: OAuthClientCreateInput | OAuthClientUpdateInput;
  error?: string | undefined;
};

type BackgroundAccessibilityState = {
  element: HTMLElement | null;
  hadInert: boolean;
  ariaHidden: string | null;
};

type OperationState = {
  activeOperationRef: RefObject<ActiveOperation | undefined>;
  operationIdRef: RefObject<number>;
  setActiveOperation: (operation: ActiveOperation | undefined) => void;
  setOperationError: (error: string | undefined) => void;
};

type OAuthClientActionContext = {
  createClient: ReturnType<typeof useCreateOAuthClient>;
  deleteClient: ReturnType<typeof useDeleteOAuthClient>;
  mountedRef: RefObject<boolean>;
  revealedSecret: RevealedClientSecret | undefined;
  rotateClientSecret: ReturnType<typeof useRotateOAuthClientSecret>;
  runOperation: (operation: string, action: () => Promise<void>) => Promise<void>;
  setCopiedSecretClientId: (clientId: string | undefined) => void;
  setForm: (form: ClientFormState | undefined) => void;
  setOperationError: (error: string | undefined) => void;
  setRevealedSecret: Dispatch<SetStateAction<RevealedClientSecret | undefined>>;
  updateClient: ReturnType<typeof useUpdateOAuthClient>;
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
  preservedScopes: [],
});

const clientIsTrusted = (client: OAuthClientDetails) =>
  typeof client.metadata === "object" &&
  client.metadata !== null &&
  !Array.isArray(client.metadata) &&
  client.metadata.trusted === true;

const splitScope = (scope: string | undefined) =>
  scope
    ?.split(" ")
    .map((value) => value.trim())
    .filter((value) => value.length > 0) ?? [];

const scopeIsAllowed = (scope: string) =>
  allowedScopes.includes(scope as (typeof allowedScopes)[number]);

const catalogScopes = (scope: string | undefined) => splitScope(scope).filter(scopeIsAllowed);

const nonCatalogScopes = (scope: string | undefined) =>
  splitScope(scope).filter((value) => !scopeIsAllowed(value));

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
  scopes: catalogScopes(client.scope),
  preservedScopes: nonCatalogScopes(client.scope),
});

const formClientType = (form: ClientFormState) =>
  form.kind === "public" ? form.publicType : ("web" as const);

const formScopes = (form: ClientFormState, isUpdate: boolean) =>
  isUpdate ? [...form.scopes, ...form.preservedScopes] : form.scopes;

const formPayloadError = (redirectUris: readonly string[], scopes: readonly string[]) => {
  if (redirectUris.length === 0) {
    return "At least one redirect URI is required";
  }
  if (scopes.join(" ").trim().length === 0) {
    return "At least one scope is required";
  }
  return undefined;
};

const formPayloadInput = (
  form: ClientFormState,
  redirectUris: readonly string[],
  scope: string,
  isUpdate: boolean,
) => {
  const input = {
    redirect_uris: redirectUris,
    scope,
    client_name: optionalString(form.name),
    client_uri: optionalString(form.clientUri),
    logo_uri: optionalString(form.logoUri),
    contacts: listOrUndefined(form.contacts),
    policy_uri: optionalString(form.policyUri),
    tos_uri: optionalString(form.tosUri),
  };

  return isUpdate
    ? {
        ...input,
        type: formClientType(form),
      }
    : {
        ...input,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        type: formClientType(form),
      };
};

const makeFormPayload = (form: ClientFormState, isUpdate = false): ClientFormPayload => {
  const redirectUris = cleanList(form.redirectUris);
  const scopes = formScopes(form, isUpdate);
  const scope = scopes.join(" ");
  const error = formPayloadError(redirectUris, scopes);

  return {
    input: error ? {} : formPayloadInput(form, redirectUris, scope, isUpdate),
    error,
  };
};

const messageFromUnknown = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const secretDisplayValue = (secret: RevealedClientSecret) =>
  secret.visible ? secret.secret : "************************";

const secretToggleTitle = (secret: RevealedClientSecret) =>
  secret.visible ? "Hide secret" : "Show secret";

const secretToggleIcon = (secret: RevealedClientSecret) => (secret.visible ? <EyeOff /> : <Eye />);

const copySecretIcon = (copiedClientId: string | undefined, secret: RevealedClientSecret) =>
  copiedClientId === secret.clientId ? <Check /> : <Copy />;

const clientTypeLabel = (client: OAuthClientDetails) =>
  client.token_endpoint_auth_method === "none" ? "PUBLIC" : "CONFIDENTIAL";

const asyncResultErrorMessage = (result: ReturnType<typeof useOAuthClientsResult>) =>
  result._tag === "Failure" ? messageFromUnknown(Cause.squash(result.cause)) : undefined;

const pageError = (
  operationError: string | undefined,
  result: ReturnType<typeof useOAuthClientsResult>,
) => operationError ?? asyncResultErrorMessage(result);

const activeOperationName = (operation: ActiveOperation | undefined) => operation?.name;

const rowActionsWorking = (working: boolean, waiting: boolean) => working || waiting;

const toggleRevealedSecretVisibility = (
  current: RevealedClientSecret | undefined,
): RevealedClientSecret | undefined =>
  current ? { ...current, visible: !current.visible } : current;

const asyncResultClients = (result: ReturnType<typeof useOAuthClientsResult>) => {
  if (result._tag === "Success") {
    return result.value;
  }
  return Option.match(result.previousSuccess, {
    onNone: () => [] as readonly OAuthClientDetails[],
    onSome: (previous) => previous.value,
  });
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

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const focusableElements = (element: HTMLElement) =>
  Array.from(element.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (nextElement) => nextElement.offsetParent !== null,
  );

const focusDialogFallback = (event: KeyboardEvent<HTMLElement>, dialog: HTMLElement) => {
  event.preventDefault();
  dialog.focus();
};

const cycleDialogFocus = (
  event: KeyboardEvent<HTMLElement>,
  first: HTMLElement,
  last: HTMLElement,
) => {
  const boundary = event.shiftKey ? first : last;
  if (document.activeElement !== boundary) {
    return;
  }

  event.preventDefault();
  const nextElement = event.shiftKey ? last : first;
  nextElement.focus();
};

const keepFocusInsideDialog = (event: KeyboardEvent<HTMLElement>, dialog: HTMLElement) => {
  const focusable = focusableElements(dialog);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    focusDialogFallback(event, dialog);
    return;
  }

  cycleDialogFocus(event, first, last);
};

const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>, dialog: HTMLElement | null) => {
  if (event.key === "Tab" && dialog) {
    keepFocusInsideDialog(event, dialog);
  }
};

const hideBackgroundContent = (element: HTMLElement | null): BackgroundAccessibilityState => {
  const state = {
    element,
    hadInert: element?.hasAttribute("inert") ?? false,
    ariaHidden: element?.getAttribute("aria-hidden") ?? null,
  };
  element?.setAttribute("inert", "");
  element?.setAttribute("aria-hidden", "true");
  return state;
};

const restoreBackgroundContent = (state: BackgroundAccessibilityState) => {
  const { element } = state;
  if (!element) {
    return;
  }
  element.toggleAttribute("inert", state.hadInert);
  if (state.ariaHidden === null) {
    element.removeAttribute("aria-hidden");
  } else {
    element.setAttribute("aria-hidden", state.ariaHidden);
  }
};

const focusDialogContent = (dialog: HTMLElement | null) => {
  const firstFocusable = dialog ? focusableElements(dialog)[0] : undefined;
  (firstFocusable ?? dialog)?.focus();
};

const restoreDialogAccessibility = (
  focusFrame: number,
  backgroundState: BackgroundAccessibilityState,
  previousFocus: HTMLElement | undefined,
) => {
  window.cancelAnimationFrame(focusFrame);
  restoreBackgroundContent(backgroundState);
  previousFocus?.focus();
};

const operationIsCurrent = (state: OperationState, operation: ActiveOperation) =>
  state.activeOperationRef.current?.id === operation.id;

const setOperationErrorIfCurrent = (
  state: OperationState,
  operation: ActiveOperation,
  error: unknown,
) => {
  if (operationIsCurrent(state, operation)) {
    state.setOperationError(messageFromUnknown(error));
  }
};

const clearOperationIfCurrent = (state: OperationState, operation: ActiveOperation) => {
  if (operationIsCurrent(state, operation)) {
    state.activeOperationRef.current = undefined;
    state.setActiveOperation(undefined);
  }
};

const startClientOperation = (state: OperationState, operation: string) => {
  if (state.activeOperationRef.current !== undefined) {
    return undefined;
  }

  const nextOperation = { id: ++state.operationIdRef.current, name: operation };
  state.activeOperationRef.current = nextOperation;
  state.setActiveOperation(nextOperation);
  state.setOperationError(undefined);
  return nextOperation;
};

const executeClientOperation = async (
  state: OperationState,
  operation: ActiveOperation,
  action: () => Promise<void>,
) => {
  try {
    await action();
  } catch (error) {
    setOperationErrorIfCurrent(state, operation, error);
  } finally {
    clearOperationIfCurrent(state, operation);
  }
};

const runClientOperation = async (
  state: OperationState,
  operationName: string,
  action: () => Promise<void>,
) => {
  const operation = startClientOperation(state, operationName);
  if (operation) {
    await executeClientOperation(state, operation, action);
  }
};

const revealClientSecret = (
  setRevealedSecret: Dispatch<SetStateAction<RevealedClientSecret | undefined>>,
  clientId: string,
  secret: string | undefined,
) => {
  if (secret) {
    setRevealedSecret({
      clientId,
      secret,
      visible: true,
    });
  }
};

const clearRevealedClientSecret = (
  setRevealedSecret: Dispatch<SetStateAction<RevealedClientSecret | undefined>>,
  clientId: string,
) => {
  setRevealedSecret((current) => (current?.clientId === clientId ? undefined : current));
};

const updateOAuthClientFromForm = async (
  context: OAuthClientActionContext,
  clientId: string,
  payload: ClientFormPayload,
) => {
  const input = await Effect.runPromise(
    Schema.decodeUnknownEffect(OAuthClientUpdateInputSchema)(payload.input),
  );
  await context.updateClient({ clientId, input: normalizeOAuthClientUpdateInput(input) });
};

const createOAuthClientFromForm = async (
  context: OAuthClientActionContext,
  form: ClientFormState,
  payload: ClientFormPayload,
) => {
  const input = await Effect.runPromise(
    Schema.decodeUnknownEffect(OAuthClientCreateInputSchema)({
      ...payload.input,
      token_endpoint_auth_method: form.kind === "public" ? "none" : "client_secret_basic",
    }),
  );
  const created = await context.createClient(normalizeOAuthClientCreateInput(input));
  revealClientSecret(context.setRevealedSecret, created.client_id, created.client_secret);
};

const persistOAuthClient = async (
  context: OAuthClientActionContext,
  form: ClientFormState,
  payload: ClientFormPayload,
) => {
  return form.clientId
    ? updateOAuthClientFromForm(context, form.clientId, payload)
    : createOAuthClientFromForm(context, form, payload);
};

const saveOAuthClientForm = async (
  context: OAuthClientActionContext,
  nextForm: ClientFormState,
) => {
  const isUpdate = nextForm.clientId !== undefined;
  const payload = makeFormPayload(nextForm, isUpdate);
  if (payload.error) {
    context.setOperationError(payload.error);
    return;
  }

  await context.runOperation("save", async () => {
    await persistOAuthClient(context, nextForm, payload);
    context.setForm(undefined);
  });
};

const rotateOAuthClientSecretForClient = async (
  context: OAuthClientActionContext,
  client: OAuthClientDetails,
) => {
  await context.runOperation(`rotate:${client.client_id}`, async () => {
    const rotated = await context.rotateClientSecret({ clientId: client.client_id });
    clearRevealedClientSecret(context.setRevealedSecret, client.client_id);
    revealClientSecret(context.setRevealedSecret, client.client_id, rotated.client_secret);
  });
};

const deleteOAuthClientForClient = async (
  context: OAuthClientActionContext,
  client: OAuthClientDetails,
) => {
  const label = client.client_name || client.client_id;
  if (!window.confirm(`Delete OAuth client "${label}"? This cannot be undone.`)) {
    return;
  }

  await context.runOperation(`delete:${client.client_id}`, async () => {
    await context.deleteClient({ clientId: client.client_id });
    clearRevealedClientSecret(context.setRevealedSecret, client.client_id);
  });
};

const copyRevealedClientSecret = async (context: OAuthClientActionContext) => {
  if (!context.revealedSecret) {
    return;
  }

  const copyError = await copyText(context.revealedSecret.secret);
  if (copyError) {
    context.setOperationError(copyError);
    return;
  }

  context.setOperationError(undefined);
  context.setCopiedSecretClientId(context.revealedSecret.clientId);
  window.setTimeout(() => {
    if (context.mountedRef.current) {
      context.setCopiedSecretClientId(undefined);
    }
  }, 2_000);
};

function OAuthClientsPage() {
  const clientsResult = useOAuthClientsResult();
  const createClient = useCreateOAuthClient();
  const updateClient = useUpdateOAuthClient();
  const rotateClientSecret = useRotateOAuthClientSecret();
  const deleteClient = useDeleteOAuthClient();
  const [activeOperation, setActiveOperation] = useState<ActiveOperation | undefined>();
  const [operationError, setOperationError] = useState<string | undefined>();
  const [form, setForm] = useState<ClientFormState | undefined>();
  const [revealedSecret, setRevealedSecret] = useState<RevealedClientSecret>();
  const [copiedSecretClientId, setCopiedSecretClientId] = useState<string | undefined>();
  const mountedRef = useRef(true);
  const operationIdRef = useRef(0);
  const activeOperationRef = useRef<ActiveOperation | undefined>(undefined);
  const pageContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clients = asyncResultClients(clientsResult);
  const visibleClients = useMemo(
    () => clients.filter((client) => !clientIsTrusted(client)),
    [clients],
  );
  const working = activeOperation !== undefined;
  const error = pageError(operationError, clientsResult);
  const operationState = {
    activeOperationRef,
    operationIdRef,
    setActiveOperation,
    setOperationError,
  };

  const runOperation = async (operation: string, action: () => Promise<void>) => {
    await runClientOperation(operationState, operation, action);
  };

  const actionContext = {
    createClient,
    deleteClient,
    mountedRef,
    revealedSecret,
    rotateClientSecret,
    runOperation,
    setCopiedSecretClientId,
    setForm,
    setOperationError,
    setRevealedSecret,
    updateClient,
  };

  const saveClient = async (nextForm: ClientFormState) => {
    await saveOAuthClientForm(actionContext, nextForm);
  };

  const rotateSecret = async (client: OAuthClientDetails) => {
    await rotateOAuthClientSecretForClient(actionContext, client);
  };

  const removeClient = async (client: OAuthClientDetails) => {
    await deleteOAuthClientForClient(actionContext, client);
  };

  const copySecret = async () => {
    await copyRevealedClientSecret(actionContext);
  };

  const openForm = (nextForm: ClientFormState) => {
    setOperationError(undefined);
    setForm(nextForm);
  };

  return (
    <div className="min-h-screen px-8 pb-12 pt-32 text-white">
      <div ref={pageContentRef} className="mx-auto max-w-7xl">
        <OAuthClientsHeader disabled={working} onCreate={() => openForm(emptyForm())} />
        <div className="border border-[#33ccbb]/20 bg-[#0f1615]">
          <ErrorBanner error={error} />
          <SecretReveal
            copiedClientId={copiedSecretClientId}
            secret={revealedSecret}
            onCopy={copySecret}
            onDismiss={() => setRevealedSecret(undefined)}
            onToggleVisible={() => setRevealedSecret(toggleRevealedSecretVisibility)}
          />
          <OAuthClientsTable
            activeOperation={activeOperationName(activeOperation)}
            clients={visibleClients}
            loading={clientsResult.waiting}
            onDelete={removeClient}
            onEdit={(nextClient) => openForm(toForm(nextClient))}
            onRotate={rotateSecret}
            working={rowActionsWorking(working, clientsResult.waiting)}
          />
        </div>
      </div>

      <ClientDialogSlot
        backgroundRef={pageContentRef}
        error={operationError}
        form={form}
        working={working}
        onCancel={() => setForm(undefined)}
        onSave={saveClient}
      />
    </div>
  );
}

function OAuthClientsHeader({ disabled, onCreate }: { disabled: boolean; onCreate: () => void }) {
  return (
    <div className="mb-8 border-b border-[#33ccbb]/20 pb-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center bg-[#33ccbb]">
            <KeyRound className="size-5 text-[#0a0f0e]" />
          </div>
          <div>
            <p className="text-[10px] font-bold tracking-[0.2em] text-[#33ccbb]">DEVELOPER</p>
            <h1 className="text-xl font-black tracking-tight">
              OAUTH <span className="text-[#33ccbb]">CLIENTS</span>
            </h1>
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
  working,
}: {
  activeOperation: string | undefined;
  clients: readonly OAuthClientDetails[];
  loading: boolean;
  onDelete: (client: OAuthClientDetails) => Promise<void>;
  onEdit: (client: OAuthClientDetails) => void;
  onRotate: (client: OAuthClientDetails) => Promise<void>;
  working: boolean;
}) {
  const columns = useMemo(
    () =>
      [
        {
          accessorKey: "client_name",
          header: "NAME",
          cell: ({ row }) => row.original.client_name ?? "UNTITLED",
        },
        {
          accessorKey: "client_id",
          header: "CLIENT ID",
          cell: ({ row }) => (
            <span className="font-mono text-xs text-white/60">{row.original.client_id}</span>
          ),
        },
        {
          id: "type",
          header: "TYPE",
          cell: ({ row }) => <Badge>{clientTypeLabel(row.original)}</Badge>,
        },
        {
          id: "scopes",
          header: "SCOPES",
          cell: ({ row }) => (
            <div className="flex max-w-[280px] flex-wrap gap-1">
              {splitScope(row.original.scope).map((scope) => (
                <Badge key={scope}>{scope}</Badge>
              ))}
            </div>
          ),
        },
        {
          id: "actions",
          header: () => <span className="block text-right">ACTIONS</span>,
          cell: ({ row }) => (
            <OAuthClientRowActions
              activeOperation={activeOperation}
              client={row.original}
              onDelete={onDelete}
              onEdit={onEdit}
              onRotate={onRotate}
              working={working}
            />
          ),
        },
      ] satisfies ColumnDef<OAuthClientDetails>[],
    [activeOperation, onDelete, onEdit, onRotate, working],
  );
  const table = useReactTable({
    data: [...clients],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] border-collapse text-left text-sm">
        <thead className="bg-[#0a0f0e] text-[10px] font-bold tracking-[0.18em] text-[#33ccbb]">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} className="px-5 py-3">
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody className="divide-y divide-[#33ccbb]/10">
          <OAuthClientTableBody loading={loading} table={table} />
        </tbody>
      </table>
    </div>
  );
}

function OAuthClientTableBody({
  loading,
  table,
}: {
  loading: boolean;
  table: ReturnType<typeof useReactTable<OAuthClientDetails>>;
}) {
  if (loading && table.getRowModel().rows.length === 0) {
    return <EmptyClientRow label="LOADING" />;
  }
  if (table.getRowModel().rows.length === 0) {
    return <EmptyClientRow label="NO CLIENTS" />;
  }

  return table.getRowModel().rows.map((row) => (
    <tr key={row.id} className="bg-[#0f1615] text-white">
      {row.getVisibleCells().map((cell) => (
        <td key={cell.id} className="px-5 py-4">
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  ));
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

function OAuthClientRowActions({
  activeOperation,
  client,
  onDelete,
  onEdit,
  onRotate,
  working,
}: {
  activeOperation: string | undefined;
  client: OAuthClientDetails;
  onDelete: (client: OAuthClientDetails) => Promise<void>;
  onEdit: (client: OAuthClientDetails) => void;
  onRotate: (client: OAuthClientDetails) => Promise<void>;
  working: boolean;
}) {
  const rotateActive = activeOperation === `rotate:${client.client_id}`;
  const deleteActive = activeOperation === `delete:${client.client_id}`;
  const isConfidential = client.token_endpoint_auth_method !== "none";

  return (
    <div className="flex justify-end gap-2">
      <IconButton disabled={working} title="Edit client" onClick={() => onEdit(client)}>
        <Pencil />
      </IconButton>
      {isConfidential && (
        <IconButton disabled={working} title="Rotate secret" onClick={() => void onRotate(client)}>
          <ActiveIcon active={rotateActive} idle={<RotateCcw />} />
        </IconButton>
      )}
      <IconButton disabled={working} title="Delete client" onClick={() => void onDelete(client)}>
        <ActiveIcon active={deleteActive} idle={<Trash2 />} />
      </IconButton>
    </div>
  );
}

function ActiveIcon({ active, idle }: { active: boolean; idle: ReactNode }) {
  return active ? <LoaderCircle className="animate-spin" /> : idle;
}

function ClientDialogSlot({
  backgroundRef,
  error,
  form,
  working,
  onCancel,
  onSave,
}: {
  backgroundRef: RefObject<HTMLElement | null>;
  error: string | undefined;
  form: ClientFormState | undefined;
  working: boolean;
  onCancel: () => void;
  onSave: (form: ClientFormState) => Promise<void>;
}) {
  return form ? (
    <ClientDialog
      backgroundRef={backgroundRef}
      error={error}
      initialValue={form}
      working={working}
      onCancel={onCancel}
      onSave={onSave}
    />
  ) : null;
}

function ClientDialog({
  backgroundRef,
  error,
  initialValue,
  working,
  onCancel,
  onSave,
}: {
  backgroundRef: RefObject<HTMLElement | null>;
  error: string | undefined;
  initialValue: ClientFormState;
  working: boolean;
  onCancel: () => void;
  onSave: (form: ClientFormState) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const form = useForm({
    defaultValues: initialValue,
    onSubmit: async ({ value }) => {
      await onSave(value);
    },
  });

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const backgroundState = hideBackgroundContent(backgroundRef.current);
    const focusFrame = window.requestAnimationFrame(() => focusDialogContent(dialogRef.current));

    return () => restoreDialogAccessibility(focusFrame, backgroundState, previousFocus);
  }, [backgroundRef]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-20">
      <form
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-full max-w-4xl border border-[#33ccbb]/30 bg-[#0f1615] shadow-2xl"
        role="dialog"
        tabIndex={-1}
        onKeyDown={(event) => handleDialogKeyDown(event, dialogRef.current)}
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <div className="flex items-center justify-between border-b border-[#33ccbb]/20 px-5 py-4">
          <div>
            <p className="text-[10px] font-bold tracking-[0.18em] text-[#33ccbb]">
              {initialValue.clientId ? "EDIT" : "CREATE"}
            </p>
            <h3 id={titleId} className="text-base font-black text-white">
              OAUTH CLIENT
            </h3>
          </div>
          <IconButton disabled={working} title="Close" onClick={onCancel}>
            <X />
          </IconButton>
        </div>

        <ErrorBanner error={error} />

        <div className="grid gap-5 p-5 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <form.Field name="kind">
              {(field) => (
                <Segmented
                  disabled={Boolean(initialValue.clientId)}
                  value={field.state.value}
                  options={[
                    { value: "confidential", label: "CONFIDENTIAL" },
                    { value: "public", label: "PUBLIC" },
                  ]}
                  onChange={(kind) => field.handleChange(kind)}
                />
              )}
            </form.Field>

            <form.Subscribe selector={(state) => state.values.kind}>
              {(kind) =>
                kind === "public" ? (
                  <form.Field name="publicType">
                    {(field) => (
                      <Segmented
                        value={field.state.value}
                        options={[
                          { value: "native", label: "NATIVE" },
                          { value: "user-agent-based", label: "USER AGENT" },
                        ]}
                        onChange={(publicType) => field.handleChange(publicType)}
                      />
                    )}
                  </form.Field>
                ) : null
              }
            </form.Subscribe>

            <form.Field name="name">
              {(field) => (
                <Field label="NAME">
                  <Input
                    value={field.state.value}
                    placeholder="Sheet tooling"
                    onBlur={field.handleBlur}
                    onChange={(value) => field.handleChange(value)}
                  />
                </Field>
              )}
            </form.Field>

            <form.Field name="redirectUris">
              {(field) => (
                <ListEditor
                  label="REDIRECT URIS"
                  required
                  values={field.state.value}
                  placeholder="https://example.com/oauth/callback"
                  onChange={(redirectUris) => field.handleChange(redirectUris)}
                />
              )}
            </form.Field>

            <div className="grid gap-4 md:grid-cols-2">
              <form.Field name="clientUri">
                {(field) => (
                  <Field label="CLIENT URI">
                    <Input
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(value) => field.handleChange(value)}
                    />
                  </Field>
                )}
              </form.Field>
              <form.Field name="logoUri">
                {(field) => (
                  <Field label="LOGO URI">
                    <Input
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(value) => field.handleChange(value)}
                    />
                  </Field>
                )}
              </form.Field>
              <form.Field name="policyUri">
                {(field) => (
                  <Field label="POLICY URI">
                    <Input
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(value) => field.handleChange(value)}
                    />
                  </Field>
                )}
              </form.Field>
              <form.Field name="tosUri">
                {(field) => (
                  <Field label="TOS URI">
                    <Input
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(value) => field.handleChange(value)}
                    />
                  </Field>
                )}
              </form.Field>
            </div>

            <form.Field name="contacts">
              {(field) => (
                <ListEditor
                  label="CONTACTS"
                  values={field.state.value}
                  placeholder="ops@example.com"
                  onChange={(contacts) => field.handleChange(contacts)}
                />
              )}
            </form.Field>
          </div>

          <form.Field name="scopes">
            {(field) => (
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
                        checked={field.state.value.includes(scope)}
                        className="size-4 accent-[#33ccbb]"
                        type="checkbox"
                        onChange={(event) =>
                          field.handleChange(
                            event.target.checked
                              ? [...field.state.value, scope]
                              : field.state.value.filter((value) => value !== scope),
                          )
                        }
                      />
                      <span className="font-mono text-xs">{scope}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </form.Field>
        </div>

        <div className="flex justify-end gap-2 border-t border-[#33ccbb]/20 px-5 py-4">
          <Button type="button" variant="outline" disabled={working} onClick={onCancel}>
            <X className="size-4" />
            CANCEL
          </Button>
          <Button
            className="bg-[#33ccbb] text-[#0a0f0e] hover:bg-[#33ccbb]/80"
            disabled={working}
            type="submit"
          >
            {working ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            SAVE
          </Button>
        </div>
      </form>
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
  onBlur,
  onChange,
  placeholder,
  required,
  value,
}: {
  onBlur?: () => void;
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
      onBlur={onBlur}
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
              {...(required === undefined ? {} : { required })}
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
        type="button"
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
