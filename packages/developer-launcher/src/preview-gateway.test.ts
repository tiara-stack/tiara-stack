import { createHash } from "node:crypto";
import { it, expect } from "@effect/vitest";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Deferred, Effect, Fiber, Layer, Queue, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import { makePreviewSessionController, previewSessionLeaseMs } from "./preview-sessions";
import { relayNameFor } from "./preview-relay-provider";
import {
  makePreviewGateway,
  PreviewGatewayError,
  PreviewGatewayTargetSchema,
  type PreviewGatewayAdapters,
  type PreviewGatewayTarget,
  type PreviewGatewayPrincipal,
} from "./preview-gateway";
import { dispatchPreviewGatewayProtocol, PreviewGatewayHttpRoutes } from "./preview-gateway-http";

const bad = () => new PreviewGatewayError({ reason: "unavailable" });
const fixture = Effect.gen(function* () {
  const clock = yield* TestClock.testClockWith((value) => Effect.succeed(value));
  const now = () => clock.currentTimeMillisUnsafe();
  const sql = yield* SqlClient.SqlClient;
  const controller = yield* makePreviewSessionController(now);
  // Recorded provider receipts stand in for TIA-236's allocator, not live Kubernetes evidence.
  yield* sql`CREATE TABLE preview_allocation_ledger (session_id TEXT, resource TEXT, owner_token TEXT, provider_resource_id TEXT, state TEXT)`;
  const makeSession = (owner: string) =>
    Effect.gen(function* () {
      const created = yield* controller.create({
        owner,
        checkout: `/test/${owner}`,
        requestedRevision: "rev-a",
        manifests: { "sheet-web": "manifest" },
        groups: ["application-zero"],
      });
      const target: PreviewGatewayTarget = {
        sessionId: created.session.id,
        generation: 1,
        role: "sheet-web",
        processId: `probe-${owner}`,
        revision: "rev-a",
        stateGroup: "application-zero",
        kind: "disposable-probe",
        serviceFqdn: `${relayNameFor(created.session.id, "sheet-web")}.preview-relays.svc.cluster.local`,
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
        yield* sql`INSERT INTO preview_allocation_ledger VALUES (${target.sessionId}, ${`preview-relay-${kind}-sheet-web`}, ${token}, ${reference}, 'owned')`;
      }
      yield* controller.activate(created.session.id, 1, created.supervisorIdentity, "rev-a");
      return { ...created, target };
    });
  const a = yield* makeSession("alice");
  const b = yield* makeSession("bob");
  const tokens = new Map<string, PreviewGatewayPrincipal>();
  const token = (value: string, target: PreviewGatewayTarget, userId: string) => {
    tokens.set(value, {
      userId,
      sessionId: target.sessionId,
      generation: target.generation,
      role: target.role,
      expiresAt: now() + 3 * previewSessionLeaseMs,
    });
    return { authorization: `Bearer ${value}` };
  };
  const alice = token("alice-a", a.target, "alice");
  const bob = token("bob-b", b.target, "bob");
  const guestA = token("guest-a", a.target, "guest");
  const guestB = token("guest-b", b.target, "guest");
  yield* sql`CREATE TABLE shared_control (revision TEXT, login TEXT, writes INTEGER)`;
  yield* sql`INSERT INTO shared_control VALUES ('shared-original', 'shared-login', 7)`;
  const control = sql`SELECT revision, login, writes FROM shared_control`.pipe(
    Effect.map((rows) => rows[0]),
  );
  const observations: { sessionId: string; headers: Readonly<Record<string, string>> }[] = [];
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
  };
  const gateway = yield* makePreviewGateway({
    domain: "dev.example.test",
    controller,
    adapters,
    now,
  });
  const routeA = yield* gateway.register(a.target, a.ownerIdentity);
  const routeB = yield* gateway.register(b.target, b.ownerIdentity);
  return {
    a,
    b,
    gateway,
    controller,
    adapters,
    now,
    sql,
    routeA,
    routeB,
    alice,
    bob,
    guestA,
    guestB,
    token,
    control,
    observations,
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
        ).toEqual([f.routeB.hostname]);
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
  "persists grants across gateway restart and refuses route retargeting or application registration",
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
        expect(Schema.is(PreviewGatewayTargetSchema)({ ...f.a.target, kind: "application" })).toBe(
          false,
        );
        yield* denied(
          dispatchPreviewGatewayProtocol(restarted, {
            _tag: "RegisterProbe",
            version: 1,
            target: { ...f.a.target, kind: "application" },
            ownerIdentity: f.a.ownerIdentity,
          }),
        );
        yield* TestClock.adjust(30_000);
        yield* f.controller.resume(f.a.target.sessionId, f.a.ownerIdentity);
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
        yield* denied(request(f.routeA.hostname, "/application", f.alice));
        expect(f.observations).toHaveLength(1);
        expect(f.observations[0]?.headers).toEqual({});
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

it.effect(
  "explicit resume revalidates the target, resets grants and rejects the old generation",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.gateway.grant(f.routeA.hostname, f.a.ownerIdentity, "guest", true);
        yield* TestClock.adjust(30_000);
        const resumed = yield* f.controller.resume(f.a.target.sessionId, f.a.ownerIdentity);
        const target = { ...f.a.target, generation: resumed.session.generation };
        yield* f.gateway.register(target, f.a.ownerIdentity);
        yield* f.controller.activate(
          target.sessionId,
          target.generation,
          resumed.supervisorIdentity,
          target.revision,
        );
        yield* denied(f.gateway.open({ hostname: f.routeA.hostname, headers: f.alice }));
        const newProof = f.token("alice-resumed", target, "alice");
        expect(
          (yield* f.gateway.open({ hostname: f.routeA.hostname, headers: newProof })).route.target
            .generation,
        ).toBe(2);
        const guestProof = f.token("guest-resumed", target, "guest");
        yield* denied(f.gateway.open({ hostname: f.routeA.hostname, headers: guestProof }));
      }),
    ),
);
