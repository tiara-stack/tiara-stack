import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { Effect, Option, Redacted } from "effect";
import { ensureResultAtomData } from "#/lib/atomRegistry";
import { authBaseUrlAtom } from "#/lib/configAtoms";
import { useSession } from "#/lib/auth";

type JsonObject = Record<string, unknown>;

type HttpMethod = "GET" | "POST";

type ApiResponse<T> = {
  ok: boolean;
  status: number;
  parsed: T;
};

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

type LoaderData = {
  authBaseUrl: string;
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];

const normalizeListInput = (value: string): string[] =>
  value
    .split(/[,\n\r\s]+/)
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
  if (typeof parsed === "string" && parsed.length > 0) {
    return parsed;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "message" in parsed &&
    typeof (parsed as JsonObject).message === "string"
  ) {
    return (parsed as JsonObject).message as string;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "error_description" in parsed &&
    typeof (parsed as JsonObject).error_description === "string"
  ) {
    return (parsed as JsonObject).error_description as string;
  }
  return fallback;
};

const toMetadata = (metadata: JsonObject | null | undefined): OAuthClientMetadata => {
  if (!metadata) return {};
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
  const [clients, setClients] = useState<OAuthClientRecord[]>([]);
  const [isLoadingClients, setIsLoadingClients] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [createdClientSecret, setCreatedClientSecret] = useState("");
  const [createdClientId, setCreatedClientId] = useState("");
  const [formState, setFormState] = useState<OAuthClientFormState>({
    clientName: "",
    allowedServices: "sheet-apis,sheet-workflows",
    allowedScopes: "sheet-apis sheet-workflows service",
    trusted: false,
    isPublic: true,
  });

  const authHeader = useMemo(() => {
    if (Option.isNone(session)) {
      return undefined;
    }
    if (session.value.token === undefined) {
      return undefined;
    }
    return `Bearer ${Redacted.value(session.value.token)}`;
  }, [session]);

  const request = useCallback(
    async (method: HttpMethod, path: string, body?: unknown) => {
      const response = await fetch(`${authBaseUrl.replace(/\/$/, "")}${path}`, {
        method,
        credentials: "include",
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(authHeader !== undefined ? { authorization: authHeader } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const responseText = await response.text();
      const parsed = parseJson(responseText) as unknown;
      return {
        ok: response.ok,
        status: response.status,
        parsed,
      } satisfies ApiResponse<unknown>;
    },
    [authBaseUrl, authHeader],
  );

  const requestAs = useCallback(
    <T,>(method: HttpMethod, path: string, body?: unknown) =>
      request(method, path, body).then((response) => response as ApiResponse<T>),
    [request],
  );

  const loadClients = useCallback(async () => {
    setIsLoadingClients(true);
    setError("");
    try {
      const response = await requestAs<OAuthClientRecord[] | null>("GET", "/oauth2/get-clients");
      if (!response.ok) {
        throw new Error(
          readErrorMessage(response.parsed, `Failed to load clients (${response.status})`),
        );
      }
      setClients(asClientRows(response.parsed));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load clients");
    } finally {
      setIsLoadingClients(false);
    }
  }, [requestAs]);

  useEffect(() => {
    void loadClients();
  }, [loadClients]);

  const onCreateSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage("");
    setError("");
    setCreatedClientId("");
    setCreatedClientSecret("");

    const allowedServices = normalizeListInput(formState.allowedServices);
    const allowedScopes = normalizeListInput(formState.allowedScopes);
    const scope =
      allowedScopes.length > 0 ? allowedScopes.join(" ") : "sheet-apis sheet-workflows service";
    const metadata: OAuthClientMetadata = {
      trusted_service_client: formState.trusted,
      allowed_services: allowedServices,
      allowed_scopes: allowedScopes,
    };

    try {
      const response = await requestAs<OAuthClientCreateResponse>("POST", "/oauth2/create-client", {
        client_name: formState.clientName.trim(),
        grant_types: ["client_credentials"],
        response_types: ["code"],
        redirect_uris: ["https://localhost"],
        scope,
        token_endpoint_auth_method: formState.isPublic ? "none" : "client_secret_basic",
        metadata,
        public: formState.isPublic,
      });

      if (!response.ok) {
        throw new Error(
          readErrorMessage(response.parsed, `Client create failed (${response.status})`),
        );
      }
      const created = response.parsed as OAuthClientCreateResponse;
      setCreatedClientId(created.client_id);
      setCreatedClientSecret(created.client_secret ?? "");
      setMessage(`Created client: ${created.client_name ?? created.client_id}`);
      setFormState((state) => ({
        ...state,
        clientName: "",
      }));
      await loadClients();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create client");
    } finally {
      setIsSubmitting(false);
    }
  };

  const onRevoke = async (clientId: string) => {
    setRevokingId(clientId);
    setMessage("");
    setError("");
    try {
      const response = await requestAs<{ status: string }>("POST", "/oauth2/delete-client", {
        client_id: clientId,
      });
      if (!response.ok) {
        throw new Error(readErrorMessage(response.parsed, `Revoke failed (${response.status})`));
      }
      setClients((current) => current.filter((client) => client.client_id !== clientId));
      setMessage(`Revoked client ${clientId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to revoke client");
    } finally {
      setRevokingId(null);
    }
  };

  const updateField =
    (name: keyof OAuthClientFormState) =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value =
        event.target.type === "checkbox"
          ? (event.target as HTMLInputElement).checked
          : event.target.value;
      setFormState((state) => ({
        ...state,
        [name]: value as never,
      }));
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
            disabled={isSubmitting}
          >
            {isSubmitting ? "CREATING..." : "CREATE CLIENT"}
          </button>
        </form>
      </section>

      <section className="bg-[#101816] border border-[#33ccbb]/25 p-6">
        <h2 className="text-[#33ccbb] text-lg font-black tracking-[0.1em] mb-4">MANAGED CLIENTS</h2>

        {error.length > 0 ? <p className="text-[#ff6b6b] text-sm mb-3">{error}</p> : null}
        {message.length > 0 ? <p className="text-[#7de2b8] text-sm mb-3">{message}</p> : null}
        {createdClientId.length > 0 ? (
          <p className="text-white/80 text-xs mb-4">
            Client ID: <span className="text-white">{createdClientId}</span>
            {createdClientSecret.length > 0 ? (
              <>
                <br />
                Client secret:{" "}
                <span className="text-white font-mono break-all">{createdClientSecret}</span>
              </>
            ) : null}
          </p>
        ) : null}

        {isLoadingClients ? (
          <p className="text-white/60 text-sm">Loading clients...</p>
        ) : clients.length === 0 ? (
          <p className="text-white/60 text-sm">No OAuth clients found.</p>
        ) : (
          <div className="grid gap-3">
            {clients.map((client) => {
              const metadata = toMetadata(client.metadata);
              const services = asStringArray(metadata.allowed_services);
              const scopes = asStringArray(metadata.allowed_scopes);
              return (
                <div
                  key={client.client_id}
                  className="border border-[#33ccbb]/20 p-4 bg-black/20 grid gap-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-black text-sm text-[#33ccbb]">
                        {client.client_name?.trim() || client.client_id}
                      </p>
                      <p className="text-white/50 text-xs break-all">{client.client_id}</p>
                    </div>
                    <button
                      className="px-3 py-1.5 text-xs bg-[#ff6b6b] text-white font-black tracking-wide disabled:opacity-40"
                      disabled={revokingId === client.client_id}
                      onClick={() => onRevoke(client.client_id)}
                    >
                      {revokingId === client.client_id ? "REVOKING..." : "REVOKE"}
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
                    <div>
                      Allowed services: {services.length > 0 ? services.join(", ") : "not set"}
                    </div>
                    <div>
                      Allowed scopes:{" "}
                      {scopes.length > 0 ? scopes.join(", ") : (client.scope ?? "not set")}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
