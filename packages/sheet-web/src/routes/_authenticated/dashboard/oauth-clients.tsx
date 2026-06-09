import { useAtom, useAtomSet, useAtomSuspense } from "@effect/atom-react";
import { Atom, Reactivity } from "effect/unstable/reactivity";
import { createFileRoute } from "@tanstack/react-router";
import { type ChangeEvent, type FormEvent, useMemo } from "react";
import { Effect, Option, Redacted } from "effect";
import { ensureResultAtomData } from "#/lib/atomRegistry";
import { authBaseUrlAtom } from "#/lib/configAtoms";
import { useSession } from "#/lib/auth";
import { runtimeAtom } from "#/lib/runtime";

type HttpMethod = "GET" | "POST";

type ApiResponse<T> = {
  ok: boolean;
  status: number;
  parsed: T;
};

const OAUTH_CLIENT_REACTIVITY_KEY = "oauth-clients";

type JsonObject = Record<string, unknown>;

interface OAuthClientRecord {
  client_id: string;
  client_name?: string;
  disabled?: boolean;
  public?: boolean;
  scope?: string;
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  metadata?: JsonObject | null;
}

interface OAuthClientCreatePayload {
  client_name: string;
  grant_types: string[];
  response_types: string[];
  redirect_uris: string[];
  scope: string;
  token_endpoint_auth_method: string;
  metadata?: OAuthClientMetadata;
  public?: boolean;
}

interface OAuthClientCreateResponse extends OAuthClientRecord {
  client_secret?: string;
}

interface OAuthClientMetadata {
  trusted_service_client?: boolean;
  allowed_services?: string[];
  allowed_scopes?: string[];
  owner_user_id?: string;
}

interface OAuthClientFormState {
  clientName: string;
  allowedServices: string;
  allowedScopes: string;
  trusted: boolean;
  isPublic: boolean;
}

interface OAuthClientQueryResult {
  clients: readonly OAuthClientRecord[];
  error: string;
}

interface OAuthClientPageState {
  message: string;
  error: string;
  createdClientId: string;
  createdClientSecret: string;
  isSubmitting: boolean;
  revokingClientId: string | null;
}

type LoaderData = {
  authBaseUrl: string;
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];

const normalizeListInput = (value: string): string[] =>
  value
    .split(/[\n,\r\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const readErrorMessage = (parsed: unknown, fallback: string) => {
  const objectValue = isRecord(parsed) ? parsed : null;
  const message = objectValue?.message;
  const errorDescription = objectValue?.error_description;
  return typeof parsed === "string" && parsed.length > 0
    ? parsed
    : typeof message === "string"
      ? message
      : typeof errorDescription === "string"
        ? errorDescription
        : fallback;
};

const toMetadata = (metadata: JsonObject | null | undefined): OAuthClientMetadata => {
  if (!metadata) {
    return {};
  }
  return {
    trusted_service_client: metadata.trusted_service_client === true,
    allowed_services: asStringArray(metadata.allowed_services),
    allowed_scopes: asStringArray(metadata.allowed_scopes),
    owner_user_id: typeof metadata.owner_user_id === "string" ? metadata.owner_user_id : undefined,
  };
};

const asClientRows = (value: unknown): OAuthClientRecord[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((client): client is JsonObject => typeof client === "object" && client !== null)
    .map((client) => {
      const metadata = client.metadata;
      const normalizedMetadata =
        typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
          ? (metadata as JsonObject)
          : {};
      return {
        client_id: typeof client.client_id === "string" ? client.client_id : "",
        client_name: typeof client.client_name === "string" ? client.client_name : undefined,
        disabled: client.disabled === true,
        public: client.public === true,
        scope: typeof client.scope === "string" ? client.scope : undefined,
        token_endpoint_auth_method:
          typeof client.token_endpoint_auth_method === "string"
            ? client.token_endpoint_auth_method
            : undefined,
        grant_types: Array.isArray(client.grant_types)
          ? client.grant_types.filter((entry): entry is string => typeof entry === "string")
          : [],
        metadata: normalizedMetadata,
      };
    })
    .filter((client) => client.client_id.length > 0);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const makeRequest = (
  authBaseUrl: string,
  authToken: string,
  method: HttpMethod,
  path: string,
  body?: unknown,
) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${authBaseUrl.replace(/\/$/, "")}${path}`, {
          method,
          credentials: "include",
          headers: {
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            authorization: `Bearer ${authToken}`,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      catch: (cause) => new Error(`OAuth API request failed: ${String(cause)}`),
    });

    const responseText = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => Effect.succeed(""),
    });

    return {
      ok: response.ok,
      status: response.status,
      parsed: parseJson(responseText),
    } as ApiResponse<unknown>;
  });

const oauthClientsQueryAtom = (authBaseUrl: string, authToken: string | undefined) =>
  Atom.make(
    Effect.fnUntraced(function* () {
      if (!authToken) {
        return {
          clients: [] as const,
          error: "Sign in required to view OAuth clients.",
        } satisfies OAuthClientQueryResult;
      }

      const response = yield* makeRequest(authBaseUrl, authToken, "GET", "/oauth2/get-clients");

      if (!response.ok) {
        return {
          clients: [] as const,
          error: readErrorMessage(response.parsed, `Failed to load clients (${response.status})`),
        } satisfies OAuthClientQueryResult;
      }

      return {
        clients: asClientRows(response.parsed),
        error: "",
      } satisfies OAuthClientQueryResult;
    }),
  ).pipe(Atom.withReactivity([OAUTH_CLIENT_REACTIVITY_KEY]));

const createClientAtom = runtimeAtom.fn(
  Effect.fnUntraced(function* (
    {
      authBaseUrl,
      authToken,
      payload,
    }: {
      authBaseUrl: string;
      authToken: string;
      payload: OAuthClientCreatePayload;
    },
    _ctx: Atom.FnContext,
  ) {
    const response = yield* makeRequest(
      authBaseUrl,
      authToken,
      "POST",
      "/oauth2/create-client",
      payload,
    );
    yield* Reactivity.invalidate([OAUTH_CLIENT_REACTIVITY_KEY]);
    return response;
  }),
);

const revokeClientAtom = runtimeAtom.fn(
  Effect.fnUntraced(function* (
    {
      authBaseUrl,
      authToken,
      clientId,
    }: {
      authBaseUrl: string;
      authToken: string;
      clientId: string;
    },
    _ctx: Atom.FnContext,
  ) {
    const response = yield* makeRequest(authBaseUrl, authToken, "POST", "/oauth2/delete-client", {
      client_id: clientId,
    });
    yield* Reactivity.invalidate([OAUTH_CLIENT_REACTIVITY_KEY]);
    return response;
  }),
);

const buildCreatePayload = (formState: OAuthClientFormState): OAuthClientCreatePayload => {
  const allowedServices = normalizeListInput(formState.allowedServices);
  const allowedScopes = normalizeListInput(formState.allowedScopes);

  return {
    client_name: formState.clientName.trim(),
    grant_types: ["client_credentials"],
    response_types: ["code"],
    redirect_uris: ["https://localhost"],
    scope:
      allowedScopes.length > 0 ? allowedScopes.join(" ") : "sheet-apis sheet-workflows service",
    token_endpoint_auth_method: formState.isPublic ? "none" : "client_secret_basic",
    metadata: {
      trusted_service_client: formState.trusted,
      allowed_services: allowedServices,
      allowed_scopes: allowedScopes,
    },
    public: formState.isPublic,
  };
};

const extractCreateResponse = (parsed: unknown): OAuthClientCreateResponse | null =>
  isRecord(parsed) ? (parsed as unknown as OAuthClientCreateResponse) : null;

const hasAuthToken = (
  authToken: string | undefined,
  setPageState: (
    update: OAuthClientPageState | ((current: OAuthClientPageState) => OAuthClientPageState),
  ) => void,
  context: string,
): authToken is string => {
  if (authToken) {
    return true;
  }

  setPageState((current: OAuthClientPageState) => ({
    ...current,
    error: `Sign in required to ${context} clients.`,
  }));
  return false;
};

const runCreateClient = async (
  createClient: (payload: {
    authBaseUrl: string;
    authToken: string;
    payload: OAuthClientCreatePayload;
  }) => Promise<ApiResponse<unknown>>,
  {
    authBaseUrl,
    authToken,
    formState,
  }: {
    authBaseUrl: string;
    authToken: string;
    formState: OAuthClientFormState;
  },
  setFormState: (
    update: OAuthClientFormState | ((current: OAuthClientFormState) => OAuthClientFormState),
  ) => void,
  setPageState: (
    update: OAuthClientPageState | ((current: OAuthClientPageState) => OAuthClientPageState),
  ) => void,
) => {
  try {
    const response = await createClient({
      authBaseUrl,
      authToken,
      payload: buildCreatePayload(formState),
    });

    if (!response.ok) {
      setPageState((current) => ({
        ...current,
        isSubmitting: false,
        error: readErrorMessage(response.parsed, `Client create failed (${response.status})`),
      }));
      return;
    }

    const created = extractCreateResponse(response.parsed);
    setFormState((current) => ({ ...current, clientName: "" }));
    setPageState((current) => ({
      ...current,
      isSubmitting: false,
      createdClientId: created?.client_id ?? "",
      createdClientSecret: created?.client_secret ?? "",
      message: created?.client_id
        ? `Created client: ${created?.client_name?.trim() || created.client_id}`
        : "Client created",
    }));
  } catch (error) {
    setPageState((current) => ({
      ...current,
      isSubmitting: false,
      error: error instanceof Error ? error.message : "Failed to create client",
    }));
  }
};

const runRevokeClient = async (
  revokeClient: (payload: {
    authBaseUrl: string;
    authToken: string;
    clientId: string;
  }) => Promise<ApiResponse<unknown>>,
  {
    authBaseUrl,
    authToken,
    clientId,
  }: {
    authBaseUrl: string;
    authToken: string;
    clientId: string;
  },
  setPageState: (
    update: OAuthClientPageState | ((current: OAuthClientPageState) => OAuthClientPageState),
  ) => void,
) => {
  try {
    const response = await revokeClient({ authBaseUrl, authToken, clientId });

    if (!response.ok) {
      setPageState((current) => ({
        ...current,
        revokingClientId: null,
        error: readErrorMessage(response.parsed, `Revoke failed (${response.status})`),
      }));
      return;
    }

    setPageState((current) => ({
      ...current,
      revokingClientId: null,
      message: `Revoked client ${clientId}`,
    }));
  } catch (error) {
    setPageState((current) => ({
      ...current,
      revokingClientId: null,
      error: error instanceof Error ? error.message : "Failed to revoke client",
    }));
  }
};

const OAuthClientCard = ({
  client,
  revokingClientId,
  onRevoke,
}: {
  client: OAuthClientRecord;
  revokingClientId: string | null;
  onRevoke: (clientId: string) => void;
}) => {
  const metadata = toMetadata(client.metadata);
  const services = asStringArray(metadata.allowed_services);
  const scopes = asStringArray(metadata.allowed_scopes);

  return (
    <div key={client.client_id} className="border border-[#33ccbb]/20 p-4 bg-black/20 grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-black text-sm text-[#33ccbb]">
            {client.client_name?.trim() || client.client_id}
          </p>
          <p className="text-white/50 text-xs break-all">{client.client_id}</p>
        </div>
        <button
          className="px-3 py-1.5 text-xs bg-[#ff6b6b] text-white font-black tracking-wide disabled:opacity-40"
          disabled={revokingClientId === client.client_id}
          onClick={() => onRevoke(client.client_id)}
        >
          {revokingClientId === client.client_id ? "REVOKING..." : "REVOKE"}
        </button>
      </div>
      <div className="flex flex-wrap gap-2 text-xs text-white/80">
        <span>{client.public ? "PUBLIC" : "CONFIDENTIAL"}</span>
        <span>&middot;</span>
        <span>{client.public ? "No secret rotation" : "Secret required"}</span>
        {metadata.trusted_service_client ? (
          <>
            <span>&middot;</span>
            <span className="text-[#7de2b8]">TRUSTED</span>
          </>
        ) : null}
      </div>
      <div className="text-xs text-white/70">
        <div>Allowed services: {services.length > 0 ? services.join(", ") : "not set"}</div>
        <div>
          Allowed scopes: {scopes.length > 0 ? scopes.join(", ") : (client.scope ?? "not set")}
        </div>
      </div>
    </div>
  );
};

export const Route = createFileRoute("/_authenticated/dashboard/oauth-clients")({
  component: OAuthClientsPage,
  loader: async ({ context }) => {
    const authBaseUrl = await Effect.runPromise(
      ensureResultAtomData(context.atomRegistry, authBaseUrlAtom),
    );
    return {
      authBaseUrl: authBaseUrl.href,
    };
  },
});

function OAuthClientsPage() {
  const { authBaseUrl } = Route.useLoaderData() as LoaderData;
  const session = useSession();
  const authToken = useMemo(() => {
    if (Option.isNone(session) || session.value.token === undefined) {
      return undefined;
    }
    return Redacted.value(session.value.token);
  }, [session]);

  const clientsAtom = useMemo(
    () => oauthClientsQueryAtom(authBaseUrl, authToken),
    [authBaseUrl, authToken],
  );
  const clientsState = useAtomSuspense(clientsAtom, {
    suspendOnWaiting: false,
    includeFailure: false,
  }).value ?? { clients: [], error: "" };

  const [formState, setFormState] = useAtom(
    useMemo(
      () =>
        Atom.make<OAuthClientFormState>({
          clientName: "",
          allowedServices: "sheet-apis,sheet-workflows",
          allowedScopes: "sheet-apis sheet-workflows service",
          trusted: false,
          isPublic: true,
        }),
      [],
    ),
  );

  const [pageState, setPageState] = useAtom(
    useMemo(
      () =>
        Atom.make<OAuthClientPageState>({
          message: "",
          error: "",
          createdClientId: "",
          createdClientSecret: "",
          isSubmitting: false,
          revokingClientId: null,
        }),
      [],
    ),
  );

  const createClient = useAtomSet(createClientAtom, { mode: "promise" });
  const revokeClient = useAtomSet(revokeClientAtom, { mode: "promise" });

  const onCreateSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!hasAuthToken(authToken, setPageState, "create")) {
      return;
    }

    setPageState((current) => ({
      ...current,
      isSubmitting: true,
      message: "",
      error: "",
      createdClientId: "",
      createdClientSecret: "",
    }));

    void runCreateClient(
      createClient,
      { authBaseUrl, authToken, formState },
      setFormState,
      setPageState,
    );
  };

  const onRevoke = (clientId: string) => {
    if (!hasAuthToken(authToken, setPageState, "revoke")) {
      return;
    }

    setPageState((current) => ({
      ...current,
      revokingClientId: clientId,
      message: "",
      error: "",
    }));

    void runRevokeClient(
      revokeClient,
      {
        authBaseUrl,
        authToken,
        clientId,
      },
      setPageState,
    );
  };

  const updateField =
    (name: keyof OAuthClientFormState) =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value =
        event.target.type === "checkbox"
          ? (event.target as HTMLInputElement).checked
          : event.target.value;
      setFormState((current: OAuthClientFormState) => ({ ...current, [name]: value as never }));
    };

  return (
    <div className="grid gap-6">
      <section className="bg-[#101816] border border-[#33ccbb]/25 p-6">
        <h2 className="text-[#33ccbb] text-lg font-black tracking-[0.1em] mb-2">OAUTH CLIENTS</h2>
        <p className="text-white/80 text-sm mb-4">
          Create and manage OAuth clients for service access.
        </p>

        <form className="grid gap-4" onSubmit={onCreateSubmit}>
          <div className="grid md:grid-cols-2 gap-4">
            <label className="grid gap-2 text-sm">
              <span className="font-black tracking-wide text-white/80">Client Name</span>
              <input
                className="h-10 bg-black/30 border border-[#33ccbb]/30 px-3 text-sm outline-none focus:border-[#33ccbb] text-white"
                value={formState.clientName}
                onChange={updateField("clientName")}
                placeholder="e.g. sheet-workflow-bot"
                required
              />
            </label>
            <label className="grid gap-2 text-sm">
              <span className="font-black tracking-wide text-white/80">Allowed Services</span>
              <input
                className="h-10 bg-black/30 border border-[#33ccbb]/30 px-3 text-sm outline-none focus:border-[#33ccbb] text-white"
                value={formState.allowedServices}
                onChange={updateField("allowedServices")}
                placeholder="sheet-apis,sheet-workflows"
              />
            </label>
          </div>
          <label className="grid gap-2 text-sm">
            <span className="font-black tracking-wide text-white/80">Allowed Scopes</span>
            <textarea
              className="min-h-16 bg-black/30 border border-[#33ccbb]/30 px-3 py-2 text-sm outline-none focus:border-[#33ccbb] text-white"
              value={formState.allowedScopes}
              onChange={updateField("allowedScopes")}
              placeholder="sheet-apis sheet-workflows service"
            />
          </label>

          <div className="flex flex-wrap gap-6 text-sm">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={formState.isPublic}
                onChange={updateField("isPublic")}
                className="size-4 accent-[#33ccbb]"
              />
              <span>Public client</span>
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={formState.trusted}
                onChange={updateField("trusted")}
                className="size-4 accent-[#33ccbb]"
              />
              <span>Trusted service client</span>
            </label>
          </div>

          <button
            type="submit"
            className="w-fit px-4 py-2 bg-[#33ccbb] text-[#0a0f0e] font-black tracking-wide disabled:opacity-40"
            disabled={pageState.isSubmitting}
          >
            {pageState.isSubmitting ? "CREATING..." : "CREATE CLIENT"}
          </button>
        </form>
      </section>

      <section className="bg-[#101816] border border-[#33ccbb]/25 p-6">
        <h2 className="text-[#33ccbb] text-lg font-black tracking-[0.1em] mb-4">MANAGED CLIENTS</h2>

        {pageState.error.length > 0 ? (
          <p className="text-[#ff6b6b] text-sm mb-3">{pageState.error}</p>
        ) : clientsState.error.length > 0 ? (
          <p className="text-[#ff6b6b] text-sm mb-3">{clientsState.error}</p>
        ) : null}
        {pageState.message.length > 0 ? (
          <p className="text-[#7de2b8] text-sm mb-3">{pageState.message}</p>
        ) : null}
        {pageState.createdClientId.length > 0 ? (
          <p className="text-white/80 text-xs mb-4">
            Client ID: <span className="text-white">{pageState.createdClientId}</span>
            {pageState.createdClientSecret.length > 0 ? (
              <>
                <br />
                Client secret:{" "}
                <span className="text-white font-mono break-all">
                  {pageState.createdClientSecret}
                </span>
              </>
            ) : null}
          </p>
        ) : null}

        {clientsState.clients.length === 0 ? (
          <p className="text-white/60 text-sm">No OAuth clients found.</p>
        ) : (
          <div className="grid gap-3">
            {clientsState.clients.map((client: OAuthClientRecord) => (
              <OAuthClientCard
                key={client.client_id}
                client={client}
                revokingClientId={pageState.revokingClientId}
                onRevoke={onRevoke}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
