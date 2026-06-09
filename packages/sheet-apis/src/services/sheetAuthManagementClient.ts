import { Context, Effect, Layer } from "effect";
import { config } from "@/config";

type HttpMethod = "GET" | "POST";

export type OAuthManagementApiResponse<T = unknown> = {
  readonly status: number;
  readonly ok: boolean;
  readonly parsed: T;
};

export interface OAuthClientRecord {
  readonly client_id: string;
  readonly client_name?: string;
  readonly disabled?: boolean;
  readonly public?: boolean;
  readonly scope?: string;
  readonly token_endpoint_auth_method?: string;
  readonly grant_types?: readonly string[];
  readonly metadata?: Record<string, unknown> | null;
}

export interface OAuthClientMetadata {
  readonly trusted_service_client?: boolean;
  readonly allowed_services?: readonly string[];
  readonly allowed_scopes?: readonly string[];
  readonly owner_user_id?: string;
}

export interface OAuthClientCreatePayload {
  readonly client_name: string;
  readonly grant_types: readonly string[];
  readonly response_types: readonly string[];
  readonly redirect_uris: readonly string[];
  readonly scope: string;
  readonly token_endpoint_auth_method: string;
  readonly metadata?: OAuthClientMetadata;
  readonly public?: boolean;
}

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const makeRequest = <T>(
  method: HttpMethod,
  baseUrl: string,
  token: string,
  path: string,
  body?: unknown,
): Effect.Effect<OAuthManagementApiResponse<T>, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        credentials: "include",
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const text = await response.text();
      return {
        status: response.status,
        ok: response.ok,
        parsed: parseJson(text),
      } as OAuthManagementApiResponse<T>;
    },
    catch: (cause) => new Error(`OAuth management request failed: ${String(cause)}`),
  });

const makeAuthBaseUrl = (url: string) => url.replace(/\/$/, "");

export class SheetAuthManagementClient extends Context.Service<SheetAuthManagementClient>()(
  "SheetAuthManagementClient",
  {
    make: Effect.gen(function* () {
      const issuer = yield* config.sheetAuthIssuer;
      const baseUrl = makeAuthBaseUrl(issuer);

      const request = <T>(
        method: HttpMethod,
        token: string,
        path: string,
        body?: unknown,
      ): Effect.Effect<OAuthManagementApiResponse<T>, Error> =>
        makeRequest<T>(method, baseUrl, token, path, body);

      return {
        getClients: (token: string) =>
          request<OAuthClientRecord[] | null>("GET", token, "/oauth2/get-clients"),

        createClient: (token: string, payload: OAuthClientCreatePayload) =>
          request<OAuthClientRecord & { client_secret?: string }>(
            "POST",
            token,
            "/oauth2/create-client",
            payload,
          ),

        deleteClient: (token: string, clientId: string) =>
          request<{ status: string }>("POST", token, "/oauth2/delete-client", {
            client_id: clientId,
          }),

        rotateClientSecret: (token: string, clientId: string) =>
          request<OAuthClientRecord & { client_secret?: string }>(
            "POST",
            token,
            "/oauth2/client/rotate-secret",
            {
              client_id: clientId,
            },
          ),
      };
    }),
  },
) {
  static layer = Layer.effect(SheetAuthManagementClient, this.make);
}
