import { Atom, Result, useAtomSet, useAtomSuspense } from "@effect-atom/atom-react";
import { createIsomorphicFn, getRouterInstance } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { Duration, Effect, Schema } from "effect";
import { Reactivity } from "@effect/experimental";
import { createSheetAuthClient, getSession } from "sheet-auth/client";
import { Session } from "sheet-auth/model";
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
    suspendOnWaiting: false,
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
  Atom.setIdleTTL(Duration.minutes(5)),
  Atom.serializable({
    key: "session",
    schema: Result.Schema({
      success: Schema.Option(Session),
    }),
  }),
  Atom.withReactivity(["session"]),
);

export const useSession = () => {
  const result = useAtomSuspense(sessionAtom, {
    suspendOnWaiting: false,
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

    yield* Reactivity.invalidate(["session"]);

    const router = yield* Effect.promise(() => Promise.resolve(getRouterInstance()));
    void router.invalidate();
  }),
);

export const useSignOut = () => {
  const signOutFn = useAtomSet(signOut, { mode: "promise" });
  return useCallback(() => signOutFn(void 0), [signOutFn]);
};

// Sign in with social provider function atom
export const signInWithSocialProvider = runtimeAtom.fn(
  Effect.fnUntraced(function* (provider: string, ctx: Atom.FnContext) {
    const authClient = yield* ctx.result(authClientAtom);
    const appBaseUrl = yield* ctx.result(appBaseUrlAtom);

    yield* Effect.promise(() =>
      authClient.signIn.social({
        provider,
        callbackURL: `${appBaseUrl.href}/dashboard`,
      }),
    );

    // this redirects to the social provider login page, so we don't need to invalidate the session atom
  }),
);

export const useSignInWithSocialProvider = (provider: string) => {
  const signInWithProviderFn = useAtomSet(signInWithSocialProvider, {
    mode: "promise",
  });
  return useCallback(() => signInWithProviderFn(provider), [signInWithProviderFn, provider]);
};
