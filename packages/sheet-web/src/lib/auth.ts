import { useAtomSet, useAtomSuspense } from "@effect/atom-react";
import { Atom, Reactivity } from "effect/unstable/reactivity";
import { createIsomorphicFn, getRouterInstance } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { Duration, Effect, Exit, Predicate, Schema } from "effect";
import { createSheetAuthClient, getSession } from "sheet-auth/client";
import { appBaseUrlAtom, authBaseUrlAtom } from "#/lib/configAtoms";
import { clearSheetWebOAuthToken } from "#/lib/oauth";
import { runtimeAtom } from "#/lib/runtime";
import { useCallback } from "react";
import * as Data from "effect/Data";

class SheetWebLibAuthError extends Data.TaggedError("SheetWebLibAuthError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const getRequestHeadersFn = createIsomorphicFn()
  .server(() => getRequestHeaders())
  .client(() => undefined);

const SocialProvider = Schema.Literal("discord");
type SocialProvider = Schema.Schema.Type<typeof SocialProvider>;

// Derived atom for auth client using get.result to unwrap the Result
export const authClientAtom = Atom.make(
  Effect.fnUntraced(function* (get) {
    const baseUrl = yield* get.result(authBaseUrlAtom);
    return createSheetAuthClient(baseUrl.href);
  }),
);

// Auth state atom that automatically fetches session
export const sessionAtom = Atom.make(
  Effect.fnUntraced(function* (get) {
    return yield* Effect.gen(function* () {
      const authClient = yield* get.result(authClientAtom);
      return yield* getSession(authClient, getRequestHeadersFn());
    }).pipe(Effect.catch(() => Effect.succeedNone));
  }),
).pipe(Atom.setIdleTTL(Duration.minutes(5)), Atom.withReactivity(["session"]));

export const useSession = () => {
  const result = useAtomSuspense(sessionAtom, {
    suspendOnWaiting: false,
    includeFailure: false,
  });
  return result.value;
};

// Sign out function atom
const signOut = runtimeAtom.fn(
  Effect.fnUntraced(function* (_, ctx: Atom.FnContext) {
    const authClient = yield* ctx.result(authClientAtom);

    const sessionLogout = Effect.tryPromise({
      try: () => authClient.signOut(),
      catch: () => new SheetWebLibAuthError({ message: "Failed to sign out" }),
    });
    const oauthCleanup = Effect.tryPromise({
      try: () => clearSheetWebOAuthToken(),
      catch: () => new SheetWebLibAuthError({ message: "Failed to clear Sheet OAuth session" }),
    }).pipe(
      Effect.tapError((error) => Effect.logError("Failed to clear Sheet OAuth session", error)),
    );

    yield* Effect.gen(function* () {
      // Both server-side logout operations must be attempted, but either failure should keep the
      // mutation failed so the UI cannot report a partial logout as successful.
      const sessionExit = yield* Effect.exit(sessionLogout);
      const oauthExit = yield* Effect.exit(oauthCleanup);
      if (Exit.isFailure(sessionExit)) return yield* Effect.failCause(sessionExit.cause);
      if (Exit.isFailure(oauthExit)) return yield* Effect.failCause(oauthExit.cause);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Reactivity.invalidate(["session"]).pipe(Effect.ignore);
          const router = yield* Effect.sync(() => getRouterInstance()).pipe(
            Effect.flatMap((value) =>
              Predicate.isPromise(value) ? Effect.promise(() => value) : Effect.succeed(value),
            ),
          );
          yield* Effect.promise(() => router.invalidate());
        }).pipe(
          Effect.tapError((error) =>
            Effect.logError("Failed to refresh the signed-out route", error),
          ),
          Effect.ignore,
        ),
      ),
    );
  }),
);

export const useSignOut = () => {
  const signOutFn = useAtomSet(signOut, { mode: "promise" });
  return useCallback(() => signOutFn(void 0), [signOutFn]);
};

// Sign in with social provider function atom
const signInWithSocialProvider = runtimeAtom.fn(
  Effect.fnUntraced(function* (provider: string, ctx: Atom.FnContext) {
    const socialProvider = yield* Schema.decodeUnknownEffect(SocialProvider)(provider);
    const authClient = yield* ctx.result(authClientAtom);
    const appBaseUrl = yield* ctx.result(appBaseUrlAtom);

    yield* Effect.promise(() =>
      authClient.signIn.social({
        provider: socialProvider,
        callbackURL: `${appBaseUrl.href}/dashboard`,
      }),
    );

    // this redirects to the social provider login page, so we don't need to invalidate the session atom
  }),
);

export const useSignInWithSocialProvider = (provider: SocialProvider) => {
  const signInWithProviderFn = useAtomSet(signInWithSocialProvider, {
    mode: "promise",
  });
  return useCallback(() => signInWithProviderFn(provider), [signInWithProviderFn, provider]);
};
