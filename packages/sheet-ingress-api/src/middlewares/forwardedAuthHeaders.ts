import { Effect, HashSet, Option, Redacted, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import { Unauthorized } from "typhoon-core/error";
import { Permission } from "../schemas/permissions";

export const SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE = "ingress-forwarded-token-unavailable";

const getBearerToken = (authorization: string | undefined) => {
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length === 0 ? undefined : token;
};

const stringArraySchema = Schema.Array(Schema.Trim);

const parseBoolHeader = (value: string | undefined) => {
  if (value === undefined) {
    return Effect.succeed(undefined);
  }

  return Schema.decodeUnknownEffect(
    Schema.Union([Schema.Literal("true"), Schema.Literal("false")]),
  )(value.trim().toLowerCase()).pipe(
    Effect.map((parsed) => parsed === "true"),
    Effect.mapError(
      () =>
        new Unauthorized({ message: "Invalid forwarded auth trusted-client header", cause: value }),
    ),
  );
};

const parseOptionalStringSetHeader = (value: string | undefined) => {
  if (value === undefined) {
    return Effect.succeed(undefined);
  }
  if (value.length === 0) {
    return Effect.fail(
      new Unauthorized({ message: "Invalid forwarded auth allowed services header", cause: value }),
    );
  }

  const values = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return Schema.decodeUnknownEffect(stringArraySchema)(values).pipe(
    Effect.map(HashSet.fromIterable),
    Effect.mapError(
      () =>
        new Unauthorized({
          message: "Invalid forwarded auth allowed services header",
          cause: value,
        }),
    ),
  );
};

const parseAllowedScopes = (value: string | undefined) => {
  if (value === undefined) {
    return Effect.succeed(undefined);
  }
  if (value.length === 0) {
    return Effect.fail(
      new Unauthorized({ message: "Invalid forwarded auth allowed scopes header", cause: value }),
    );
  }

  const values = value
    .replaceAll(",", " ")
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return Schema.decodeUnknownEffect(stringArraySchema)(values).pipe(
    Effect.map(HashSet.fromIterable),
    Effect.mapError(
      () =>
        new Unauthorized({ message: "Invalid forwarded auth allowed scopes header", cause: value }),
    ),
  );
};

const parsePermissions = (permissions: string | undefined) =>
  Effect.forEach(
    permissions?.split(",").filter((permission) => permission.length > 0) ?? [],
    (permission) => Schema.decodeUnknownEffect(Permission)(permission),
  ).pipe(
    Effect.map((values) => HashSet.fromIterable(values)),
    Effect.mapError(
      (cause) => new Unauthorized({ message: "Invalid forwarded auth permissions", cause }),
    ),
  );

export const decodeForwardedSheetAuthUser = (
  headers: Headers.Headers,
  options: { readonly unavailableToken: Redacted.Redacted<string> },
): Effect.Effect<
  {
    readonly accountId: string;
    readonly userId: string;
    readonly clientId?: string;
    readonly trustedClient?: boolean;
    readonly allowedServices?: HashSet.HashSet<string>;
    readonly allowedScopes?: HashSet.HashSet<string>;
    readonly permissions: HashSet.HashSet<Permission>;
    readonly token: Redacted.Redacted<string>;
  },
  Unauthorized,
  never
> =>
  Effect.gen(function* () {
    const userId = Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-user-id"));
    const accountId = Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-account-id"));
    const trustedClient = yield* parseBoolHeader(
      Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-trusted-client")),
    );
    const allowedServices = yield* parseOptionalStringSetHeader(
      Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-allowed-services")),
    );
    const allowedScopes = yield* parseAllowedScopes(
      Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-allowed-scopes")),
    );

    if (!userId || !accountId) {
      return yield* Effect.fail(new Unauthorized({ message: "Missing forwarded auth user" }));
    }

    const permissions = yield* parsePermissions(
      Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-permissions")),
    );
    const sessionToken = getBearerToken(
      Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-session-token")),
    );

    return {
      accountId,
      userId,
      clientId: Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-client-id")),
      trustedClient,
      allowedServices,
      allowedScopes,
      permissions,
      token: sessionToken ? Redacted.make(sessionToken) : options.unavailableToken,
    };
  });
