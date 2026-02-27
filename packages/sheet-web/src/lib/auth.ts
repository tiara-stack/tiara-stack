import { Atom, Result, useAtomSet, useAtomSuspense } from "@effect-atom/atom-react";
import { createIsomorphicFn, getRouterInstance } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { Effect, Schema } from "effect";
import { Reactivity } from "@effect/experimental";
import { createSheetAuthClient, getSession, getToken } from "sheet-auth/client";
import { appBaseUrlAtom, authBaseUrlAtom } from "#/lib/configAtoms";
import { runtimeAtom } from "#/lib/runtime";
import { useCallback } from "react";

const getRequestHeadersFn = createIsomorphicFn()
  .server(() => getRequestHeaders())
  .client(() => undefined);

// Derived atom for auth client using get.result to unwrap the Result
export const authClientAtom = Atom.make(
  Effect.fnUntraced(function* (get) {
    const baseUrl = yield* get.result(authBaseUrlAtom);
    return createSheetAuthClient(baseUrl.href);
  }),
);

export const useAuthClient = () => {
  const result = useAtomSuspense(authClientAtom, {
    suspendOnWaiting: true,
    includeFailure: false,
  });
  return result.value;
};

// Auth state atom that automatically fetches session
export const sessionAtom = Atom.make(
  Effect.fnUntraced(function* (get) {
    return yield* Effect.gen(function* () {
      const authClient = yield* get.result(authClientAtom);
      return yield* getSession(authClient, getRequestHeadersFn());
    }).pipe(Effect.catchAll(() => Effect.succeedNone));
  }),
).pipe(
  Atom.serializable({
    key: "session",
    schema: Result.Schema({
      success: Schema.Option(
        Schema.Struct({
          user: Schema.Struct({
            id: Schema.String,
            createdAt: Schema.Date,
            updatedAt: Schema.Date,
            email: Schema.String,
            emailVerified: Schema.Boolean,
            name: Schema.String,
            image: Schema.optional(Schema.NullOr(Schema.String)),
          }),
          session: Schema.Struct({
            id: Schema.String,
            userId: Schema.String,
            token: Schema.String,
            expiresAt: Schema.Date,
            ipAddress: Schema.optional(Schema.NullOr(Schema.String)),
            userAgent: Schema.optional(Schema.NullOr(Schema.String)),
            createdAt: Schema.Date,
            updatedAt: Schema.Date,
          }),
        }),
      ),
    }),
  }),
  Atom.withReactivity(["session"]),
);

export const useSession = () => {
  const result = useAtomSuspense(sessionAtom, {
    suspendOnWaiting: true,
    includeFailure: false,
  });
  return result.value;
};

export const sessionJwtAtom = Atom.make(
  Effect.fnUntraced(function* (get) {
    return yield* Effect.gen(function* () {
      const authClient = yield* get.result(authClientAtom);
      return yield* getToken(authClient, getRequestHeadersFn());
    }).pipe(Effect.catchAll(() => Effect.succeedNone));
  }),
).pipe(
  Atom.serializable({
    key: "jwt",
    schema: Result.Schema({ success: Schema.Option(Schema.String) }),
  }),
  Atom.withReactivity(["jwt"]),
);

export const useSessionJwt = () => {
  const result = useAtomSuspense(sessionJwtAtom, {
    suspendOnWaiting: true,
    includeFailure: false,
  });
  return result.value;
};

// Sign out function atom
export const signOut = runtimeAtom.fn(
  Effect.fnUntraced(function* (_, ctx: Atom.FnContext) {
    const authClient = yield* ctx.result(authClientAtom);

    yield* Effect.tryPromise({
      try: () => authClient.signOut(),
      catch: () => new Error("Failed to sign out"),
    });

    yield* Effect.log("Signed out successfully");
    yield* Reactivity.invalidate(["session"]);

    const router = yield* Effect.promise(() => Promise.resolve(getRouterInstance()));
    router.invalidate();
  }),
);

export const useSignOut = () => {
  const signOutFn = useAtomSet(signOut, { mode: "promise" });
  return useCallback(() => signOutFn(void 0), [signOutFn]);
};

// Sign in with Discord function atom
export const signInWithDiscord = runtimeAtom.fn(
  Effect.fnUntraced(function* (_, ctx: Atom.FnContext) {
    const authClient = yield* ctx.result(authClientAtom);
    const appBaseUrl = yield* ctx.result(appBaseUrlAtom);

    yield* Effect.promise(() =>
      authClient.signIn.social({
        provider: "discord",
        callbackURL: `${appBaseUrl.href}/dashboard`,
      }),
    );

    yield* Effect.log("Sign in initiated");
    yield* Reactivity.invalidate(["session"]);

    const router = yield* Effect.promise(() => Promise.resolve(getRouterInstance()));
    router.invalidate();
  }),
);

export const useSignInWithDiscord = () => {
  const signInWithDiscordFn = useAtomSet(signInWithDiscord, { mode: "promise" });
  return useCallback(() => signInWithDiscordFn(void 0), [signInWithDiscordFn]);
};
