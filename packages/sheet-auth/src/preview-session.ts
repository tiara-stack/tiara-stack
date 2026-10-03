import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export const PreviewSessionBindingSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: Schema.Number.check(Schema.isGreaterThan(0)),
  role: Schema.NonEmptyString,
});
export type PreviewSessionBinding = typeof PreviewSessionBindingSchema.Type;

export const assertPreviewSessionAuthorityConfiguration = (
  controllerUrlConfigured: boolean,
  authorityTokenConfigured: boolean,
  requirePreviewSessionForTokenExchange = false,
) => {
  if (controllerUrlConfigured !== authorityTokenConfigured) {
    throw new Error(
      "Preview session controller URL and authority token must be configured together",
    );
  }
  if (
    requirePreviewSessionForTokenExchange &&
    (!controllerUrlConfigured || !authorityTokenConfigured)
  ) {
    throw new Error(
      "Preview session controller URL and authority token must be configured when token-exchange binding is required",
    );
  }
};

/** Injected bridge to the durable preview-session controller. */
export interface PreviewSessionAuthority {
  readonly requiresBinding: (clientId: string) => Promise<boolean>;
  readonly authorize: (input: {
    readonly binding: PreviewSessionBinding;
    readonly clientId: string | undefined;
  }) => Promise<boolean>;
}

const PreviewSessionAuthorityResponse = Schema.Struct({ authorized: Schema.Boolean });
const PreviewSessionBindingRequiredResponse = Schema.Struct({ required: Schema.Boolean });

/** HTTPS-only RPC client for the controller's narrow authorization endpoint. */
export const makeHttpPreviewSessionAuthority = (options: {
  readonly controllerUrl: string;
  readonly authorityToken: Redacted.Redacted<string>;
  readonly httpClient: HttpClient.HttpClient;
}): PreviewSessionAuthority => {
  if (Redacted.value(options.authorityToken).trim().length === 0) {
    throw new Error("Preview session authority token must be configured");
  }
  const endpoint = new URL(options.controllerUrl);
  if (endpoint.protocol !== "https:") {
    throw new Error("Preview session controller URL must use HTTPS");
  }
  const url = `${endpoint.origin.replace(/\/$/, "")}/_internal/preview/v1/authorize`;
  return {
    requiresBinding: async (clientId) => {
      if (!clientId) return false;
      const program = HttpClientRequest.post(
        `${endpoint.origin}/_internal/preview/v1/client-requires-binding`,
      ).pipe(
        HttpClientRequest.bearerToken(options.authorityToken),
        HttpClientRequest.schemaBodyJson(Schema.Struct({ oauthClientId: Schema.NonEmptyString }))({
          oauthClientId: clientId,
        }),
        Effect.flatMap(options.httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(PreviewSessionBindingRequiredResponse)),
        Effect.timeout("5 seconds"),
      );
      try {
        const response = await Effect.runPromise(program);
        return response.required;
      } catch {
        return true;
      }
    },
    authorize: async (input) => {
      if (!input.clientId) return false;
      const body = { binding: input.binding, clientId: input.clientId };
      const program = HttpClientRequest.post(url).pipe(
        HttpClientRequest.bearerToken(options.authorityToken),
        HttpClientRequest.schemaBodyJson(
          Schema.Struct({
            binding: PreviewSessionBindingSchema,
            clientId: Schema.NonEmptyString,
          }),
        )(body),
        Effect.flatMap(options.httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(PreviewSessionAuthorityResponse)),
        Effect.timeout("5 seconds"),
      );
      try {
        const response = await Effect.runPromise(program);
        return response.authorized;
      } catch {
        return false;
      }
    },
  };
};

export const authorizePreviewSession = async (
  authority: PreviewSessionAuthority | undefined,
  binding: PreviewSessionBinding,
  clientId: string | undefined,
) => {
  if (!authority) return false;
  return await authority.authorize({ binding, clientId });
};
