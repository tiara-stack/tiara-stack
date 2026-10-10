import { createHash } from "node:crypto";
import { it, expect } from "@effect/vitest";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Deferred, Effect, Fiber, Layer, Queue, Schema } from "effect";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import { makePreviewSessionController, previewSessionLeaseMs } from "./preview-sessions";
import { relayNameFor } from "./preview-relay-provider";
import {
  makePreviewGateway,
  PreviewGatewayError,
  PreviewGatewayTargetSchema,
  type PreviewGatewayAdapters,
  type PreviewGatewayDependencyIdentity,
  type PreviewGatewayDependencyTarget,
  type PreviewGatewayTarget,
  type PreviewGatewayPrincipal,
} from "./preview-gateway";
import { dispatchPreviewGatewayProtocol, PreviewGatewayHttpRoutes } from "./preview-gateway-http";

const bad = () => new PreviewGatewayError({ reason: "unavailable" });
const streamText = (body: Stream.Stream<Uint8Array, PreviewGatewayError>) =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    yield* body.pipe(Stream.runForEach((chunk) => Effect.sync(() => chunks.push(chunk))));
    const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  });
const fixture = Effect.gen(function* () {
  const clock = yield* TestClock.testClockWith((value) => Effect.succeed(value));
  const now = () => clock.currentTimeMillisUnsafe();
  const sql = yield* SqlClient.SqlClient;
  const controller = yield* makePreviewSessionController(now);
  // Recorded provider receipts stand in for TIA-236's allocator, not live Kubernetes evidence.
  yield* sql`CREATE TABLE preview_allocation_ledger (session_id TEXT, resource TEXT, owner_token TEXT, provider_resource_id TEXT, state TEXT)`;
  const makeSession = (
    owner: string,
    kind: PreviewGatewayTarget["kind"] = "disposable-probe",
    role: PreviewGatewayTarget["role"] = "sheet-web",
  ) =>
    Effect.gen(function* () {
      const created = yield* controller.create({
        owner,
        checkout: `/test/${owner}`,
        requestedRevision: "rev-a",
        manifests: { [role]: "manifest" },
        groups: ["application-zero", "workflow-execution", "auth", "search"],
        endpoints: [
          "https://zero.dev.theerapakg.moe",
          "https://workflows.dev.theerapakg.moe",
          "https://auth.dev.theerapakg.moe",
          "https://search.dev.theerapakg.moe",
        ],
      });
      const target: PreviewGatewayTarget = {
        sessionId: created.session.id,
        generation: 1,
        role,
        processId: `probe-${owner}`,
        revision: "rev-a",
        artifactDigest: `sha256:${"a".repeat(64)}`,
        catalogDigest: `sha256:${"b".repeat(64)}`,
        stateGroup: "application-zero",
        kind,
        serviceFqdn: `${relayNameFor(created.session.id, role)}.preview-relays.svc.cluster.local`,
        port: 3000,
        serviceResourceId: `service-${owner}`,
        attachmentResourceId: `attachment-${owner}`,
      };
      for (const kind of ["service", "attachment"] as const) {
        const token = `${owner}-${kind}-allocation-owner`;
        const reference = JSON.stringify({
          version: 1,
          kind,
          sessionId: target.sessionId,
          role: target.role,
          processId: target.processId,
          ownerTokenDigest: createHash("sha256").update(token).digest("hex").slice(0, 63),
          providerResourceId:
            kind === "service" ? target.serviceResourceId : target.attachmentResourceId,
        });
        yield* sql`INSERT INTO preview_allocation_ledger VALUES (${target.sessionId}, ${`preview-relay-${kind}-${role}`}, ${token}, ${reference}, 'owned')`;
      }
      yield* controller.activate(created.session.id, 1, created.supervisorIdentity, "rev-a");
      return { ...created, target };
    });
  const a = yield* makeSession("alice");
  const b = yield* makeSession("bob");
  const c = yield* makeSession("carol", "application");
  const d = yield* makeSession("dave", "application");
  const tokens = new Map<string, PreviewGatewayPrincipal>();
  const token = (value: string, target: PreviewGatewayTarget, userId: string) => {
    tokens.set(value, {
      userId,
      sessionId: target.sessionId,
      generation: target.generation,
      role: target.role,
      expiresAt: now() + 3 * previewSessionLeaseMs,
      effectivePrincipal: {
        subject: userId,
        issuer: "https://auth.dev.example.test",
        audiences: [target.role],
        scopes: ["application:read", "application:write"],
      },
    });
    return { authorization: `Bearer ${value}` };
  };
  const alice = token("alice-a", a.target, "alice");
  const bob = token("bob-b", b.target, "bob");
  const carol = token("carol-c", c.target, "carol");
  const dave = token("dave-d", d.target, "dave");
  const guestA = token("guest-a", a.target, "guest");
  const guestB = token("guest-b", b.target, "guest");
  yield* sql`CREATE TABLE shared_control (revision TEXT, login TEXT, writes INTEGER)`;
  yield* sql`INSERT INTO shared_control VALUES ('shared-original', 'shared-login', 7)`;
  const control = sql`SELECT revision, login, writes FROM shared_control`.pipe(
    Effect.map((rows) => rows[0]),
  );
  const observations: { sessionId: string; headers: Readonly<Record<string, string>> }[] = [];
  const applicationObservations: {
    sessionId: string;
    method: string;
    path: string;
    headers: Readonly<Record<string, string>>;
    principal?: PreviewGatewayPrincipal;
    body?: Uint8Array;
    maxResponseBytes?: number;
  }[] = [];
  const applicationSocketObservations: {
    readonly sessionId: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
  }[] = [];
  const dependencyTargetChecks: PreviewGatewayDependencyIdentity[] = [];
  const dependencySocketObservations: {
    readonly target: PreviewGatewayDependencyTarget;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly principal: PreviewGatewayPrincipal;
  }[] = [];
  const dependencyObservations: {
    readonly target: PreviewGatewayDependencyTarget;
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly principal: PreviewGatewayPrincipal;
  }[] = [];
  let applicationResponseBody: (
    sessionId: string,
    path: string,
  ) => Stream.Stream<Uint8Array, PreviewGatewayError> = (_sessionId, path) =>
    Stream.make(new TextEncoder().encode(`app:${_sessionId}:${path}`));
  let applicationResponseHeaders: Readonly<Record<string, string>> = {
    "content-type": "application/octet-stream",
    "set-cookie": "bad=1",
  };
  const closed: string[] = [];
  const disconnected = new Set<string>();
  const upstreamSockets = new Map<string, Socket.Socket>();
  let identityOverride: PreviewGatewayTarget | undefined;
  const adapters: PreviewGatewayAdapters = {
    checkSetup: Effect.sync(() => ({
      domain: "dev.example.test",
      observedAt: now(),
      wildcardDns: true,
      wildcardCertificate: true,
      independentGatewayAuthentication: true,
      applicationIdentityMediation: true,
      browserDependencyMediation: true,
      singleControllerFenceDelivery: true,
    })),
    authenticate: ({ headers }) =>
      Effect.suspend(() => {
        const proof = tokens.get(headers.authorization?.replace(/^Bearer /, "") ?? "");
        return proof === undefined
          ? Effect.fail(new PreviewGatewayError({ reason: "denied" }))
          : Effect.succeed(proof);
      }),
    connect: (target) =>
      Effect.gen(function* () {
        const connection = {
          identity: identityOverride ?? target,
          connected: Effect.sync(() => !disconnected.has(target.sessionId)),
          http: (headers: Readonly<Record<string, string>>) =>
            Effect.sync(() => {
              observations.push({ sessionId: target.sessionId, headers });
              return `probe:${target.sessionId}`;
            }),
          applicationRequest: (input: {
            readonly method: string;
            readonly path: string;
            readonly headers: Readonly<Record<string, string>>;
            readonly principal?: PreviewGatewayPrincipal;
            readonly body?: Stream.Stream<Uint8Array, PreviewGatewayError>;
            readonly maxResponseBytes: number;
          }) =>
            Effect.gen(function* () {
              const chunks: Uint8Array[] = [];
              if (input.body !== undefined)
                yield* input.body.pipe(
                  Stream.runForEach((chunk) => Effect.sync(() => chunks.push(chunk))),
                );
              const bodyLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
              const body = new Uint8Array(bodyLength);
              let offset = 0;
              for (const chunk of chunks) {
                body.set(chunk, offset);
                offset += chunk.byteLength;
              }
              applicationObservations.push({
                sessionId: target.sessionId,
                method: input.method,
                path: input.path,
                headers: input.headers,
                ...(input.principal === undefined ? {} : { principal: input.principal }),
                ...(input.body === undefined ? {} : { body }),
                maxResponseBytes: input.maxResponseBytes,
              });
              return {
                status: input.path === "/ready" ? 200 : 201,
                headers: applicationResponseHeaders,
                body: applicationResponseBody(target.sessionId, input.path),
              };
            }),
          applicationSocket: (input: {
            readonly path: string;
            readonly headers: Readonly<Record<string, string>>;
            readonly principal: PreviewGatewayPrincipal;
          }) => {
            applicationSocketObservations.push({ sessionId: target.sessionId, ...input });
            const socket = upstreamSockets.get(target.sessionId);
            return socket === undefined ? Effect.fail(bad()) : Effect.succeed(socket);
          },
          socket: Effect.suspend(() => {
            const socket = upstreamSockets.get(target.sessionId);
            return socket === undefined ? Effect.fail(bad()) : Effect.succeed(socket);
          }),
          close: Effect.sync(() => {
            closed.push(target.sessionId);
          }),
        };
        return yield* Effect.acquireRelease(Effect.succeed(connection), (value) => value.close);
      }),
    applicationDependency: {
      checkTarget: (target) => Effect.sync(() => dependencyTargetChecks.push(target)),
      request: (target, input) =>
        Effect.gen(function* () {
          if (input.body !== undefined) yield* input.body.pipe(Stream.runDrain);
          dependencyObservations.push({
            target,
            method: input.method,
            path: input.path,
            headers: input.headers,
            principal: input.principal,
          });
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: Stream.make(
              new TextEncoder().encode(
                `dependency:${target.group}:${target.sessionId}:${input.path}`,
              ),
            ),
          };
        }),
      socket: ({ target, path, headers, principal }) => {
        dependencySocketObservations.push({ target, path, headers, principal });
        const socket = upstreamSockets.get(target.sessionId);
        return socket === undefined ? Effect.fail(bad()) : Effect.succeed(socket);
      },
    },
  };
  const gateway = yield* makePreviewGateway({
    domain: "dev.example.test",
    controller,
    adapters,
    now,
  });
  const routeA = yield* gateway.register(a.target, a.ownerIdentity);
  const routeB = yield* gateway.register(b.target, b.ownerIdentity);
  const routeC = yield* gateway.register(c.target, c.ownerIdentity);
  const routeD = yield* gateway.register(d.target, d.ownerIdentity);
  return {
    a,
    b,
    c,
    d,
    createSession: makeSession,
    gateway,
    controller,
    adapters,
    now,
    sql,
    routeA,
    routeB,
    routeC,
    routeD,
    alice,
    bob,
    carol,
    dave,
    guestA,
    guestB,
    token,
    control,
    observations,
    applicationObservations,
    applicationSocketObservations,
    dependencyObservations,
    dependencySocketObservations,
    dependencyTargetChecks,
    setApplicationResponseBody: (body: Stream.Stream<Uint8Array, PreviewGatewayError>) => {
      applicationResponseBody = () => body;
    },
    setApplicationResponseHeaders: (headers: Readonly<Record<string, string>>) => {
      applicationResponseHeaders = headers;
    },
    closed,
    disconnected,
    upstreamSockets,
    override: (target: PreviewGatewayTarget | undefined) => {
      identityOverride = target;
    },
  };
});
const withFixture = <A, E, R>(
  program: (f: Effect.Success<typeof fixture>) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(Effect.flatMap(fixture, program)).pipe(
    Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
  );
const denied = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    expect((yield* Effect.exit(program))._tag).toBe("Failure");
  });

it.effect(
  "admits owners, explicit route grants, reconnects and strips untrusted metadata across two sessions",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const a = yield* f.gateway.open({
          hostname: f.routeA.hostname,
          headers: {
            ...f.alice,
            cookie: "shared-login=secret",
            "x-preview-session": f.b.target.sessionId,
            "x-forwarded-host": f.routeB.hostname,
            forwarded: "host=shared",
            accept: "text/plain",
          },
        });
        expect(a.readiness).toEqual({
          gateway: "ready",
          relay: "ready",
          application: "unsupported",
        });
        expect(yield* a.guard(a.connection.http(a.headers))).toBe(`probe:${f.a.target.sessionId}`);
        expect(f.observations[0]?.headers).toEqual({ accept: "text/plain" });
        yield* denied(f.gateway.open({ hostname: f.routeA.hostname, headers: f.guestA }));
        yield* denied(f.gateway.grant(f.routeA.hostname, f.b.ownerIdentity, "guest", true));
        yield* dispatchPreviewGatewayProtocol(f.gateway, {
          _tag: "Grant",
          version: 1,
          hostname: f.routeA.hostname,
          ownerIdentity: f.a.ownerIdentity,
          userId: "guest",
          allowed: true,
        });
        const guest = yield* f.gateway.open({ hostname: f.routeA.hostname, headers: f.guestA });
        expect(guest.principal.userId).toBe("guest");
        yield* denied(f.gateway.open({ hostname: f.routeB.hostname, headers: f.guestB }));
        yield* denied(f.gateway.open({ hostname: f.routeB.hostname, headers: f.alice }));
        const reconnect = yield* f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice });
        expect(reconnect.route).toEqual(a.route);
        const b = yield* f.gateway.open({ hostname: f.routeB.hostname, headers: f.bob });
        expect(yield* b.guard(b.connection.http(b.headers))).toBe(`probe:${f.b.target.sessionId}`);
        expect(yield* f.control).toEqual({
          revision: "shared-original",
          login: "shared-login",
          writes: 7,
        });
      }),
    ),
);

it.effect(
  "closes established streams on grant revocation and stop, preserves the other session, and cleans only the owner route",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.gateway.grant(f.routeA.hostname, f.a.ownerIdentity, "guest", true);
        const guest = yield* f.gateway.open({ hostname: f.routeA.hostname, headers: f.guestA });
        const owner = yield* f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice });
        const b = yield* f.gateway.open({ hostname: f.routeB.hostname, headers: f.bob });
        yield* f.gateway.grant(f.routeA.hostname, f.a.ownerIdentity, "guest", false);
        yield* guest.fenced;
        yield* denied(guest.guard(Effect.succeed("late frame")));
        expect(yield* owner.guard(Effect.succeed("owner still open"))).toBe("owner still open");
        yield* denied(f.gateway.cleanupSession(f.a.target.sessionId, f.a.ownerIdentity));
        yield* f.controller.stop(f.a.target.sessionId, f.a.ownerIdentity);
        yield* owner.fenced;
        yield* denied(owner.guard(Effect.succeed("queued submission")));
        yield* denied(f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice }));
        yield* denied(f.gateway.cleanup(f.routeA.hostname, f.b.ownerIdentity));
        yield* f.gateway.cleanupSession(f.a.target.sessionId, f.a.ownerIdentity);
        yield* f.gateway.cleanupSession(f.a.target.sessionId, f.a.ownerIdentity);
        expect(yield* b.guard(b.connection.http(b.headers))).toBe(`probe:${f.b.target.sessionId}`);
        expect(
          (yield* f.sql`SELECT hostname FROM preview_gateway_routes WHERE removed=0`).map(
            (r) => r.hostname,
          ),
        ).toEqual([f.routeB.hostname, f.routeC.hostname, f.routeD.hostname]);
        expect(yield* f.control).toEqual({
          revision: "shared-original",
          login: "shared-login",
          writes: 7,
        });
      }),
    ),
);

it.effect(
  "owners can revoke grants while relay allocations are quarantined or the lease has expired",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.gateway.grant(f.routeA.hostname, f.a.ownerIdentity, "guest", true);
        const quarantinedGuest = yield* f.gateway.open({
          hostname: f.routeA.hostname,
          headers: f.guestA,
        });
        yield* f.sql`UPDATE preview_allocation_ledger SET state='quarantined' WHERE session_id=${f.a.target.sessionId}`;

        yield* f.gateway.grant(f.routeA.hostname, f.a.ownerIdentity, "guest", false);

        expect(
          yield* f.sql`SELECT user_id FROM preview_gateway_grants WHERE hostname=${f.routeA.hostname}`,
        ).toHaveLength(0);
        yield* quarantinedGuest.fenced;
        yield* denied(quarantinedGuest.guard(Effect.succeed("revoked guest")));

        yield* f.sql`UPDATE preview_allocation_ledger SET state='owned' WHERE session_id=${f.a.target.sessionId}`;
        yield* f.gateway.grant(f.routeA.hostname, f.a.ownerIdentity, "guest", true);
        const expiredGuest = yield* f.gateway.open({
          hostname: f.routeA.hostname,
          headers: f.guestA,
        });
        yield* f.sql`UPDATE preview_sessions SET lease_deadline=0 WHERE id=${f.a.target.sessionId}`;

        yield* f.gateway.grant(f.routeA.hostname, f.a.ownerIdentity, "guest", false);

        expect(
          yield* f.sql`SELECT user_id FROM preview_gateway_grants WHERE hostname=${f.routeA.hostname}`,
        ).toHaveLength(0);
        yield* expiredGuest.fenced;
        yield* denied(expiredGuest.guard(Effect.succeed("revoked guest after expiry")));
      }),
    ),
);

it.effect("fences at the last valid lease even during an in-flight operation", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      yield* f.sql`UPDATE preview_sessions SET lease_deadline=1000 WHERE id=${f.a.target.sessionId}`;
      const a = yield* f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice });
      const started = yield* Deferred.make<void>();
      const pending = yield* a
        .guard(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(1000);
      expect((yield* Fiber.await(pending))._tag).toBe("Failure");
      yield* a.fenced;
      yield* denied(f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice }));
    }),
  ),
);

it.effect(
  "rejects unknown, disconnected, mismatched, expired-user and unverifiable targets without fallback",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* denied(f.gateway.open({ hostname: "unknown.dev.example.test", headers: f.alice }));
        f.override(f.b.target);
        yield* denied(f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice }));
        f.override(undefined);
        f.disconnected.add(f.a.target.sessionId);
        yield* denied(f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice }));
        f.disconnected.delete(f.a.target.sessionId);
        const a = yield* f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice });
        f.disconnected.add(f.a.target.sessionId);
        yield* denied(a.guard(a.connection.http(a.headers)));
        yield* a.fenced;
        f.disconnected.delete(f.a.target.sessionId);
        yield* f.sql`UPDATE preview_allocation_ledger SET state='quarantined' WHERE session_id=${f.a.target.sessionId}`;
        yield* denied(f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice }));
        expect(f.observations).toHaveLength(0);
        const unsupported = yield* makePreviewGateway({
          domain: "dev.example.test",
          controller: f.controller,
          now: f.now,
        });
        expect(unsupported.configured).toBe(false);
        yield* denied(unsupported.open({ hostname: f.routeB.hostname, headers: f.bob }));
      }),
    ),
);

it.effect(
  "persists grants across gateway restart and refuses route retargeting or application routes without HTTP and socket adapters",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.gateway.grant(f.routeA.hostname, f.a.ownerIdentity, "guest", true);
        const restarted = yield* makePreviewGateway({
          domain: "dev.example.test",
          controller: f.controller,
          adapters: f.adapters,
          now: f.now,
        });
        const guest = yield* restarted.open({ hostname: f.routeA.hostname, headers: f.guestA });
        expect(guest.route).toEqual(f.routeA);
        yield* denied(restarted.register({ ...f.a.target, port: 4000 }, f.a.ownerIdentity));
        const applicationTarget = { ...f.a.target, kind: "application" as const };
        expect(Schema.is(PreviewGatewayTargetSchema)(applicationTarget)).toBe(true);
        yield* denied(
          dispatchPreviewGatewayProtocol(restarted, {
            _tag: "RegisterProbe",
            version: 1,
            target: applicationTarget,
            ownerIdentity: f.a.ownerIdentity,
          }),
        );
        expect(
          yield* dispatchPreviewGatewayProtocol(restarted, {
            _tag: "RegisterApplication",
            version: 1,
            target: f.c.target,
            ownerIdentity: f.c.ownerIdentity,
          }),
        ).toEqual(f.routeC);
        yield* TestClock.adjust(30_000);
        yield* f.controller.resume(f.a.target.sessionId, f.a.ownerIdentity, f.a.supervisorIdentity);
        yield* guest.fenced;
        yield* denied(guest.guard(Effect.succeed("stale generation")));
      }),
    ),
);

it.effect(
  "HTTP probe routing checks Origin and ignores forged session headers; other paths stay unsupported",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const handler = yield* HttpRouter.toHttpEffect(
          PreviewGatewayHttpRoutes(f.gateway).pipe(Layer.provide(HttpRouter.layer)),
        );
        const request = (hostname: string, path: string, headers: Record<string, string>) =>
          handler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(`https://${hostname}${path}`, {
                  headers: { host: hostname, ...headers },
                }),
              ),
            ),
          );
        const response = yield* request(f.routeA.hostname, "/_preview/probe", {
          ...f.alice,
          cookie: "parent-domain=secret",
          "x-preview-session": f.b.target.sessionId,
        });
        expect(response.status).toBe(200);
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(
          (yield* request(f.routeA.hostname, "/_preview/probe", {
            ...f.alice,
            origin: `https://${f.routeB.hostname}`,
          })).status,
        ).toBe(403);
        expect(
          (yield* request(f.routeA.hostname, "/_preview/probe", {
            ...f.alice,
            upgrade: "websocket",
          })).status,
        ).toBe(403);
        expect(
          (yield* request(f.routeA.hostname, "/_preview/probe?target=shared", f.alice)).status,
        ).toBe(400);
        expect((yield* request(f.routeA.hostname, "/_preview/probe", f.guestA)).status).toBe(503);
        expect((yield* request(f.routeA.hostname, "/application", f.alice)).status).toBe(503);
        expect(f.observations).toHaveLength(1);
        expect(f.observations[0]?.headers).toEqual({});
      }),
    ),
);

it.effect("forwards bounded application HTTP only to the selected session target", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      f.setApplicationResponseHeaders({
        "Content-Type": "application/octet-stream",
        ETag: "revision-a",
        "Set-Cookie": "bad=1",
      });
      const handler = yield* HttpRouter.toHttpEffect(
        PreviewGatewayHttpRoutes(f.gateway).pipe(Layer.provide(HttpRouter.layer)),
      );
      const response = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://${f.routeC.hostname}/_preview/app/settings?tab=one`, {
              method: "POST",
              headers: {
                ...f.carol,
                host: f.routeC.hostname,
                origin: `https://${f.routeC.hostname}`,
                cookie: "shared=must-not-forward",
                "x-forwarded-host": f.routeA.hostname,
                "content-type": "application/json",
                accept: "application/json",
              },
              body: '{"enabled":true}',
            }),
          ),
        ),
      );
      expect(response.status).toBe(201);
      expect(response.headers["content-type"]).toBe("application/octet-stream");
      expect(response.headers.etag).toBe("revision-a");
      expect(f.applicationObservations.map(({ path }) => path)).toContain("/settings?tab=one");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(yield* Effect.promise(() => HttpServerResponse.toWeb(response).text())).toContain(
        `app:${f.c.target.sessionId}:/settings?tab=one`,
      );
      expect(f.applicationObservations.at(-1)).toMatchObject({
        sessionId: f.c.target.sessionId,
        method: "POST",
        path: "/settings?tab=one",
        headers: { "content-type": "application/json", accept: "application/json" },
        principal: expect.objectContaining({
          userId: "carol",
          sessionId: f.c.target.sessionId,
          generation: f.c.target.generation,
          role: f.c.target.role,
          effectivePrincipal: {
            subject: "carol",
            issuer: "https://auth.dev.example.test",
            audiences: ["sheet-web"],
            scopes: ["application:read", "application:write"],
          },
        }),
        body: new TextEncoder().encode('{"enabled":true}'),
        maxResponseBytes: 16 * 1024 * 1024,
      });
      const deniedResponse = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://${f.routeC.hostname}/_preview/app/settings`, {
              headers: {
                ...f.carol,
                host: f.routeC.hostname,
                origin: `https://${f.routeA.hostname}`,
              },
            }),
          ),
        ),
      );
      expect(deniedResponse.status).toBe(403);
      const tooLarge = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://${f.routeC.hostname}/_preview/app/settings`, {
              method: "POST",
              headers: { ...f.carol, host: f.routeC.hostname },
              body: "x".repeat(1024 * 1024 + 1),
            }),
          ),
        ),
      );
      expect(tooLarge.status).toBe(413);
      f.setApplicationResponseHeaders({
        "Content-Length": String(16 * 1024 * 1024 + 1),
      });
      const oversizedResponse = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://${f.routeC.hostname}/_preview/app/settings`, {
              headers: {
                ...f.carol,
                host: f.routeC.hostname,
                origin: `https://${f.routeC.hostname}`,
              },
            }),
          ),
        ),
      );
      expect(oversizedResponse.status).toBe(502);
    }),
  ),
);

it.effect("serves the emitted session hostname root through the selected application target", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const handler = yield* HttpRouter.toHttpEffect(
        PreviewGatewayHttpRoutes(f.gateway).pipe(Layer.provide(HttpRouter.layer)),
      );
      const response = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://${f.routeC.hostname}/`, {
              headers: {
                ...f.carol,
                host: f.routeC.hostname,
                origin: `https://${f.routeC.hostname}`,
              },
            }),
          ),
        ),
      );
      expect(response.status).toBe(201);
      expect(f.applicationObservations.at(-1)).toMatchObject({
        sessionId: f.c.target.sessionId,
        method: "GET",
        path: "/",
        principal: {
          userId: "carol",
          effectivePrincipal: {
            subject: "carol",
            scopes: ["application:read", "application:write"],
          },
        },
      });
      const requestsBeforeSameSite = f.applicationObservations.length;
      const sameSite = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://${f.routeC.hostname}/settings`, {
              headers: { ...f.carol, host: f.routeC.hostname, "sec-fetch-site": "same-site" },
            }),
          ),
        ),
      );
      expect(sameSite.status).toBe(403);
      expect(f.applicationObservations).toHaveLength(requestsBeforeSameSite);
      const crossSiteNavigation = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://${f.routeC.hostname}/`, {
              headers: {
                ...f.carol,
                host: f.routeC.hostname,
                origin: "https://external.example",
                "sec-fetch-site": "cross-site",
                "sec-fetch-mode": "navigate",
                "sec-fetch-dest": "document",
              },
            }),
          ),
        ),
      );
      expect(crossSiteNavigation.status).toBe(201);
      const requestsBeforeCrossSiteDocument = f.applicationObservations.length;
      const crossSiteDocument = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://${f.routeC.hostname}/_preview/app/settings`, {
              headers: {
                ...f.carol,
                host: f.routeC.hostname,
                origin: "https://external.example",
                "sec-fetch-site": "cross-site",
                "sec-fetch-mode": "navigate",
                "sec-fetch-dest": "document",
              },
            }),
          ),
        ),
      );
      expect(crossSiteDocument.status).toBe(403);
      expect(f.applicationObservations).toHaveLength(requestsBeforeCrossSiteDocument);
      const crossSiteMutation = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://${f.routeC.hostname}/settings`, {
              method: "POST",
              headers: {
                ...f.carol,
                host: f.routeC.hostname,
                origin: "https://external.example",
                "sec-fetch-site": "cross-site",
                "sec-fetch-mode": "navigate",
                "sec-fetch-dest": "document",
              },
              body: '{"setting":true}',
            }),
          ),
        ),
      );
      expect(crossSiteMutation.status).toBe(403);
      const sameOrigin = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://${f.routeC.hostname}/settings`, {
              headers: {
                ...f.carol,
                host: f.routeC.hostname,
                origin: `https://${f.routeC.hostname}`,
                "sec-fetch-site": "same-origin",
              },
            }),
          ),
        ),
      );
      expect(sameOrigin.status).toBe(201);
    }),
  ),
);

it.effect(
  "routes shared browser APIs through the registered session dependency and principal",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const dependency: PreviewGatewayDependencyTarget = {
          sessionId: f.c.target.sessionId,
          generation: f.c.target.generation,
          role: "sheet-web",
          revision: f.c.target.revision,
          group: "application-zero",
          endpoint: "https://zero.dev.theerapakg.moe",
          stateIdentity: "zero-state-v1",
          deployedManifestDigest: `sha256:${"a".repeat(64)}`,
          catalogDigest: `sha256:${"b".repeat(64)}`,
          credentialReference: "secret://tiara-stack-dev/sheet-web/application-integration",
        };
        yield* f.gateway.checkApplicationDependencies([
          {
            role: dependency.role,
            group: dependency.group,
            endpoint: dependency.endpoint,
            stateIdentity: dependency.stateIdentity,
            deployedManifestDigest: dependency.deployedManifestDigest,
            catalogDigest: dependency.catalogDigest,
            credentialReference: dependency.credentialReference,
          },
        ]);
        yield* f.gateway.registerApplicationDependencies(
          f.c.target,
          [dependency],
          f.c.ownerIdentity,
        );
        const checksBeforeResumeHealth = f.dependencyTargetChecks.length;
        yield* f.gateway.checkRegisteredApplicationDependencies(
          f.c.target.sessionId,
          "sheet-web",
          f.c.ownerIdentity,
        );
        expect(f.dependencyTargetChecks).toHaveLength(checksBeforeResumeHealth + 1);
        const applicationRequestsBeforeUnknownGroup = f.applicationObservations.length;
        const origin = f.gateway.applicationDependencyOrigin(
          f.c.target.sessionId,
          "sheet-web",
          "application-zero",
        );
        expect(origin).toBe(`https://${f.routeC.hostname}/_preview/dependencies/application-zero/`);
        const handler = yield* HttpRouter.toHttpEffect(
          PreviewGatewayHttpRoutes(f.gateway).pipe(Layer.provide(HttpRouter.layer)),
        );
        const response = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`${origin}sync/v50/connect`, {
                headers: {
                  ...f.carol,
                  host: f.routeC.hostname,
                  origin: `https://${f.routeC.hostname}`,
                  cookie: "shared-token=must-not-forward",
                  accept: "application/json",
                },
              }),
            ),
          ),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => HttpServerResponse.toWeb(response).text())).toBe(
          `dependency:application-zero:${f.c.target.sessionId}:/sync/v50/connect`,
        );
        expect(f.dependencyObservations.at(-1)).toMatchObject({
          target: dependency,
          method: "GET",
          path: "/sync/v50/connect",
          headers: { accept: "application/json" },
          principal: {
            userId: "carol",
            effectivePrincipal: {
              subject: "carol",
              scopes: ["application:read", "application:write"],
            },
          },
        });
        const dependencyRequestsBeforeCrossSiteNavigation = f.dependencyObservations.length;
        const crossSiteDependencyNavigation = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`${origin}sync/v50/connect`, {
                headers: {
                  ...f.carol,
                  host: f.routeC.hostname,
                  origin: "https://external.example",
                  "sec-fetch-site": "cross-site",
                  "sec-fetch-mode": "navigate",
                  "sec-fetch-dest": "document",
                },
              }),
            ),
          ),
        );
        expect(crossSiteDependencyNavigation.status).toBe(403);
        expect(f.dependencyObservations).toHaveLength(dependencyRequestsBeforeCrossSiteNavigation);
        const workflowOrigin = f.gateway.applicationDependencyOrigin(
          f.c.target.sessionId,
          "sheet-web",
          "workflow-execution",
        );
        const unavailable = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`${workflowOrigin}workflows/unknown`, {
                headers: {
                  ...f.carol,
                  host: f.routeC.hostname,
                  origin: `https://${f.routeC.hostname}`,
                },
              }),
            ),
          ),
        );
        expect(unavailable.status).toBe(503);
        const unknownGroup = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`https://${f.routeC.hostname}/_preview/dependencies/unknown/endpoint`, {
                headers: {
                  ...f.carol,
                  host: f.routeC.hostname,
                  origin: `https://${f.routeC.hostname}`,
                },
              }),
            ),
          ),
        );
        expect(unknownGroup.status).toBe(503);
        const encodedUnknownGroup = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`https://${f.routeC.hostname}/_preview/dependencies%2funknown/endpoint`, {
                headers: {
                  ...f.carol,
                  host: f.routeC.hostname,
                  origin: `https://${f.routeC.hostname}`,
                },
              }),
            ),
          ),
        );
        expect(encodedUnknownGroup.status).toBe(503);
        expect(f.applicationObservations).toHaveLength(applicationRequestsBeforeUnknownGroup);
      }),
    ),
);

it.effect("fences Zero dependency WSS through its exact registered group", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const dependency: PreviewGatewayDependencyTarget = {
        sessionId: f.c.target.sessionId,
        generation: f.c.target.generation,
        role: "sheet-web",
        revision: f.c.target.revision,
        group: "application-zero",
        endpoint: "https://zero.dev.theerapakg.moe",
        stateIdentity: "zero-state-v1",
        deployedManifestDigest: `sha256:${"a".repeat(64)}`,
        catalogDigest: `sha256:${"b".repeat(64)}`,
        credentialReference: "secret://tiara-stack-dev/sheet-web/application-integration",
      };
      yield* f.gateway.registerApplicationDependencies(f.c.target, [dependency], f.c.ownerIdentity);
      const upstream = yield* testSocket;
      const browser = yield* testSocket;
      f.upstreamSockets.set(f.c.target.sessionId, upstream.socket);
      const origin = f.gateway.applicationDependencyOrigin(
        f.c.target.sessionId,
        "sheet-web",
        "application-zero",
      );
      if (origin === undefined) return yield* Effect.fail(bad());
      const handler = yield* HttpRouter.toHttpEffect(
        PreviewGatewayHttpRoutes(f.gateway).pipe(Layer.provide(HttpRouter.layer)),
      );
      const upgraded = yield* Deferred.make<void>();
      const request = HttpServerRequest.fromWeb(
        new Request(`${origin}sync/v50/connect`, {
          headers: {
            ...f.carol,
            host: f.routeC.hostname,
            origin: `https://${f.routeC.hostname}`,
            upgrade: "websocket",
          },
        }),
      );
      const wrapped = new Proxy(request, {
        get: (target, key, receiver) =>
          key === "upgrade"
            ? Deferred.succeed(upgraded, undefined).pipe(Effect.as(browser.socket))
            : Reflect.get(target, key, receiver),
      });
      const fiber = yield* handler.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, wrapped),
        Effect.forkChild,
      );
      yield* Deferred.await(upgraded);
      expect(f.dependencySocketObservations.at(-1)).toMatchObject({
        target: dependency,
        path: "/sync/v50/connect",
        principal: {
          userId: "carol",
          effectivePrincipal: { subject: "carol" },
        },
      });
      yield* browser.receive("zero-mutation");
      expect(yield* upstream.sent).toBe("zero-mutation");
      yield* f.controller.stop(f.c.target.sessionId, f.c.ownerIdentity);
      expect(Socket.isCloseEvent(yield* browser.sent)).toBe(true);
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("fences shared Zero WSS frames through the session dependency adapter", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const dependency: PreviewGatewayDependencyTarget = {
        sessionId: f.c.target.sessionId,
        generation: f.c.target.generation,
        role: "sheet-web",
        revision: f.c.target.revision,
        group: "application-zero",
        endpoint: "https://zero.dev.theerapakg.moe",
        stateIdentity: "zero-state-v1",
        deployedManifestDigest: `sha256:${"a".repeat(64)}`,
        catalogDigest: `sha256:${"b".repeat(64)}`,
        credentialReference: "secret://tiara-stack-dev/sheet-web/application-integration",
      };
      yield* f.gateway.registerApplicationDependencies(f.c.target, [dependency], f.c.ownerIdentity);
      const upstream = yield* testSocket;
      const browser = yield* testSocket;
      f.upstreamSockets.set(f.c.target.sessionId, upstream.socket);
      const origin = f.gateway.applicationDependencyOrigin(
        f.c.target.sessionId,
        "sheet-web",
        "application-zero",
      );
      if (origin === undefined) return yield* Effect.fail(bad());
      const handler = yield* HttpRouter.toHttpEffect(
        PreviewGatewayHttpRoutes(f.gateway).pipe(Layer.provide(HttpRouter.layer)),
      );
      const upgraded = yield* Deferred.make<void>();
      const request = HttpServerRequest.fromWeb(
        new Request(`${origin}sync/v50/connect`, {
          headers: {
            ...f.carol,
            host: f.routeC.hostname,
            origin: `https://${f.routeC.hostname}`,
            upgrade: "websocket",
          },
        }),
      );
      const wrapped = new Proxy(request, {
        get: (target, key, receiver) =>
          key === "upgrade"
            ? Deferred.succeed(upgraded, undefined).pipe(Effect.as(browser.socket))
            : Reflect.get(target, key, receiver),
      });
      const fiber = yield* handler.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, wrapped),
        Effect.forkChild,
      );
      yield* Deferred.await(upgraded);
      expect(f.dependencySocketObservations.at(-1)).toMatchObject({
        target: dependency,
        path: "/sync/v50/connect",
        principal: {
          userId: "carol",
          effectivePrincipal: { subject: "carol" },
        },
      });
      yield* browser.receive("zero-update");
      expect(yield* upstream.sent).toBe("zero-update");
      yield* f.controller.stop(f.c.target.sessionId, f.c.ownerIdentity);
      expect(Socket.isCloseEvent(yield* browser.sent)).toBe(true);
      yield* Fiber.join(fiber);
    }),
  ),
);

it.effect("streams application responses with downstream backpressure", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const handler = yield* HttpRouter.toHttpEffect(
        PreviewGatewayHttpRoutes(f.gateway).pipe(Layer.provide(HttpRouter.layer)),
      );
      const release = yield* Deferred.make<void>();
      let secondChunkStarted = false;
      let responseFinished = false;
      f.setApplicationResponseBody(
        Stream.concat(
          Stream.make(new TextEncoder().encode("first-")),
          Stream.fromEffect(
            Effect.sync(() => {
              secondChunkStarted = true;
            }).pipe(
              Effect.andThen(
                Deferred.await(release).pipe(Effect.as(new TextEncoder().encode("second"))),
              ),
            ),
          ),
        ),
      );
      const response = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://${f.routeC.hostname}/_preview/app/stream`, {
              headers: {
                ...f.carol,
                host: f.routeC.hostname,
                origin: `https://${f.routeC.hostname}`,
              },
            }),
          ),
        ),
      );
      const consumer = yield* Effect.tryPromise({
        try: () => HttpServerResponse.toWeb(response).text(),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap(() => Effect.sync(() => (responseFinished = true))),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 10 && !secondChunkStarted; attempt += 1)
        yield* Effect.yieldNow;
      expect(secondChunkStarted).toBe(true);
      expect(responseFinished).toBe(false);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(consumer)).toBe("first-second");
      expect(responseFinished).toBe(true);
    }),
  ),
);

it.effect("keeps two simultaneous application destinations separate from shared control", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const [a, b] = yield* Effect.all(
        [
          f.gateway.open({ hostname: f.routeC.hostname, headers: f.carol }),
          f.gateway.open({ hostname: f.routeD.hostname, headers: f.dave }),
        ],
        { concurrency: "unbounded" },
      );
      const [aResponse, bResponse] = yield* Effect.all(
        [
          a.applicationRequest({ method: "GET", path: "/changed", headers: {} }),
          b.applicationRequest({ method: "GET", path: "/changed", headers: {} }),
        ],
        { concurrency: "unbounded" },
      );
      expect(yield* streamText(aResponse.body)).toContain(f.c.target.sessionId);
      expect(yield* streamText(bResponse.body)).toContain(f.d.target.sessionId);
      expect(a.route.target.sessionId).not.toBe(b.route.target.sessionId);
      expect(yield* f.control).toEqual({
        revision: "shared-original",
        login: "shared-login",
        writes: 7,
      });
    }),
  ),
);

it.effect(
  "forwards application WSS frames on the session HMR path and closes on session stop",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const upstream = yield* testSocket;
        f.upstreamSockets.set(f.c.target.sessionId, upstream.socket);
        const handler = yield* HttpRouter.toHttpEffect(
          PreviewGatewayHttpRoutes(f.gateway).pipe(Layer.provide(HttpRouter.layer)),
        );
        const browser = yield* testSocket;
        const upgraded = yield* Deferred.make<void>();
        const request = HttpServerRequest.fromWeb(
          new Request(`https://${f.routeC.hostname}/_preview/app/__vite_hmr?token=path-only`, {
            headers: {
              ...f.carol,
              host: f.routeC.hostname,
              origin: `https://${f.routeC.hostname}`,
              upgrade: "websocket",
              "sec-websocket-protocol": "vite-hmr",
              cookie: "shared=must-not-forward",
            },
          }),
        );
        const wrapped = new Proxy(request, {
          get: (target, key, receiver) =>
            key === "upgrade"
              ? Deferred.succeed(upgraded, undefined).pipe(Effect.as(browser.socket))
              : Reflect.get(target, key, receiver),
        });
        const fiber = yield* handler.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, wrapped),
          Effect.forkChild,
        );
        yield* Deferred.await(upgraded);
        yield* f.controller.requestRevision(
          f.c.target.sessionId,
          f.c.target.generation,
          f.c.supervisorIdentity,
          "revision-b",
        );
        yield* f.gateway.register({ ...f.c.target, revision: "revision-b" }, f.c.ownerIdentity);
        yield* f.controller.activate(
          f.c.target.sessionId,
          f.c.target.generation,
          f.c.supervisorIdentity,
          "revision-b",
        );
        expect(f.applicationSocketObservations).toContainEqual({
          sessionId: f.c.target.sessionId,
          path: "/_preview/app/__vite_hmr?token=path-only",
          headers: { "sec-websocket-protocol": "vite-hmr" },
          principal: {
            userId: "carol",
            sessionId: f.c.target.sessionId,
            generation: f.c.target.generation,
            role: f.c.target.role,
            expiresAt: expect.any(Number),
            effectivePrincipal: {
              subject: "carol",
              issuer: "https://auth.dev.example.test",
              audiences: ["sheet-web"],
              scopes: ["application:read", "application:write"],
            },
          },
        });
        yield* browser.receive("hmr-update");
        expect(yield* upstream.sent).toBe("hmr-update");
        yield* upstream.receive("hmr-ack");
        expect(yield* browser.sent).toBe("hmr-ack");
        yield* f.controller.stop(f.c.target.sessionId, f.c.ownerIdentity);
        expect(Socket.isCloseEvent(yield* browser.sent)).toBe(true);
        yield* Fiber.join(fiber);
      }),
    ),
);

const testSocket = Effect.gen(function* () {
  const incoming = yield* Queue.unbounded<string | Uint8Array | null>();
  const outgoing = yield* Queue.unbounded<string | Uint8Array | Socket.CloseEvent>();
  const socket = Socket.make({
    writer: Effect.succeed((chunk) => Queue.offer(outgoing, chunk).pipe(Effect.asVoid)),
    runRaw: (handler, options) =>
      Effect.gen(function* () {
        if (options?.onOpen !== undefined) yield* options.onOpen;
        while (true) {
          const frame = yield* Queue.take(incoming);
          if (frame === null) return;
          const handled = handler(frame);
          if (handled !== undefined) yield* handled;
        }
      }),
  });
  return {
    socket,
    receive: (frame: string) => Queue.offer(incoming, frame),
    sent: Queue.take(outgoing),
  };
});

it.effect("revalidates an application route without changing the browser state generation", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      yield* TestClock.adjust(30_000);
      const resumed = yield* f.controller.resume(
        f.c.target.sessionId,
        f.c.ownerIdentity,
        f.c.supervisorIdentity,
      );
      const route = yield* f.gateway.resumeApplication(
        f.c.target.sessionId,
        "sheet-web",
        f.c.ownerIdentity,
      );
      expect(route.target.generation).toBe(resumed.session.generation);
      yield* f.controller.activate(
        f.c.target.sessionId,
        resumed.session.generation,
        resumed.supervisorIdentity,
        resumed.session.requestedRevision,
      );
      const nextProof = f.token(
        "carol-next",
        { ...f.c.target, generation: resumed.session.generation },
        "carol",
      );
      const admission = yield* f.gateway.open({ hostname: route.hostname, headers: nextProof });
      expect(admission.route.target.generation).toBe(resumed.session.generation);
      expect(
        Schema.is(PreviewGatewayTargetSchema)({
          ...f.c.target,
          role: "sheet-workflows-api",
          stateGroup: "workflow-execution",
          kind: "application",
        }),
      ).toBe(true);
    }),
  ),
);

it.effect("keeps application routes unavailable without operator-verified identity mediation", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const noMediation = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller: f.controller,
        now: f.now,
        adapters: {
          ...f.adapters,
          checkSetup: Effect.sync(() => ({
            domain: "dev.example.test",
            observedAt: f.now(),
            wildcardDns: true as const,
            wildcardCertificate: true as const,
            independentGatewayAuthentication: true as const,
            singleControllerFenceDelivery: true as const,
          })),
        },
      });
      yield* denied(noMediation.register(f.c.target, f.c.ownerIdentity));

      const missingPrincipal = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller: f.controller,
        now: f.now,
        adapters: {
          ...f.adapters,
          authenticate: () =>
            Effect.succeed({
              userId: "carol",
              sessionId: f.c.target.sessionId,
              generation: f.c.target.generation,
              role: f.c.target.role,
              expiresAt: f.now() + 3 * previewSessionLeaseMs,
            }),
        },
      });
      yield* denied(missingPrincipal.open({ hostname: f.routeC.hostname, headers: f.carol }));
    }),
  ),
);

it.effect("fences the prior source revision until the changed application route is ready", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const requested = yield* f.controller.requestRevision(
        f.c.target.sessionId,
        f.c.target.generation,
        f.c.supervisorIdentity,
        "revision-b",
      );
      expect(requested.activeRevision).toBe("rev-a");
      expect(requested.requestedRevision).toBe("revision-b");
      yield* denied(f.gateway.open({ hostname: f.routeC.hostname, headers: f.carol }));
      const updated = yield* f.gateway.register(
        { ...f.c.target, revision: "revision-b" },
        f.c.ownerIdentity,
      );
      const activated = yield* f.controller.activate(
        f.c.target.sessionId,
        f.c.target.generation,
        f.c.supervisorIdentity,
        "revision-b",
      );
      expect(activated.activeRevision).toBe(updated.target.revision);
      expect(
        (yield* f.gateway.open({ hostname: f.routeC.hostname, headers: f.carol })).route.target
          .revision,
      ).toBe("revision-b");
    }),
  ),
);

it.effect(
  "upgrades WebSockets, carries both directions, fences open sockets and keeps reconnects on the original session",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const upstreamA = yield* testSocket;
        const upstreamB = yield* testSocket;
        f.upstreamSockets.set(f.a.target.sessionId, upstreamA.socket);
        f.upstreamSockets.set(f.b.target.sessionId, upstreamB.socket);
        const handler = yield* HttpRouter.toHttpEffect(
          PreviewGatewayHttpRoutes(f.gateway).pipe(Layer.provide(HttpRouter.layer)),
        );
        const connect = (hostname: string, headers: Record<string, string>) =>
          Effect.gen(function* () {
            const browser = yield* testSocket;
            const upgraded = yield* Deferred.make<void>();
            const request = HttpServerRequest.fromWeb(
              new Request(`https://${hostname}/_preview/probe`, {
                headers: {
                  ...headers,
                  host: hostname,
                  origin: `https://${hostname}`,
                  upgrade: "websocket",
                },
              }),
            );
            const upgrade = Deferred.succeed(upgraded, undefined).pipe(Effect.as(browser.socket));
            const wrapped = new Proxy(request, {
              get: (target, key, receiver) =>
                key === "upgrade" ? upgrade : Reflect.get(target, key, receiver),
            });
            const fiber = yield* handler.pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, wrapped),
              Effect.forkChild,
            );
            yield* Deferred.await(upgraded);
            return { browser, fiber };
          });
        const a = yield* connect(f.routeA.hostname, f.alice);
        const b = yield* connect(f.routeB.hostname, f.bob);
        yield* a.browser.receive("a-request");
        expect(yield* upstreamA.sent).toBe("a-request");
        yield* upstreamA.receive("a-response");
        expect(yield* a.browser.sent).toBe("a-response");
        yield* f.controller.stop(f.a.target.sessionId, f.a.ownerIdentity);
        const closed = yield* a.browser.sent;
        expect(Socket.isCloseEvent(closed)).toBe(true);
        yield* Fiber.join(a.fiber);
        yield* b.browser.receive("b-still-open");
        expect(yield* upstreamB.sent).toBe("b-still-open");
        yield* denied(f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice }));
        yield* f.controller.stop(f.b.target.sessionId, f.b.ownerIdentity);
        expect(Socket.isCloseEvent(yield* b.browser.sent)).toBe(true);
        yield* Fiber.join(b.fiber);
        expect(yield* f.control).toEqual({
          revision: "shared-original",
          login: "shared-login",
          writes: 7,
        });
      }),
    ),
);

it.effect("stop interrupts an in-flight probe without waiting for its response", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const a = yield* f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice });
      const started = yield* Deferred.make<void>();
      const pending = yield* a
        .guard(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* f.controller.stop(f.a.target.sessionId, f.a.ownerIdentity);
      expect((yield* Fiber.await(pending))._tag).toBe("Failure");
      expect((yield* f.controller.status(f.a.target.sessionId)).phase).toBe("ended");
    }),
  ),
);

it.effect(
  "idle expiry fences session A while renewed session B and the shared control remain available",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.sql`UPDATE preview_sessions SET lease_deadline=1000 WHERE id=${f.a.target.sessionId}`;
        const a = yield* f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice });
        const b = yield* f.gateway.open({ hostname: f.routeB.hostname, headers: f.bob });
        yield* TestClock.adjust(500);
        yield* f.controller.heartbeat(f.b.target.sessionId, f.b.supervisorIdentity, 1);
        yield* TestClock.adjust(500);
        yield* a.fenced;
        yield* denied(a.guard(Effect.succeed("late frame")));
        expect(yield* b.guard(b.connection.http(b.headers))).toBe(`probe:${f.b.target.sessionId}`);
        expect(yield* f.control).toEqual({
          revision: "shared-original",
          login: "shared-login",
          writes: 7,
        });
      }),
    ),
);

it.effect(
  "fails closed on authority loss, wrong setup and mismatched process, revision, group, role or generation",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        for (const difference of [
          { processId: "other-process" },
          { revision: "old-revision" },
          { stateGroup: "auth" },
          { generation: 2 },
          { role: "sheet-auth" as const },
          { serviceResourceId: "recreated-service" },
          { attachmentResourceId: "replaced-attachment" },
          { port: 3999 },
        ]) {
          f.override({ ...f.a.target, ...difference });
          yield* denied(f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice }));
        }
        f.override(undefined);
        const invalidSetup = yield* makePreviewGateway({
          domain: "dev.example.test",
          controller: f.controller,
          now: f.now,
          adapters: { ...f.adapters, checkSetup: Effect.fail(bad()) },
        });
        yield* denied(invalidSetup.register(f.a.target, f.a.ownerIdentity));
        yield* denied(invalidSetup.open({ hostname: f.routeA.hostname, headers: f.alice }));
        const a = yield* f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice });
        yield* f.sql`ALTER TABLE preview_sessions RENAME TO disconnected_preview_sessions`;
        yield* denied(a.guard(a.connection.http(a.headers)));
        yield* a.fenced;
        expect(f.observations).toHaveLength(0);
      }),
    ),
);

it.effect("expired user credentials cannot borrow a renewed session lease", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const proof = {
        userId: "alice",
        sessionId: f.a.target.sessionId,
        role: f.a.target.role,
        generation: 1,
        expiresAt: 500,
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller: f.controller,
        now: f.now,
        adapters: { ...f.adapters, authenticate: () => Effect.succeed(proof) },
      });
      const a = yield* gateway.open({ hostname: f.routeA.hostname, headers: f.alice });
      yield* TestClock.adjust(500);
      yield* a.fenced;
      yield* denied(gateway.open({ hostname: f.routeA.hostname, headers: f.alice }));
      expect((yield* f.controller.status(f.a.target.sessionId)).phase).toBe("active");
    }),
  ),
);

it.effect("explicit resume preserves the target generation and configured user grants", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      yield* f.gateway.grant(f.routeA.hostname, f.a.ownerIdentity, "guest", true);
      yield* TestClock.adjust(30_000);
      const resumed = yield* f.controller.resume(
        f.a.target.sessionId,
        f.a.ownerIdentity,
        f.a.supervisorIdentity,
      );
      const target = { ...f.a.target, generation: resumed.session.generation };
      yield* f.gateway.register(target, f.a.ownerIdentity);
      yield* f.controller.activate(
        target.sessionId,
        target.generation,
        resumed.supervisorIdentity,
        target.revision,
      );
      expect(resumed.session.generation).toBe(f.a.target.generation);
      expect(
        (yield* f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice })).route.target
          .generation,
      ).toBe(f.a.target.generation);
      const guestProof = f.token("guest-resumed", target, "guest");
      expect(
        (yield* f.gateway.open({ hostname: f.routeA.hostname, headers: guestProof })).route.target
          .generation,
      ).toBe(f.a.target.generation);
    }),
  ),
);

it.effect(
  "rotates a non-web route generation and clears its configured user grants on resume",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const created = yield* f.createSession("erin", "application", "sheet-workflows-api");
        const route = yield* f.gateway.register(created.target, created.ownerIdentity);
        const guestProof = f.token("erin-guest", created.target, "guest");
        yield* f.gateway.grant(route.hostname, created.ownerIdentity, "guest", true);
        expect(
          (yield* f.gateway.open({ hostname: route.hostname, headers: guestProof })).principal
            .userId,
        ).toBe("guest");

        yield* TestClock.adjust(30_000);
        const resumed = yield* f.controller.resume(
          created.session.id,
          created.ownerIdentity,
          created.supervisorIdentity,
        );
        const target = { ...created.target, generation: resumed.session.generation };
        yield* f.gateway.register(target, created.ownerIdentity);
        yield* f.controller.activate(
          target.sessionId,
          target.generation,
          resumed.supervisorIdentity,
          target.revision,
        );

        expect(resumed.session.generation).toBe(created.session.generation + 1);
        const grants =
          yield* f.sql`SELECT user_id FROM preview_gateway_grants WHERE hostname=${route.hostname}`;
        expect(grants).toHaveLength(0);
        yield* denied(f.gateway.open({ hostname: route.hostname, headers: guestProof }));
        const ownerProof = f.token("erin-resumed", target, "erin");
        expect(
          (yield* f.gateway.open({ hostname: route.hostname, headers: ownerProof })).principal
            .userId,
        ).toBe("erin");
      }),
    ),
);
