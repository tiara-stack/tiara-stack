import { it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Deferred, Duration, Effect, Fiber, Layer, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect } from "vitest";
import {
  makePreviewAuth,
  PreviewAuthError,
  type PreviewAuthAdapters,
  type PreviewAuthBinding,
} from "./preview-auth";
import { makePreviewSessionController } from "./preview-sessions";

const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        TestClock.layer(),
      ),
    ),
  );

it.effect(
  "signs in two sessions, proxies protected requests, and rejects callback, leak, cookie and lifecycle bypasses",
  () =>
    run(
      Effect.gen(function* () {
        let now = 1_000_000;
        const controller = yield* makePreviewSessionController(() => now);
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* Effect.forEach(["a", "b"], (name) =>
          Effect.gen(function* () {
            const created = yield* controller.create({
              owner: name,
              checkout: `/worktrees/${name}`,
              manifests: { "sheet-web": "manifest" },
              requestedRevision: "rev",
            });
            yield* controller.activate(created.session.id, 1, created.supervisorIdentity, "rev");
            return created;
          }),
        );
        yield* sql`CREATE TABLE preview_auth_sessions (session_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL, endpoint TEXT NOT NULL, user_id TEXT NOT NULL, scopes TEXT NOT NULL, issuer TEXT NOT NULL, audience TEXT NOT NULL, actor_provenance TEXT NOT NULL, token_key TEXT NOT NULL, credential_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(session_id,generation,role,user_id))`;
        const tokenStore = new Map<string, { accessToken: string; expiresAt: number }>();
        const credentials = new Map<
          string,
          { principal: Principal; binding: PreviewAuthBinding; expiresAt: number }
        >();
        let failMint = false;
        let failTokenCleanup = false;
        let failClientCleanup = false;
        let stopOnExpiredTokenRead = false;
        let refreshReadBarrier: Deferred.Deferred<void> | undefined;
        let refreshReadArrivals = 0;
        let stopSessionDuringMint:
          | { readonly id: string; readonly ownerIdentity: string }
          | undefined;
        let refreshCalls = 0;
        let protectedResponseBody: string | undefined;
        const requests: Array<{
          endpoint: string;
          accessToken: string;
          headers: Readonly<Record<string, string>>;
        }> = [];
        let provisionCalls = 0;
        let returnForeignOwner = false;
        let delayProvision = false;
        let provisionDelayStarted: Deferred.Deferred<void> | undefined;
        let failClientRegistrationCleanup = false;
        const removedClientIds: string[] = [];
        const registeredClientsByOwner = new Map<
          string,
          Array<{ readonly clientId: string; readonly ownerKey: string }>
        >();
        type Principal = {
          userId: string;
          accountId: string;
          scopes: readonly string[];
          issuer: string;
          audience: string;
          actorProvenance: string;
        };
        const principal: Principal = {
          userId: "user-1",
          accountId: "discord-1",
          scopes: ["sheet.read"],
          issuer: "https://auth.dev.test",
          audience: "sheet-zero",
          actorProvenance: "oauth-client:web-preview",
        };
        function makeClient(input: {
          binding: PreviewAuthBinding;
          callbackUrl: string;
          returnUrl: string;
        }) {
          return {
            clientId: `${input.binding.sessionId}-${input.binding.generation}`,
            callbackUrl: input.callbackUrl,
            issuer: "https://auth.dev.test",
            audience: "sheet-zero",
            returnUrl: input.returnUrl,
            ownerKey: `${input.binding.sessionId}:${input.binding.generation}:${input.binding.role}`,
          };
        }
        const adapters: PreviewAuthAdapters = {
          checkSetup: Effect.void,
          provisionClient: (input) =>
            Effect.gen(function* () {
              provisionCalls += 1;
              const baseClient = makeClient(input);
              const ownerClient = returnForeignOwner
                ? { ...baseClient, ownerKey: "another-owner" }
                : baseClient;
              const client = ownerClient;
              const registrations = registeredClientsByOwner.get(client.ownerKey) ?? [];
              registrations.push(client);
              registeredClientsByOwner.set(client.ownerKey, registrations);
              if (delayProvision) {
                if (provisionDelayStarted)
                  yield* Deferred.succeed(provisionDelayStarted, undefined);
                yield* Effect.sleep("10 seconds");
              }
              return client;
            }),
          removeClientRegistration: (binding, ownerKey) =>
            ownerKey === `${binding.sessionId}:${binding.generation}:${binding.role}`
              ? failClientRegistrationCleanup
                ? Effect.fail(new PreviewAuthError({ reason: "unavailable" }))
                : Effect.sync(() => {
                    for (const client of registeredClientsByOwner.get(ownerKey) ?? [])
                      removedClientIds.push(client.clientId);
                    registeredClientsByOwner.delete(ownerKey);
                  })
              : Effect.fail(new PreviewAuthError({ reason: "denied" })),
          removeClient: (client) =>
            failClientCleanup
              ? Effect.fail(new PreviewAuthError({ reason: "unavailable" }))
              : Effect.sync(() => {
                  removedClientIds.push(client.clientId);
                  const registrations = registeredClientsByOwner.get(client.ownerKey) ?? [];
                  const remaining = registrations.filter(
                    (entry) => entry.clientId !== client.clientId,
                  );
                  if (remaining.length === 0) registeredClientsByOwner.delete(client.ownerKey);
                  else registeredClientsByOwner.set(client.ownerKey, remaining);
                }),
          authorizationUrl: ({ client, state, codeChallengeMethod }) =>
            Effect.succeed(
              `https://auth.dev.test/authorize?client_id=${client.clientId}&state=${state}&method=${codeChallengeMethod}`,
            ),
          exchangeCallback: ({ client, code, verifier }) =>
            code === "empty-token-code" && verifier.length > 20
              ? Effect.succeed({
                  principal,
                  upstreamAccessToken: "",
                  expiresAt: now + 60_000,
                })
              : code === "valid-code" && verifier.length > 20
                ? Effect.succeed({
                    principal,
                    upstreamAccessToken: `upstream-${client.clientId}`,
                    expiresAt: now + 60_000,
                  })
                : Effect.fail(new PreviewAuthError({ reason: "denied" })),
          storeUpstreamTokens: (input) =>
            Effect.sync(() => {
              tokenStore.set(input.key, {
                accessToken: input.accessToken,
                expiresAt: input.expiresAt,
              });
            }),
          readUpstreamToken: (key) => {
            const token = tokenStore.get(key);
            if (!token) return Effect.fail(new PreviewAuthError({ reason: "unavailable" }));
            return Effect.gen(function* () {
              if (
                stopOnExpiredTokenRead &&
                token.expiresAt <= now &&
                key.startsWith(`${sessions[0]!.session.id}:`)
              ) {
                yield* controller
                  .stop(sessions[0]!.session.id, sessions[0]!.ownerIdentity)
                  .pipe(Effect.mapError(() => new PreviewAuthError({ reason: "unavailable" })));
              }
              if (refreshReadBarrier && token.expiresAt <= now) {
                refreshReadArrivals += 1;
                if (refreshReadArrivals === 2)
                  yield* Deferred.succeed(refreshReadBarrier, undefined);
                yield* Deferred.await(refreshReadBarrier);
              }
              return token;
            });
          },
          refreshUpstreamTokens: (key) =>
            Effect.sync(() => {
              refreshCalls += 1;
              tokenStore.set(key, {
                accessToken: `refreshed-${key}`,
                expiresAt: now + 60_000,
              });
            }),
          removeUpstreamTokens: (key) =>
            failTokenCleanup
              ? Effect.fail(new PreviewAuthError({ reason: "unavailable" }))
              : Effect.sync(() => {
                  tokenStore.delete(key);
                }),
          mintPreviewCredential: (input) =>
            Effect.gen(function* () {
              if (failMint)
                return yield* Effect.fail(new PreviewAuthError({ reason: "invalid-request" }));
              if (stopSessionDuringMint?.id === input.binding.sessionId) {
                const session = stopSessionDuringMint;
                stopSessionDuringMint = undefined;
                yield* controller
                  .stop(session.id, session.ownerIdentity)
                  .pipe(Effect.mapError(() => new PreviewAuthError({ reason: "unavailable" })));
              }
              const value = `preview-${input.binding.sessionId}-${input.binding.generation}`;
              credentials.set(value, input);
              return value;
            }),
          verifyPreviewCredential: (value) =>
            credentials.has(value)
              ? Effect.succeed({
                  ...credentials.get(value)!,
                  binding: {
                    endpoint: credentials.get(value)!.binding.endpoint,
                    role: credentials.get(value)!.binding.role,
                    generation: credentials.get(value)!.binding.generation,
                    sessionId: credentials.get(value)!.binding.sessionId,
                  },
                })
              : Effect.fail(new PreviewAuthError({ reason: "denied" })),
          protectedRequest: (input) =>
            Effect.sync(() => {
              requests.push(input);
              return {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "set-cookie": "shared=overwritten; Domain=dev.test",
                },
                body:
                  protectedResponseBody ??
                  JSON.stringify({
                    userId: principal.userId,
                    scopes: principal.scopes,
                    access_token: input.accessToken,
                  }),
              };
            }),
        };
        // Exact per-session client rows model the operator-approved registration boundary.
        const approvedReturnOrigins = new Set(
          sessions.map((session) => `https://p-${session.session.id}-sheet-web.dev.test`),
        );
        const auth = yield* makePreviewAuth({
          domain: "dev.test",
          callbackPath: "/_preview/auth/callback",
          allowedReturnOrigins: approvedReturnOrigins,
          controller,
          adapters,
          now: () => now,
        });
        const authSessionColumns = yield* sql`PRAGMA table_info(preview_auth_sessions)`;
        expect(authSessionColumns.some((column) => String(column.name) === "account_id")).toBe(
          true,
        );
        const bindings: PreviewAuthBinding[] = yield* Effect.forEach(sessions, (session, index) =>
          Effect.gen(function* () {
            const binding: PreviewAuthBinding = {
              sessionId: session.session.id,
              generation: 1,
              role: "sheet-web",
              endpoint: `https://p-${session.session.id}-sheet-web.dev.test`,
            };
            const provisionInput = {
              binding,
              returnUrl: `${binding.endpoint}/_preview/app/`,
              ownerKey: `${binding.sessionId}:1:sheet-web`,
            };
            if (index === 0) {
              returnForeignOwner = true;
              const foreignClient = yield* Effect.result(auth.provision(provisionInput));
              expect(Result.isFailure(foreignClient)).toBe(true);
              expect(removedClientIds).toEqual([]);
              returnForeignOwner = false;
            }
            yield* auth.provision(provisionInput);
            if (index === 0) {
              const initialProvisionCalls = provisionCalls;
              const retried = yield* auth.provision(provisionInput);
              expect(retried.clientId).toBe(`${binding.sessionId}-1`);
              expect(provisionCalls).toBe(initialProvisionCalls);
            }
            return binding;
          }),
        );
        const concurrentSession = yield* controller.create({
          owner: "concurrent-provision",
          checkout: "/worktrees/concurrent-provision",
          manifests: { "sheet-web": "manifest" },
          requestedRevision: "rev",
        });
        yield* controller.activate(
          concurrentSession.session.id,
          1,
          concurrentSession.supervisorIdentity,
          "rev",
        );
        const concurrentBinding: PreviewAuthBinding = {
          sessionId: concurrentSession.session.id,
          generation: 1,
          role: "sheet-web",
          endpoint: `https://p-${concurrentSession.session.id}-sheet-web.dev.test`,
        };
        approvedReturnOrigins.add(concurrentBinding.endpoint);
        const provisionCallsBeforeRace = provisionCalls;
        const concurrentProvisions = yield* Effect.all(
          [
            Effect.result(
              auth.provision({
                binding: concurrentBinding,
                returnUrl: `${concurrentBinding.endpoint}/_preview/app/`,
                ownerKey: `${concurrentBinding.sessionId}:1:sheet-web`,
              }),
            ),
            Effect.result(
              auth.provision({
                binding: concurrentBinding,
                returnUrl: `${concurrentBinding.endpoint}/_preview/alternate/`,
                ownerKey: `${concurrentBinding.sessionId}:1:sheet-web`,
              }),
            ),
          ],
          { concurrency: 2 },
        );
        expect(concurrentProvisions.filter(Result.isSuccess)).toHaveLength(1);
        expect(concurrentProvisions.filter(Result.isFailure)).toHaveLength(1);
        expect(removedClientIds).toHaveLength(0);
        expect(provisionCalls).toBe(provisionCallsBeforeRace + 1);
        const registeredConcurrentClient =
          yield* sql`SELECT client FROM preview_auth_clients WHERE session_id=${concurrentBinding.sessionId} AND generation=${concurrentBinding.generation} AND role=${concurrentBinding.role}`;
        const winningClient = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ clientId: Schema.String }),
        )(JSON.parse(String(registeredConcurrentClient[0]!.client)));
        expect(removedClientIds).not.toContain(winningClient.clientId);
        const callbackRaceFlow = yield* auth.start({
          binding: concurrentBinding,
          origin: concurrentBinding.endpoint,
          returnUrl: `${concurrentBinding.endpoint}/_preview/app/`,
        });
        stopSessionDuringMint = {
          id: concurrentSession.session.id,
          ownerIdentity: concurrentSession.ownerIdentity,
        };
        const callbackAfterStop = yield* Effect.result(
          auth.callback({
            binding: concurrentBinding,
            stateCookie: callbackRaceFlow.stateCookie,
            state: new URL(callbackRaceFlow.authorizationUrl).searchParams.get("state")!,
            code: "valid-code",
            origin: concurrentBinding.endpoint,
          }),
        );
        expect(Result.isFailure(callbackAfterStop)).toBe(true);
        const callbacksAfterStop =
          yield* sql`SELECT user_id FROM preview_auth_sessions WHERE session_id=${concurrentBinding.sessionId}`;
        expect(callbacksAfterStop).toHaveLength(0);
        expect(
          [...tokenStore.keys()].some((key) => key.startsWith(`${concurrentBinding.sessionId}:`)),
        ).toBe(false);
        const starts = yield* Effect.forEach(bindings, (binding) =>
          auth.start({
            binding,
            origin: binding.endpoint,
            returnUrl: `${binding.endpoint}/_preview/app/`,
          }),
        );
        const prefixSiblingOrigin = `${bindings[0]!.endpoint}.attacker.test`;
        approvedReturnOrigins.add(prefixSiblingOrigin);
        const siblingReturn = yield* Effect.result(
          auth.provision({
            binding: bindings[0]!,
            returnUrl: `${prefixSiblingOrigin}/_preview/app/`,
            ownerKey: `${bindings[0]!.sessionId}:1:sheet-web`,
          }),
        );
        expect(Result.isFailure(siblingReturn)).toBe(true);
        if (Result.isFailure(siblingReturn))
          expect(siblingReturn.failure).toMatchObject({ reason: "denied" });
        const signedIn = yield* Effect.forEach(bindings, (binding, index) =>
          auth.callback({
            binding,
            stateCookie: starts[index]!.stateCookie,
            state: new URL(starts[index]!.authorizationUrl).searchParams.get("state")!,
            code: "valid-code",
            origin: binding.endpoint,
          }),
        );
        expect(signedIn.map((result) => result.principal)).toEqual([principal, principal]);
        for (let index = 0; index < bindings.length; index += 1) {
          const response = yield* auth.request({
            binding: bindings[index]!,
            credential: signedIn[index]!.credential,
            origin: bindings[index]!.endpoint,
            method: "GET",
            path: "/zero/query",
            headers: {
              accept: "application/json",
              cookie: "shared-login=secret",
              authorization: "Bearer forged",
              "x-forwarded-host": "shared.dev.test",
            },
          });
          expect(response.status).toBe(200);
          expect(response.headers["set-cookie"]).toBeUndefined();
          expect(response.body).not.toContain("upstream-");
          expect(response.body).not.toContain("access_token");
          expect(requests[index]).toMatchObject({
            endpoint: bindings[index]!.endpoint,
            accessToken: `upstream-${sessions[index]!.session.id}-1`,
            headers: { accept: "application/json" },
          });
        }
        const unchangedResponseBody =
          '{\n  "large": 9007199254740993,\n  "text": "keep spacing"\n}';
        protectedResponseBody = unchangedResponseBody;
        const unchangedResponse = yield* auth.request({
          binding: bindings[1]!,
          credential: signedIn[1]!.credential,
          origin: bindings[1]!.endpoint,
          method: "GET",
          path: "/zero/query",
          headers: {},
        });
        expect(unchangedResponse.body).toBe(unchangedResponseBody);
        const nonJsonResponseBody = "The access token was not present in this response.";
        protectedResponseBody = nonJsonResponseBody;
        const nonJsonResponse = yield* auth.request({
          binding: bindings[1]!,
          credential: signedIn[1]!.credential,
          origin: bindings[1]!.endpoint,
          method: "GET",
          path: "/zero/query",
          headers: {},
        });
        expect(nonJsonResponse.body).toBe(nonJsonResponseBody);
        const echoedToken = requests[1]!.accessToken;
        protectedResponseBody = `{"large":9007199254740993,"access_token":"${echoedToken}","access_token":"benign","echo":"${echoedToken}"}`;
        const redactedResponse = yield* auth.request({
          binding: bindings[1]!,
          credential: signedIn[1]!.credential,
          origin: bindings[1]!.endpoint,
          method: "GET",
          path: "/zero/query",
          headers: {},
        });
        expect(redactedResponse.body).not.toContain(echoedToken);
        expect(redactedResponse.body).not.toContain("access_token");
        expect(redactedResponse.body).not.toContain("benign");
        expect(redactedResponse.body).toContain("9007199254740993");
        protectedResponseBody = `{"${echoedToken}":"secret-key-value","safe":true}`;
        const redactedKeyResponse = yield* auth.request({
          binding: bindings[1]!,
          credential: signedIn[1]!.credential,
          origin: bindings[1]!.endpoint,
          method: "GET",
          path: "/zero/query",
          headers: {},
        });
        expect(redactedKeyResponse.body).not.toContain(echoedToken);
        expect(redactedKeyResponse.body).not.toContain("secret-key-value");
        expect(redactedKeyResponse.body).toContain('"safe":true');
        protectedResponseBody = undefined;
        const storedPrincipal =
          yield* sql`SELECT account_id FROM preview_auth_sessions WHERE session_id=${bindings[0]!.sessionId} AND generation=${bindings[0]!.generation} AND role=${bindings[0]!.role} AND user_id=${principal.userId}`;
        expect(storedPrincipal[0]?.account_id).toBe(principal.accountId);
        yield* sql`UPDATE preview_auth_sessions SET account_id='different-account' WHERE session_id=${bindings[0]!.sessionId} AND generation=${bindings[0]!.generation} AND role=${bindings[0]!.role} AND user_id=${principal.userId}`;
        const mismatchedAccount = yield* Effect.result(
          auth.request({
            binding: bindings[0]!,
            credential: signedIn[0]!.credential,
            origin: bindings[0]!.endpoint,
            method: "GET",
            path: "/zero/query",
            headers: {},
          }),
        );
        expect(Result.isFailure(mismatchedAccount)).toBe(true);
        if (Result.isFailure(mismatchedAccount))
          expect(mismatchedAccount.failure).toMatchObject({ reason: "denied" });
        yield* sql`UPDATE preview_auth_sessions SET account_id=${principal.accountId} WHERE session_id=${bindings[0]!.sessionId} AND generation=${bindings[0]!.generation} AND role=${bindings[0]!.role} AND user_id=${principal.userId}`;
        const tokenCountBeforeEmptyCallback = tokenStore.size;
        const emptyTokenFlow = yield* auth.start({
          binding: bindings[0]!,
          origin: bindings[0]!.endpoint,
          returnUrl: `${bindings[0]!.endpoint}/_preview/app/`,
        });
        const emptyTokenCallback = yield* Effect.result(
          auth.callback({
            binding: bindings[0]!,
            stateCookie: emptyTokenFlow.stateCookie,
            state: new URL(emptyTokenFlow.authorizationUrl).searchParams.get("state")!,
            code: "empty-token-code",
            origin: bindings[0]!.endpoint,
          }),
        );
        expect(Result.isFailure(emptyTokenCallback)).toBe(true);
        expect(tokenStore.size).toBe(tokenCountBeforeEmptyCallback);
        const boundedFlows = yield* Effect.forEach(Array.from({ length: 5 }), () =>
          auth.start({
            binding: bindings[0]!,
            origin: bindings[0]!.endpoint,
            returnUrl: `${bindings[0]!.endpoint}/_preview/app/`,
          }),
        );
        const boundedPending =
          yield* sql`SELECT state_hash FROM preview_auth_pending WHERE session_id=${bindings[0]!.sessionId} AND generation=${bindings[0]!.generation} AND role=${bindings[0]!.role}`;
        expect(boundedPending).toHaveLength(5);
        const rejectedOverflow = yield* Effect.result(
          auth.start({
            binding: bindings[0]!,
            origin: bindings[0]!.endpoint,
            returnUrl: `${bindings[0]!.endpoint}/_preview/app/`,
          }),
        );
        expect(rejectedOverflow).toMatchObject({
          _tag: "Failure",
          failure: { reason: "unavailable" },
        });
        const retainedFirstFlowCallback = yield* auth.callback({
          binding: bindings[0]!,
          stateCookie: boundedFlows[0]!.stateCookie,
          state: new URL(boundedFlows[0]!.authorizationUrl).searchParams.get("state")!,
          code: "valid-code",
          origin: bindings[0]!.endpoint,
        });
        expect(retainedFirstFlowCallback.principal.userId).toBe(principal.userId);
        const priorTokens =
          yield* sql`SELECT token_key FROM preview_auth_sessions WHERE session_id=${bindings[0]!.sessionId} AND generation=${bindings[0]!.generation} AND role=${bindings[0]!.role} AND user_id=${principal.userId}`;
        const priorTokenKey = String(priorTokens[0]!.token_key);
        failMint = true;
        const replacementFlow = yield* auth.start({
          binding: bindings[0]!,
          origin: bindings[0]!.endpoint,
          returnUrl: `${bindings[0]!.endpoint}/_preview/app/`,
        });
        const replacementFailure = yield* Effect.result(
          auth.callback({
            binding: bindings[0]!,
            stateCookie: replacementFlow.stateCookie,
            state: new URL(replacementFlow.authorizationUrl).searchParams.get("state")!,
            code: "valid-code",
            origin: bindings[0]!.endpoint,
          }),
        );
        expect(Result.isFailure(replacementFailure)).toBe(true);
        expect(tokenStore.has(priorTokenKey)).toBe(true);
        expect(
          (yield* auth.request({
            binding: bindings[0]!,
            credential: signedIn[0]!.credential,
            origin: bindings[0]!.endpoint,
            method: "GET",
            path: "/zero/query",
            headers: {},
          })).status,
        ).toBe(200);
        failMint = false;
        const sessionBToken =
          yield* sql`SELECT token_key FROM preview_auth_sessions WHERE session_id=${bindings[1]!.sessionId}`;
        const sessionBTokenKey = String(sessionBToken[0]!.token_key);
        const savedSessionBToken = tokenStore.get(sessionBTokenKey)!;
        tokenStore.set(sessionBTokenKey, { accessToken: "", expiresAt: now + 60_000 });
        const requestCountBeforeEmptyStoredToken = requests.length;
        const emptyStoredTokenRequest = yield* Effect.result(
          auth.request({
            binding: bindings[1]!,
            credential: signedIn[1]!.credential,
            origin: bindings[1]!.endpoint,
            method: "GET",
            path: "/zero/query",
            headers: {},
          }),
        );
        expect(Result.isFailure(emptyStoredTokenRequest)).toBe(true);
        expect(requests).toHaveLength(requestCountBeforeEmptyStoredToken);
        tokenStore.set(sessionBTokenKey, savedSessionBToken);
        tokenStore.set(sessionBTokenKey, {
          accessToken: "expired-upstream-token",
          expiresAt: now - 1,
        });
        now += 1;
        expect(
          (yield* auth.request({
            binding: bindings[1]!,
            credential: signedIn[1]!.credential,
            origin: bindings[1]!.endpoint,
            method: "GET",
            path: "/zero/query",
            headers: {},
          })).status,
        ).toBe(200);
        expect(requests.at(-1)?.accessToken).toContain("refreshed-");
        tokenStore.set(sessionBTokenKey, {
          accessToken: "expired-concurrent-token",
          expiresAt: now - 1,
        });
        refreshReadBarrier = yield* Deferred.make<void>();
        refreshReadArrivals = 0;
        const refreshCallsBeforeConcurrentRequests = refreshCalls;
        const concurrentRefreshRequests = yield* Effect.all(
          [0, 1].map(() =>
            auth.request({
              binding: bindings[1]!,
              credential: signedIn[1]!.credential,
              origin: bindings[1]!.endpoint,
              method: "GET",
              path: "/zero/query",
              headers: {},
            }),
          ),
          { concurrency: 2 },
        );
        refreshReadBarrier = undefined;
        expect(concurrentRefreshRequests.map((response) => response.status)).toEqual([200, 200]);
        expect(refreshReadArrivals).toBeGreaterThanOrEqual(2);
        expect(refreshCalls).toBe(refreshCallsBeforeConcurrentRequests + 1);
        yield* auth.start({
          binding: bindings[0]!,
          origin: bindings[0]!.endpoint,
          returnUrl: `${bindings[0]!.endpoint}/_preview/app/`,
        });
        yield* sql`UPDATE preview_auth_pending SET expires_at=${now - 1} WHERE session_id=${bindings[0]!.sessionId} AND generation=${bindings[0]!.generation} AND role=${bindings[0]!.role}`;
        yield* auth.start({
          binding: bindings[1]!,
          origin: bindings[1]!.endpoint,
          returnUrl: `${bindings[1]!.endpoint}/_preview/app/`,
        });
        const staleSessionStates =
          yield* sql`SELECT state_hash FROM preview_auth_pending WHERE session_id=${bindings[0]!.sessionId}`;
        expect(staleSessionStates).toHaveLength(0);
        const freshFlow = yield* auth.start({
          binding: bindings[0]!,
          origin: bindings[0]!.endpoint,
          returnUrl: `${bindings[0]!.endpoint}/_preview/app/`,
        });
        const callbackState = new URL(freshFlow.authorizationUrl).searchParams.get("state")!;
        const pendingBeforeMismatch =
          yield* sql`SELECT state_hash FROM preview_auth_pending WHERE session_id=${bindings[0]!.sessionId} AND generation=${bindings[0]!.generation} AND role=${bindings[0]!.role}`;
        expect(pendingBeforeMismatch).toHaveLength(1);
        const mismatch = yield* Effect.result(
          auth.callback({
            binding: bindings[0]!,
            stateCookie: "different",
            state: callbackState,
            code: "valid-code",
            origin: bindings[0]!.endpoint,
          }),
        );
        expect(Result.isFailure(mismatch)).toBe(true);
        if (Result.isFailure(mismatch))
          expect(mismatch.failure).toMatchObject({ reason: "denied" });
        const pendingAfterMismatch =
          yield* sql`SELECT state_hash FROM preview_auth_pending WHERE session_id=${bindings[0]!.sessionId} AND generation=${bindings[0]!.generation} AND role=${bindings[0]!.role}`;
        expect(pendingAfterMismatch).toHaveLength(1);
        failMint = true;
        failTokenCleanup = false;
        const cleanedMintFailure = yield* Effect.result(
          auth.callback({
            binding: bindings[0]!,
            stateCookie: freshFlow.stateCookie,
            state: callbackState,
            code: "valid-code",
            origin: bindings[0]!.endpoint,
          }),
        );
        expect(Result.isFailure(cleanedMintFailure)).toBe(true);
        if (Result.isFailure(cleanedMintFailure))
          expect(cleanedMintFailure.failure).toMatchObject({ reason: "invalid-request" });
        expect(tokenStore.has(priorTokenKey)).toBe(true);
        const failedCleanupFlow = yield* auth.start({
          binding: bindings[0]!,
          origin: bindings[0]!.endpoint,
          returnUrl: `${bindings[0]!.endpoint}/_preview/app/`,
        });
        failTokenCleanup = true;
        const failedMint = yield* Effect.result(
          auth.callback({
            binding: bindings[0]!,
            stateCookie: failedCleanupFlow.stateCookie,
            state: new URL(failedCleanupFlow.authorizationUrl).searchParams.get("state")!,
            code: "valid-code",
            origin: bindings[0]!.endpoint,
          }),
        );
        expect(Result.isFailure(failedMint)).toBe(true);
        if (Result.isFailure(failedMint))
          expect(failedMint.failure).toMatchObject({ reason: "invalid-request" });
        expect(tokenStore.has(priorTokenKey)).toBe(true);
        failTokenCleanup = false;
        failMint = false;
        const crossSessionCredential = yield* Effect.exit(
          auth.request({
            binding: bindings[1]!,
            credential: signedIn[0]!.credential,
            origin: bindings[1]!.endpoint,
            method: "GET",
            path: "/zero/query",
            headers: {},
          }),
        );
        expect(crossSessionCredential._tag).toBe("Failure");
        const directSharedCredential = yield* Effect.exit(
          auth.request({
            binding: bindings[0]!,
            credential: signedIn[0]!.credential,
            origin: "https://shared.dev.test",
            method: "GET",
            path: "/zero/query",
            headers: {},
          }),
        );
        expect(directSharedCredential._tag).toBe("Failure");
        const tokenQueryCredential = yield* Effect.exit(
          auth.request({
            binding: bindings[0]!,
            credential: signedIn[0]!.credential,
            origin: bindings[0]!.endpoint,
            method: "GET",
            path: "/zero/query?access%5Ftoken=secret",
            headers: {},
          }),
        );
        expect(tokenQueryCredential._tag).toBe("Failure");
        const badOrigin = yield* Effect.exit(
          auth.request({
            binding: bindings[0]!,
            credential: signedIn[0]!.credential,
            origin: "http://p.dev.test",
            method: "POST",
            path: "/zero/mutate",
            headers: {},
          }),
        );
        expect(badOrigin._tag).toBe("Failure");
        tokenStore.set(priorTokenKey, {
          accessToken: "expired-before-stop",
          expiresAt: now - 1,
        });
        const refreshCountBeforeStoppedSession = refreshCalls;
        stopOnExpiredTokenRead = true;
        const stoppedBeforeRefresh = yield* Effect.result(
          auth.request({
            binding: bindings[0]!,
            credential: signedIn[0]!.credential,
            origin: bindings[0]!.endpoint,
            method: "GET",
            path: "/zero/query",
            headers: {},
          }),
        );
        stopOnExpiredTokenRead = false;
        expect(Result.isFailure(stoppedBeforeRefresh)).toBe(true);
        expect(refreshCalls).toBe(refreshCountBeforeStoppedSession);
        yield* controller.stop(bindings[0]!.sessionId, sessions[0]!.ownerIdentity);
        const afterStop = yield* Effect.exit(
          auth.request({
            binding: bindings[0]!,
            credential: signedIn[0]!.credential,
            origin: bindings[0]!.endpoint,
            method: "GET",
            path: "/zero/query",
            headers: {},
          }),
        );
        expect(afterStop._tag).toBe("Failure");
        expect(
          (yield* auth.request({
            binding: bindings[1]!,
            credential: signedIn[1]!.credential,
            origin: bindings[1]!.endpoint,
            method: "GET",
            path: "/zero/query",
            headers: {},
          })).status,
        ).toBe(200);
        const unknownCleanup = yield* Effect.result(
          auth.cleanupSession("missing-session", "owner"),
        );
        expect(Result.isFailure(unknownCleanup)).toBe(true);
        const wrongOwnerCleanup = yield* Effect.result(
          auth.cleanupSession(bindings[0]!.sessionId, "wrong-owner"),
        );
        expect(Result.isFailure(wrongOwnerCleanup)).toBe(true);
        const activeCleanup = yield* Effect.result(
          auth.cleanupSession(bindings[1]!.sessionId, sessions[1]!.ownerIdentity),
        );
        expect(Result.isFailure(activeCleanup)).toBe(true);
        failClientCleanup = true;
        const clientCleanupFailure = yield* Effect.result(
          auth.cleanupSession(bindings[0]!.sessionId, sessions[0]!.ownerIdentity),
        );
        expect(Result.isFailure(clientCleanupFailure)).toBe(true);
        expect(
          [...tokenStore.keys()].some((key) => key.startsWith(`${bindings[0]!.sessionId}:`)),
        ).toBe(false);
        expect(
          [...tokenStore.keys()].some((key) => key.startsWith(`${bindings[1]!.sessionId}:`)),
        ).toBe(true);
        const retainedClientsAfterCleanupFailure =
          yield* sql`SELECT client FROM preview_auth_clients WHERE session_id=${bindings[0]!.sessionId}`;
        expect(retainedClientsAfterCleanupFailure.length).toBeGreaterThan(0);
        failClientCleanup = false;
        yield* auth.cleanupSession(bindings[0]!.sessionId, sessions[0]!.ownerIdentity);
        const clientsAfterCleanupRetry =
          yield* sql`SELECT client FROM preview_auth_clients WHERE session_id=${bindings[0]!.sessionId}`;
        expect(clientsAfterCleanupRetry).toHaveLength(0);
        yield* sql`UPDATE preview_sessions SET phase='active',lease_deadline=${now - 1},ended_at=NULL WHERE id=${concurrentSession.session.id}`;
        yield* auth.cleanupSession(concurrentSession.session.id, concurrentSession.ownerIdentity);
        expect(removedClientIds).toContain(winningClient.clientId);
        const timedOutSession = yield* controller.create({
          owner: "timed-out-provision",
          checkout: "/worktrees/timed-out-provision",
          manifests: { "sheet-web": "manifest" },
          requestedRevision: "rev",
        });
        yield* controller.activate(
          timedOutSession.session.id,
          1,
          timedOutSession.supervisorIdentity,
          "rev",
        );
        const timedOutBinding: PreviewAuthBinding = {
          sessionId: timedOutSession.session.id,
          generation: 1,
          role: "sheet-web",
          endpoint: `https://p-${timedOutSession.session.id}-sheet-web.dev.test`,
        };
        approvedReturnOrigins.add(timedOutBinding.endpoint);
        const timedOutOwnerKey = `${timedOutBinding.sessionId}:1:sheet-web`;
        delayProvision = true;
        failClientRegistrationCleanup = true;
        provisionDelayStarted = yield* Deferred.make<void>();
        const timedOutProvision = yield* Effect.result(
          auth.provision({
            binding: timedOutBinding,
            returnUrl: `${timedOutBinding.endpoint}/_preview/app/`,
            ownerKey: timedOutOwnerKey,
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(provisionDelayStarted);
        yield* TestClock.adjust(Duration.seconds(5));
        const timedOutResult = yield* Fiber.join(timedOutProvision);
        expect(Result.isFailure(timedOutResult)).toBe(true);
        expect(registeredClientsByOwner.has(timedOutOwnerKey)).toBe(true);
        const pendingClientOwners =
          yield* sql`SELECT owner_key FROM preview_auth_client_owners WHERE session_id=${timedOutBinding.sessionId}`;
        expect(pendingClientOwners.map((row) => row.owner_key)).toEqual([timedOutOwnerKey]);
        delayProvision = false;
        failClientRegistrationCleanup = false;
        yield* controller.stop(timedOutSession.session.id, timedOutSession.ownerIdentity);
        yield* auth.cleanupSession(timedOutSession.session.id, timedOutSession.ownerIdentity);
        expect(registeredClientsByOwner.has(timedOutOwnerKey)).toBe(false);
        now += 1;
      }),
    ),
);
