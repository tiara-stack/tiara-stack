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

// fallow-ignore-next-line code-duplication
// fallow-ignore-next-line code-duplication
const parseBoolHeader = (value: string | undefined) => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.toLowerCase().trim();
  return normalized === "true" ? true : normalized === "false" ? false : undefined;
};

const parseOptionalStringSetHeader = (value: string | undefined) => {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return HashSet.fromIterable(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
};

const parseAllowedScopes = (value: string | undefined) => {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return HashSet.fromIterable(
    value
      .replaceAll(",", " ")
      .split(" ")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
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
    const trustedClient = parseBoolHeader(
      Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-trusted-client")),
    );
    const allowedServices = parseOptionalStringSetHeader(
      Option.getOrUndefined(Headers.get(headers, "x-sheet-auth-allowed-services")),
    );
    const allowedScopes = parseAllowedScopes(
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
