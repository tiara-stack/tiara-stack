import { useAtomSet, useAtomSuspense } from "@effect/atom-react";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { Duration, Effect, Schema } from "effect";
import { Atom, Reactivity } from "effect/unstable/reactivity";
import { useCallback } from "react";
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
import { authClientAtom } from "#/lib/auth";
import { runtimeAtom } from "#/lib/runtime";

const oauthClientsReactivityKey = "oauthClients";

const getRequestHeadersFn = createIsomorphicFn()
  .server(() => getRequestHeaders())
  .client(() => undefined);

const oauthClientsAtom = Atom.make(
  Effect.fnUntraced(function* (get) {
    const authClient = yield* get.result(authClientAtom);
    return yield* listOAuthClients(authClient, getRequestHeadersFn());
  }),
).pipe(Atom.setIdleTTL(Duration.minutes(5)), Atom.withReactivity([oauthClientsReactivityKey]));

const invalidateOAuthClients = Reactivity.invalidate([oauthClientsReactivityKey]);

const OAuthClientGrantType = Schema.Literals([
  "authorization_code",
  "client_credentials",
  "refresh_token",
]);
const OAuthClientResponseType = Schema.Literal("code");
const OAuthClientType = Schema.Literals(["web", "native", "user-agent-based"]);
const OAuthClientTokenEndpointAuthMethod = Schema.Literals([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);

const OAuthClientOptionalInputFields = {
  scope: Schema.optional(Schema.String),
  client_name: Schema.optional(Schema.String),
  client_uri: Schema.optional(Schema.String),
  logo_uri: Schema.optional(Schema.String),
  contacts: Schema.optional(Schema.Array(Schema.String)),
  tos_uri: Schema.optional(Schema.String),
  policy_uri: Schema.optional(Schema.String),
  grant_types: Schema.optional(Schema.Array(OAuthClientGrantType)),
  response_types: Schema.optional(Schema.Array(OAuthClientResponseType)),
  type: Schema.optional(OAuthClientType),
} as const;

export const OAuthClientCreateInputSchema = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  ...OAuthClientOptionalInputFields,
  token_endpoint_auth_method: Schema.optional(OAuthClientTokenEndpointAuthMethod),
});

export const OAuthClientUpdateInputSchema = Schema.Struct({
  redirect_uris: Schema.optional(Schema.Array(Schema.String)),
  ...OAuthClientOptionalInputFields,
});

type CreateOAuthClientMutation = OAuthClientCreateInput;

type UpdateOAuthClientMutation = {
  readonly clientId: string;
  readonly input: OAuthClientUpdateInput;
};

type RotateOAuthClientSecretMutation = {
  readonly clientId: string;
};

type DeleteOAuthClientMutation = {
  readonly clientId: string;
};

const UpdateOAuthClientMutationSchema = Schema.Struct({
  clientId: Schema.String,
  input: OAuthClientUpdateInputSchema,
});

const OAuthClientIdMutationSchema = Schema.Struct({
  clientId: Schema.String,
});

const createOAuthClientAtom = runtimeAtom.fn(
  Effect.fnUntraced(function* (payload: CreateOAuthClientMutation, ctx: Atom.FnContext) {
    const input = yield* Schema.decodeUnknownEffect(OAuthClientCreateInputSchema)(payload);
    const authClient = yield* ctx.result(authClientAtom);
    const created = yield* createOAuthClient(authClient, input, getRequestHeadersFn());
    yield* invalidateOAuthClients;
    return created;
  }),
);

const updateOAuthClientAtom = runtimeAtom.fn(
  Effect.fnUntraced(function* (payload: UpdateOAuthClientMutation, ctx: Atom.FnContext) {
    const { clientId, input } = yield* Schema.decodeUnknownEffect(UpdateOAuthClientMutationSchema)(
      payload,
    );
    const authClient = yield* ctx.result(authClientAtom);
    const updated = yield* updateOAuthClient(authClient, clientId, input, getRequestHeadersFn());
    yield* invalidateOAuthClients;
    return updated;
  }),
);

const rotateOAuthClientSecretAtom = runtimeAtom.fn(
  Effect.fnUntraced(function* (payload: RotateOAuthClientSecretMutation, ctx: Atom.FnContext) {
    const { clientId } = yield* Schema.decodeUnknownEffect(OAuthClientIdMutationSchema)(payload);
    const authClient = yield* ctx.result(authClientAtom);
    const rotated = yield* rotateOAuthClientSecret(authClient, clientId, getRequestHeadersFn());
    yield* invalidateOAuthClients;
    return rotated;
  }),
);

const deleteOAuthClientAtom = runtimeAtom.fn(
  Effect.fnUntraced(function* (payload: DeleteOAuthClientMutation, ctx: Atom.FnContext) {
    const { clientId } = yield* Schema.decodeUnknownEffect(OAuthClientIdMutationSchema)(payload);
    const authClient = yield* ctx.result(authClientAtom);
    yield* deleteOAuthClient(authClient, clientId, getRequestHeadersFn());
    yield* invalidateOAuthClients;
  }),
);

export const useOAuthClientsResult = () =>
  useAtomSuspense(oauthClientsAtom, {
    suspendOnWaiting: false,
    includeFailure: true,
  });

export const useCreateOAuthClient = () => {
  const mutate = useAtomSet(createOAuthClientAtom, { mode: "promise" });
  return useCallback(
    (input: CreateOAuthClientMutation) => mutate(input) as Promise<OAuthClientDetails>,
    [mutate],
  );
};

export const useUpdateOAuthClient = () => {
  const mutate = useAtomSet(updateOAuthClientAtom, { mode: "promise" });
  return useCallback(
    (input: UpdateOAuthClientMutation) => mutate(input) as Promise<OAuthClientDetails>,
    [mutate],
  );
};

export const useRotateOAuthClientSecret = () => {
  const mutate = useAtomSet(rotateOAuthClientSecretAtom, { mode: "promise" });
  return useCallback(
    (input: RotateOAuthClientSecretMutation) => mutate(input) as Promise<OAuthClientDetails>,
    [mutate],
  );
};

export const useDeleteOAuthClient = () => {
  const mutate = useAtomSet(deleteOAuthClientAtom, { mode: "promise" });
  return useCallback(
    (input: DeleteOAuthClientMutation) => mutate(input) as Promise<void>,
    [mutate],
  );
};
