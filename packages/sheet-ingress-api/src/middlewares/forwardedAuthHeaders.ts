import { Effect, HashSet, Option, Redacted, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import { Unauthorized } from "typhoon-core/error";
import { Permission, SheetAuthOAuthScope } from "../schemas/permissions";

export const SHEET_AUTH_SESSION_TOKEN_UNAVAILABLE = "ingress-forwarded-token-unavailable";
export const SHEET_AUTH_TOKEN_HEADER = "x-sheet-auth-token";
export const SHEET_AUTH_SESSION_TOKEN_HEADER = "x-sheet-auth-session-token";

const getBearerToken = (authorization: string | undefined) => {
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length === 0 ? undefined : token;
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

const parseScopes = (scopes: string | undefined) =>
  Effect.forEach(scopes?.split(",").filter((scope) => scope.length > 0) ?? [], (scope) =>
    Schema.decodeUnknownEffect(SheetAuthOAuthScope)(scope),
  ).pipe(
    Effect.map((values) => new Set(values) as ReadonlySet<SheetAuthOAuthScope>),
    Effect.mapError(
      (cause) => new Unauthorized({ message: "Invalid forwarded auth scopes", cause }),
    ),
  );

export const decodeForwardedSheetAuthUser = (
  headers: Headers.Headers,
  options: { readonly unavailableToken: Redacted.Redacted<string> },
): Effect.Effect<
  {
    readonly accountId: string;
    readonly userId: string;
    readonly permissions: HashSet.HashSet<Permission>;
    readonly scopes: ReadonlySet<SheetAuthOAuthScope>;
    readonly token: Redacted.Redacted<string>;
  },
  Unauthorized,
  never
> =>
  Effect.gen(function* () {
    const userId = Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-user-id"));
    const accountId = Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-account-id"));

    if (!userId || !accountId) {
      return yield* Effect.fail(new Unauthorized({ message: "Missing forwarded auth user" }));
    }

    const permissions = yield* parsePermissions(
      Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-permissions")),
    );
    const scopes = yield* parseScopes(
      Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-scopes")),
    );
    const forwardedToken = getBearerToken(
      Option.getOrUndefined(Headers.get(headers, SHEET_AUTH_TOKEN_HEADER)),
    );
    const sessionToken =
      forwardedToken ??
      getBearerToken(Option.getOrUndefined(Headers.get(headers, SHEET_AUTH_SESSION_TOKEN_HEADER)));

    return {
      accountId,
      userId,
      permissions,
      scopes,
      token: sessionToken ? Redacted.make(sessionToken) : options.unavailableToken,
    };
  });
