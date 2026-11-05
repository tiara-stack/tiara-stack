import { createHash } from "node:crypto";
import { it, expect } from "@effect/vitest";
import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Queue,
  Schema,
  Scope,
} from "effect";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import * as Exit from "effect/Exit";
import {
  makePreviewSessionController,
  previewSessionLeaseMs,
  type PreviewSession,
} from "./preview-sessions";
import { relayNameFor } from "./preview-relay-provider";
import {
  closePreviewGatewayFences,
  makePreviewGateway,
  PreviewGatewayError,
  PreviewGatewayTargetSchema,
  type PreviewGatewayAdapters,
  type PreviewGatewayDependencyIdentity,
  type PreviewGatewayDependencyTarget,
  type PreviewGatewayApi,
  type PreviewGatewayChannelIdentity,
  type PreviewGatewayRelayConnection,
  type PreviewGatewayTarget,
  type PreviewGatewayPrincipal,
} from "./preview-gateway";
import { makeRetryableConnectionFence } from "./preview-gateway-close";
import { dispatchPreviewGatewayProtocol, PreviewGatewayHttpRoutes } from "./preview-gateway-http";
import { makePreviewWorkflowApiApplicationRoute } from "./preview-workflow-api-route";
import {
  makePreviewWorkflowApiWorkflowRequestRunner,
  PreviewWorkflowApiHostError,
} from "./preview-workflow-api-host";
import {
  makePreviewWorkflowApiSupervisor,
  makePreviewWorkflowApiSupervisorError,
  type PreviewWorkflowApiProcess,
  type PreviewWorkflowApiReadiness,
  type PreviewWorkflowApiSupervisorApi,
} from "./preview-workflow-api-supervisor";
import {
  previewSharedWorkflowGroupTarget,
  PreviewSharedWorkflowError,
  type PreviewSharedWorkflowGroup,
  type PreviewSharedWorkflowHttpRequestInput,
  type PreviewSharedWorkflowHttpRequestRunner,
} from "./preview-shared-workflow";

const bad = () => new PreviewGatewayError({ reason: "unavailable" });
const recoveryProof = (identity: PreviewGatewayChannelIdentity) =>
  ({
    identity,
    channelAbsent: true,
    pendingCreatesFenced: true,
  }) as const;
const samePreviewGatewayTarget = (left: PreviewGatewayTarget, right: PreviewGatewayTarget) =>
  Object.keys(PreviewGatewayTargetSchema.fields).every(
    (key) => Reflect.get(left, key) === Reflect.get(right, key),
  );
const sameChannelIdentity = (
  left: PreviewGatewayChannelIdentity,
  right: PreviewGatewayChannelIdentity,
) =>
  left.channelId === right.channelId &&
  left.hostname === right.hostname &&
  left.userId === right.userId &&
  samePreviewGatewayTarget(left.target, right.target);
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
    activate = true,
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
      if (activate)
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
  const externalChannels = new Map<string, PreviewGatewayChannelIdentity>();
  const closedChannelIds = new Set<string>();
  let closeBehavior = (sessionId: string) =>
    Effect.sync(() => {
      closed.push(sessionId);
    });
  const closeChannel = (channel: PreviewGatewayChannelIdentity): Effect.Effect<void> =>
    Effect.suspend(() => {
      const active = externalChannels.get(channel.channelId);
      if (active === undefined) {
        closedChannelIds.add(channel.channelId);
        return Effect.void;
      }
      if (
        active.hostname !== channel.hostname ||
        active.userId !== channel.userId ||
        !samePreviewGatewayTarget(active.target, channel.target)
      )
        return Effect.die(bad());
      return closeBehavior(channel.target.sessionId).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            externalChannels.delete(channel.channelId);
            closedChannelIds.add(channel.channelId);
          }),
        ),
      );
    });
  const recoverChannel = (channel: PreviewGatewayChannelIdentity) =>
    Effect.suspend(() => {
      const active = externalChannels.get(channel.channelId);
      if (
        active !== undefined &&
        (active.hostname !== channel.hostname ||
          active.userId !== channel.userId ||
          !samePreviewGatewayTarget(active.target, channel.target))
      )
        return Effect.fail(bad());
      return closeChannel(channel).pipe(Effect.as(recoveryProof(channel)));
    });
  const disconnected = new Set<string>();
  const upstreamSockets = new Map<string, Socket.Socket>();
  let identityOverride: PreviewGatewayTarget | undefined;
  const connectionFor = (
    target: PreviewGatewayTarget,
    close: Effect.Effect<void>,
  ): PreviewGatewayRelayConnection => ({
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
    close,
  });
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
      Effect.acquireRelease(
        Effect.sync(() => connectionFor(target, Effect.void)),
        (connection) => connection.close.pipe(Effect.orDie),
      ),
    connectChannel: (channel) =>
      Effect.suspend(() => {
        if (closedChannelIds.has(channel.channelId)) return Effect.fail(bad());
        externalChannels.set(channel.channelId, channel);
        return Effect.acquireRelease(
          Effect.sync(() =>
            connectionFor(channel.target, closeChannel(channel).pipe(Effect.asVoid)),
          ),
          (connection) => connection.close.pipe(Effect.orDie),
        );
      }),
    recoverChannel,
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
    createPendingSession: (
      owner: string,
      kind: PreviewGatewayTarget["kind"],
      role: PreviewGatewayTarget["role"],
    ) => makeSession(owner, kind, role, false),
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
    externalChannels,
    closedChannelIds,
    setCloseBehavior: (behavior: typeof closeBehavior) => {
      closeBehavior = behavior;
    },
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

it.effect("recovers the exact channel after a failed relay connect", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const session = yield* f.createSession("failed-connect-recovery");
      const route = yield* f.gateway.register(session.target, session.ownerIdentity);
      const authorization = f.token(
        "failed-connect-recovery-token",
        session.target,
        "failed-connect-recovery",
      );
      const externalChannels = new Map<string, PreviewGatewayChannelIdentity>();
      const reconciledChannelIds = new Set<string>();
      const recoveryIdentities: PreviewGatewayChannelIdentity[] = [];
      let recoveryAttempts = 0;
      let recoveryAvailable = false;
      let proofIdentityOverride: PreviewGatewayChannelIdentity | undefined;
      let expectedIdentity: PreviewGatewayChannelIdentity | undefined;
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        connectChannel: (channel) =>
          Effect.suspend(() =>
            reconciledChannelIds.has(channel.channelId)
              ? Effect.fail(bad())
              : Effect.sync(() => externalChannels.set(channel.channelId, channel)).pipe(
                  Effect.andThen(Effect.fail(bad())),
                ),
          ),
        recoverChannel: (channel) =>
          Effect.suspend(() => {
            recoveryAttempts += 1;
            recoveryIdentities.push(channel);
            if (
              expectedIdentity === undefined ||
              !sameChannelIdentity(channel, expectedIdentity) ||
              !recoveryAvailable
            )
              return Effect.fail(bad());
            externalChannels.delete(channel.channelId);
            reconciledChannelIds.add(channel.channelId);
            return Effect.succeed(recoveryProof(proofIdentityOverride ?? channel));
          }),
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller: f.controller,
        adapters,
        now: f.now,
      });

      expect(
        Exit.isFailure(
          yield* Effect.exit(gateway.open({ hostname: route.hostname, headers: authorization })),
        ),
      ).toBe(true);
      const rows =
        yield* f.sql`SELECT channel_id, hostname, session_id, generation, user_id, target_json, state
        FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      const row = rows[0];
      expect(rows).toHaveLength(1);
      if (row === undefined) return;
      const exactIdentity: PreviewGatewayChannelIdentity = {
        channelId: String(row.channel_id),
        hostname: String(row.hostname),
        userId: String(row.user_id),
        target: session.target,
      };
      expectedIdentity = exactIdentity;
      expect(JSON.parse(String(row.target_json))).toEqual(session.target);
      yield* f.controller.stop(session.target.sessionId, session.ownerIdentity);
      const unknownCleanup = yield* Effect.exit(
        gateway.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );
      const retainedAfterUnknown =
        yield* f.sql`SELECT state FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      const heldRelayClaims =
        yield* f.sql`SELECT resource, state FROM preview_allocation_ledger WHERE session_id=${session.target.sessionId}`;
      expect({
        cleanupFailed: Exit.isFailure(unknownCleanup),
        externalIdentity: externalChannels.get(exactIdentity.channelId),
        retainedStates: retainedAfterUnknown.map((channelRow) => channelRow.state),
        heldRelayClaims: heldRelayClaims.map((claim) => claim.state),
      }).toEqual({
        cleanupFailed: true,
        externalIdentity: exactIdentity,
        retainedStates: ["opening"],
        heldRelayClaims: ["owned", "owned"],
      });

      recoveryAvailable = true;
      proofIdentityOverride = { ...exactIdentity, userId: "foreign-user" };
      const mismatchedProofCleanup = yield* Effect.exit(
        gateway.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );
      const retainedAfterMismatchedProof =
        yield* f.sql`SELECT state FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      expect({
        cleanupFailed: Exit.isFailure(mismatchedProofCleanup),
        externallyAbsent: !externalChannels.has(exactIdentity.channelId),
        retainedStates: retainedAfterMismatchedProof.map((channelRow) => channelRow.state),
      }).toEqual({ cleanupFailed: true, externallyAbsent: true, retainedStates: ["opening"] });

      proofIdentityOverride = undefined;
      const retry = yield* Effect.exit(
        gateway.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );
      const retainedAfterRetry =
        yield* f.sql`SELECT state FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      const sameIdentityReconnect = yield* Effect.exit(adapters.connectChannel(exactIdentity));

      expect({
        cleanupSucceeded: Exit.isSuccess(retry),
        recoveryAttempts,
        recoveryIdentities,
        externalChannelIdentities: [...externalChannels.values()],
        remainingChannelStates: retainedAfterRetry.map((channelRow) => channelRow.state),
        sameIdentityReconnectBlocked: Exit.isFailure(sameIdentityReconnect),
      }).toEqual({
        cleanupSucceeded: true,
        recoveryAttempts: 3,
        recoveryIdentities: [exactIdentity, exactIdentity, exactIdentity],
        externalChannelIdentities: [],
        remainingChannelStates: [],
        sameIdentityReconnectBlocked: true,
      });
    }),
  ),
);

it.effect("fences delayed relay creation after unknown recovery and exact-session retry", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const session = yield* f.createSession("late-connect-recovery");
      const controller = { ...f.controller, watchFences: () => Effect.void };
      const route = yield* f.gateway.register(session.target, session.ownerIdentity);
      const channelId = "4db506b5-2957-4c99-93ce-6269f090da79";
      const identity: PreviewGatewayChannelIdentity = {
        channelId,
        hostname: route.hostname,
        userId: "late-connect-recovery",
        target: route.target,
      };
      const pending = new Map<string, PreviewGatewayChannelIdentity>();
      const external = new Map<string, PreviewGatewayChannelIdentity>();
      const fenced = new Set<string>();
      let recoveryAttempts = 0;
      let delayedIdentity: PreviewGatewayChannelIdentity | undefined;
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        connectChannel: (channel) =>
          Effect.sync(() => {
            delayedIdentity = channel;
            pending.set(channel.channelId, channel);
          }).pipe(Effect.andThen(Effect.fail(bad()))),
        recoverChannel: (channel) =>
          Effect.suspend(() => {
            recoveryAttempts += 1;
            if (fenced.has(channel.channelId)) return Effect.succeed(recoveryProof(channel));
            const pendingChannel = pending.get(channel.channelId);
            const activeChannel = external.get(channel.channelId);
            const observed = activeChannel ?? pendingChannel;
            if (observed === undefined || !sameChannelIdentity(observed, channel))
              return Effect.fail(bad());
            if (recoveryAttempts === 1) return Effect.fail(bad());
            external.delete(channel.channelId);
            pending.delete(channel.channelId);
            fenced.add(channel.channelId);
            return Effect.succeed(recoveryProof(channel));
          }),
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters,
        now: f.now,
      });
      yield* f.sql`CREATE TABLE preview_gateway_channels (
        channel_id TEXT PRIMARY KEY, hostname TEXT NOT NULL, session_id TEXT NOT NULL,
        generation INTEGER NOT NULL, user_id TEXT NOT NULL, target_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('opening', 'open'))
      )`;
      yield* f.sql`CREATE INDEX preview_gateway_channels_host_user
        ON preview_gateway_channels(hostname, user_id)`;
      yield* f.sql`INSERT INTO preview_gateway_channels
        (channel_id, hostname, session_id, generation, user_id, target_json, state)
        VALUES (${channelId}, ${route.hostname}, ${session.target.sessionId}, ${session.target.generation}, ${identity.userId}, ${JSON.stringify(route.target)}, 'opening')`;
      const connectExit = yield* Effect.exit(adapters.connectChannel(identity));
      expect(Exit.isFailure(connectExit)).toBe(true);
      const pendingRows =
        yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      expect(pendingRows).toHaveLength(1);
      expect({
        pendingChannels: [...pending.keys()],
        externalChannels: [...external.keys()],
      }).toEqual({
        pendingChannels: [channelId],
        externalChannels: [],
      });

      yield* controller.stop(session.target.sessionId, session.ownerIdentity);
      const unknownCleanup = yield* Effect.exit(
        gateway.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );
      const rowsAfterUnknown =
        yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      const heldClaims =
        yield* f.sql`SELECT state FROM preview_allocation_ledger WHERE session_id=${session.target.sessionId}`;
      expect({
        cleanupFailedClosed: Exit.isFailure(unknownCleanup),
        retainedRows: rowsAfterUnknown.length,
        pendingIds: [...pending.keys()],
        heldClaims: heldClaims.map((claim) => claim.state),
      }).toEqual({
        cleanupFailedClosed: true,
        retainedRows: 1,
        pendingIds: [channelId],
        heldClaims: ["owned", "owned"],
      });
      const cleanup = yield* Effect.exit(
        gateway.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );
      const rowsAfterCleanup =
        yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;

      const identityForLateCreate = delayedIdentity;
      if (identityForLateCreate !== undefined)
        yield* Effect.sync(() => {
          if (!fenced.has(identityForLateCreate.channelId))
            external.set(identityForLateCreate.channelId, identityForLateCreate);
          pending.delete(identityForLateCreate.channelId);
        });

      expect({
        cleanupSucceeded: Exit.isSuccess(cleanup),
        recoveryAttempts,
        retainedRows: rowsAfterCleanup.length,
        fencedChannelIds: [...fenced],
        lateExternalChannelIds: [...external.keys()],
      }).toEqual({
        cleanupSucceeded: true,
        recoveryAttempts: 2,
        retainedRows: 0,
        fencedChannelIds: [channelId],
        lateExternalChannelIds: [],
      });
    }),
  ),
);

it.effect("recovers a persisted channel from a second gateway instance", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const controller = { ...f.controller, watchFences: () => Effect.void };
      const firstGateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters: f.adapters,
        now: f.now,
      });
      const session = yield* f.createSession("cross-instance-recovery");
      const route = yield* firstGateway.register(session.target, session.ownerIdentity);
      const authorization = f.token(
        "cross-instance-recovery-token",
        session.target,
        "cross-instance-recovery",
      );
      yield* firstGateway.open({ hostname: route.hostname, headers: authorization });
      const recoveryIdentities: PreviewGatewayChannelIdentity[] = [];
      let recoveries = 0;
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        recoverChannel: (channel) =>
          Effect.sync(() => {
            recoveries += 1;
            recoveryIdentities.push(channel);
          }).pipe(Effect.andThen(f.adapters.recoverChannel(channel))),
      };
      const recoveredByAnotherInstance = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters,
        now: f.now,
      });
      yield* controller.stop(session.target.sessionId, session.ownerIdentity);
      const cleanup = yield* Effect.exit(
        recoveredByAnotherInstance.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );
      const rows =
        yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      const persisted =
        yield* f.sql`SELECT target_json FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      const cleanupCause = Exit.isFailure(cleanup) ? Cause.pretty(cleanup.cause) : undefined;

      expect({
        cleanupSucceeded: Exit.isSuccess(cleanup),
        cleanupCause,
        recoveries,
        recoveryIdentity: recoveryIdentities[0],
        targetJsonMatches:
          persisted.length === 0 ||
          String(persisted[0]?.target_json) === JSON.stringify(recoveryIdentities[0]?.target),
        remainingRows: rows.length,
        externalChannels: [...f.externalChannels.keys()],
      }).toEqual({
        cleanupSucceeded: true,
        cleanupCause: undefined,
        recoveries: 1,
        recoveryIdentity: expect.objectContaining({
          channelId: expect.any(String),
          hostname: route.hostname,
          userId: "cross-instance-recovery",
          target: session.target,
        }),
        targetJsonMatches: true,
        remainingRows: 0,
        externalChannels: [],
      });
    }),
  ),
);

it.effect("retains foreign user, session, and generation channel claims", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const controller = { ...f.controller, watchFences: () => Effect.void };
      const writer = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters: f.adapters,
        now: f.now,
      });
      const readerRecoveries: PreviewGatewayChannelIdentity[] = [];
      const readerAdapters: PreviewGatewayAdapters = {
        ...f.adapters,
        recoverChannel: (channel) =>
          Effect.sync(() => readerRecoveries.push(channel)).pipe(
            Effect.andThen(f.adapters.recoverChannel(channel)),
          ),
      };
      const reader = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters: readerAdapters,
        now: f.now,
      });
      const session = yield* f.createSession("foreign-claim-recovery");
      const route = yield* writer.register(session.target, session.ownerIdentity);
      const channelId = "bf96543c-53e4-4f6c-9534-4f7c95baf3f2";
      const exactIdentity: PreviewGatewayChannelIdentity = {
        channelId,
        hostname: route.hostname,
        userId: "foreign-claim-recovery",
        target: session.target,
      };
      yield* f.sql`CREATE TABLE preview_gateway_channels (
        channel_id TEXT PRIMARY KEY, hostname TEXT NOT NULL, session_id TEXT NOT NULL,
        generation INTEGER NOT NULL, user_id TEXT NOT NULL, target_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('opening', 'open'))
      )`;
      yield* f.sql`CREATE INDEX preview_gateway_channels_host_user
        ON preview_gateway_channels(hostname, user_id)`;
      yield* f.sql`INSERT INTO preview_gateway_channels
        (channel_id, hostname, session_id, generation, user_id, target_json, state)
        VALUES (${channelId}, ${route.hostname}, ${session.target.sessionId}, ${session.target.generation}, ${exactIdentity.userId}, ${JSON.stringify(session.target)}, 'open')`;
      f.externalChannels.set(channelId, exactIdentity);
      yield* controller.stop(session.target.sessionId, session.ownerIdentity);

      yield* f.sql`UPDATE preview_gateway_channels SET user_id='foreign-user' WHERE channel_id=${channelId}`;
      const wrongUser = yield* Effect.exit(
        reader.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );
      const userRetained =
        yield* f.sql`SELECT user_id FROM preview_gateway_channels WHERE channel_id=${channelId}`;
      expect({
        failedClosed: Exit.isFailure(wrongUser),
        retainedUser: userRetained[0]?.user_id,
        adapterUser: readerRecoveries[0]?.userId,
        externalIdentity: f.externalChannels.get(channelId),
      }).toEqual({
        failedClosed: true,
        retainedUser: "foreign-user",
        adapterUser: "foreign-user",
        externalIdentity: exactIdentity,
      });

      yield* f.sql`UPDATE preview_gateway_channels SET user_id='foreign-claim-recovery' WHERE channel_id=${channelId}`;
      yield* f.sql`UPDATE preview_gateway_channels SET generation=${session.target.generation + 1} WHERE channel_id=${channelId}`;
      const wrongGeneration = yield* Effect.exit(
        reader.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );
      const generationRetained =
        yield* f.sql`SELECT generation FROM preview_gateway_channels WHERE channel_id=${channelId}`;
      expect({
        failedClosed: Exit.isFailure(wrongGeneration),
        generation: generationRetained[0]?.generation,
      }).toEqual({
        failedClosed: true,
        generation: session.target.generation + 1,
      });

      yield* f.sql`UPDATE preview_gateway_channels SET generation=${session.target.generation} WHERE channel_id=${channelId}`;
      yield* f.sql`UPDATE preview_gateway_channels SET session_id=${f.b.target.sessionId}, target_json=${JSON.stringify(f.b.target)}, generation=${f.b.target.generation} WHERE channel_id=${channelId}`;
      const wrongSession = yield* Effect.exit(
        reader.cleanup(route.hostname, session.ownerIdentity),
      );
      const sessionRetained =
        yield* f.sql`SELECT session_id FROM preview_gateway_channels WHERE channel_id=${channelId}`;

      expect({
        failedClosed: Exit.isFailure(wrongSession),
        retainedSession: sessionRetained[0]?.session_id,
        adapterRecoveryCount: readerRecoveries.length,
      }).toEqual({
        failedClosed: true,
        retainedSession: f.b.target.sessionId,
        adapterRecoveryCount: 1,
      });
    }),
  ),
);

it.effect("keeps a legacy row when its exact relay target cannot be recovered", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const controller = { ...f.controller, watchFences: () => Effect.void };
      const recoveries: PreviewGatewayChannelIdentity[] = [];
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters: {
          ...f.adapters,
          recoverChannel: (identity) =>
            Effect.sync(() => recoveries.push(identity)).pipe(
              Effect.andThen(f.adapters.recoverChannel(identity)),
            ),
        },
        now: f.now,
      });
      const session = yield* f.createSession("legacy-channel-row");
      const route = yield* gateway.register(session.target, session.ownerIdentity);
      const channelId = "6ca0952d-6a7e-47c5-b1f2-0cd239d1f93a";
      yield* f.sql`CREATE TABLE preview_gateway_channels (
        channel_id TEXT PRIMARY KEY, hostname TEXT NOT NULL, session_id TEXT NOT NULL,
        generation INTEGER NOT NULL, user_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('opening', 'open'))
      )`;
      yield* f.sql`CREATE INDEX preview_gateway_channels_host_user
        ON preview_gateway_channels(hostname, user_id)`;
      yield* f.sql`INSERT INTO preview_gateway_channels
        (channel_id, hostname, session_id, generation, user_id, state)
        VALUES (${channelId}, ${route.hostname}, ${session.target.sessionId}, ${session.target.generation}, 'legacy-user', 'opening')`;
      yield* controller.stop(session.target.sessionId, session.ownerIdentity);

      const cleanup = yield* Effect.exit(
        gateway.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );
      const retained =
        yield* f.sql`SELECT channel_id, target_json, state FROM preview_gateway_channels WHERE channel_id=${channelId}`;

      expect({
        cleanupFailedClosed: Exit.isFailure(cleanup),
        recoveryCalls: recoveries.length,
        retained: retained.map((row) => ({
          channelId: row.channel_id,
          target: row.target_json,
          state: row.state,
        })),
      }).toEqual({
        cleanupFailedClosed: true,
        recoveryCalls: 0,
        retained: [{ channelId, target: null, state: "opening" }],
      });
    }),
  ),
);

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

it.effect("retries an interrupted gateway connection close before cleanup can finish", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const controller = {
        ...f.controller,
        // Keep this test on the explicit cleanup boundary so it can interrupt that close attempt.
        watchFences: () => Effect.void,
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters: f.adapters,
        now: f.now,
      });
      const session = yield* f.createSession("erin");
      const route = yield* gateway.register(session.target, session.ownerIdentity);
      const authorization = f.token("erin-token", session.target, "erin");
      const connection = yield* gateway.open({ hostname: route.hostname, headers: authorization });
      let closeAttempts = 0;
      f.setCloseBehavior((sessionId) => {
        closeAttempts += 1;
        return closeAttempts === 1
          ? Effect.interrupt
          : Effect.sync(() => {
              f.closed.push(sessionId);
            });
      });
      yield* f.controller.stop(session.target.sessionId, session.ownerIdentity);

      const firstCleanup = yield* Effect.exit(
        gateway.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );
      yield* connection.fenced;
      yield* denied(gateway.open({ hostname: route.hostname, headers: authorization }));
      expect(firstCleanup._tag).toBe("Failure");

      yield* gateway.cleanupSession(session.target.sessionId, session.ownerIdentity);

      expect(closeAttempts).toBe(2);
      expect(f.closed).toContain(session.target.sessionId);
      yield* denied(connection.guard(Effect.succeed("late frame")));
    }),
  ),
);

it.effect("retains an unconfirmed scoped close fence until exact recovery succeeds", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const controller = {
        ...f.controller,
        watchFences: () => Effect.void,
      };
      const session = yield* f.createSession("scope-finalizer");
      const route = yield* f.gateway.register(session.target, session.ownerIdentity);
      const authorization = f.token("scope-finalizer-token", session.target, "scope-finalizer");
      const closeDefect = new Error("tracked-close-defect");
      let closeAttempts = 0;
      let closeBehavior: (sessionId: string) => Effect.Effect<void> = () => {
        closeAttempts += 1;
        return Effect.die(closeDefect);
      };
      let recoveryAvailable = false;
      let recoveryAttempts = 0;
      const connectedIdentities: PreviewGatewayChannelIdentity[] = [];
      const recoveredIdentities: PreviewGatewayChannelIdentity[] = [];
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        connectChannel: (channel) =>
          Effect.sync(() => {
            connectedIdentities.push(channel);
            return {
              identity: channel.target,
              connected: Effect.succeed(true),
              http: () => Effect.succeed(`probe:${channel.target.sessionId}`),
              socket: Effect.fail(bad()),
              close: Effect.suspend(() => closeBehavior(channel.target.sessionId)),
            };
          }),
        recoverChannel: (channel) =>
          Effect.suspend(() => {
            recoveryAttempts += 1;
            recoveredIdentities.push(channel);
            return recoveryAvailable ? Effect.succeed(recoveryProof(channel)) : Effect.fail(bad());
          }),
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters,
        now: f.now,
      });
      let fenced: Effect.Effect<void> | undefined;
      let lateFrame: Effect.Effect<string, PreviewGatewayError> | undefined;
      const finalizer = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* gateway.open({
              hostname: route.hostname,
              headers: authorization,
            });
            fenced = connection.fenced;
            lateFrame = connection.guard(Effect.succeed("late frame"));
          }),
        ),
      );

      expect(finalizer._tag).toBe("Failure");
      expect(closeAttempts).toBe(1);
      expect(recoveryAttempts).toBe(1);
      expect(fenced).toBeDefined();
      expect(lateFrame).toBeDefined();
      if (fenced === undefined || lateFrame === undefined) return;
      yield* fenced;
      expect((yield* Effect.exit(lateFrame))._tag).toBe("Failure");
      expect(closeAttempts).toBe(2);
      expect(recoveryAttempts).toBe(2);

      yield* controller.stop(session.target.sessionId, session.ownerIdentity);
      const unknownCleanup = yield* Effect.exit(
        gateway.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );
      expect(Exit.isFailure(unknownCleanup)).toBe(true);
      if (Exit.isFailure(unknownCleanup)) {
        const causeSummary = unknownCleanup.cause.reasons.map((reason) => {
          if (Cause.isFailReason(reason))
            return `fail:${reason.error instanceof PreviewGatewayError ? reason.error.reason : "other"}`;
          if (Cause.isDieReason(reason))
            return `die:${reason.defect instanceof Error ? reason.defect.message : "other"}`;
          return "other";
        });
        expect(causeSummary).toEqual(["die:tracked-close-defect", "fail:unavailable"]);
      }
      expect(closeAttempts).toBe(3);
      expect(recoveryAttempts).toBe(3);

      recoveryAvailable = true;
      yield* gateway.cleanupSession(session.target.sessionId, session.ownerIdentity);
      expect(closeAttempts).toBe(4);
      expect(recoveryAttempts).toBe(4);
      expect(recoveredIdentities).toEqual([
        connectedIdentities[0],
        connectedIdentities[0],
        connectedIdentities[0],
        connectedIdentities[0],
      ]);
      yield* gateway.cleanupSession(session.target.sessionId, session.ownerIdentity);
      expect(closeAttempts).toBe(4);
      expect(recoveryAttempts).toBe(4);
    }),
  ),
);

it.effect("recovers the exact channel after its tracked connection close fails", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const controller = {
        ...f.controller,
        watchFences: () => Effect.void,
      };
      const session = yield* f.createSession("recover-after-close-failure");
      const connectedIdentities: PreviewGatewayChannelIdentity[] = [];
      const recoveredIdentities: PreviewGatewayChannelIdentity[] = [];
      const externalChannels = new Map<string, PreviewGatewayChannelIdentity>();
      let closeAttempts = 0;
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        connectChannel: (channel) =>
          Effect.sync(() => {
            connectedIdentities.push(channel);
            externalChannels.set(channel.channelId, channel);
          }).pipe(
            Effect.as({
              identity: channel.target,
              connected: Effect.succeed(true),
              http: () => Effect.succeed(`probe:${channel.target.sessionId}`),
              socket: Effect.fail(bad()),
              close: Effect.suspend(() => {
                closeAttempts += 1;
                return Effect.fail(bad());
              }),
            }),
          ),
        recoverChannel: (channel) =>
          Effect.sync(() => {
            recoveredIdentities.push(channel);
            externalChannels.delete(channel.channelId);
            return recoveryProof(channel);
          }),
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters,
        now: f.now,
      });
      const route = yield* gateway.register(session.target, session.ownerIdentity);
      const authorization = f.token(
        "recover-after-close-failure-token",
        session.target,
        "recover-after-close-failure",
      );
      const admission = yield* gateway.open({ hostname: route.hostname, headers: authorization });

      yield* controller.stop(session.target.sessionId, session.ownerIdentity);
      const cleanup = yield* Effect.exit(
        gateway.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );

      expect({
        cleanupSucceeded: Exit.isSuccess(cleanup),
        closeAttempts,
        connectedIdentities,
        recoveredIdentities,
        externalChannelIds: [...externalChannels.keys()],
      }).toEqual({
        cleanupSucceeded: true,
        closeAttempts: 1,
        connectedIdentities: [
          expect.objectContaining({
            hostname: route.hostname,
            userId: "recover-after-close-failure",
            target: session.target,
          }),
        ],
        recoveredIdentities: connectedIdentities,
        externalChannelIds: [],
      });
      yield* admission.fenced;
      yield* denied(admission.guard(Effect.succeed("late frame")));
    }),
  ),
);

it.effect("recovers the exact channel after its tracked connection close defects", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const controller = {
        ...f.controller,
        watchFences: () => Effect.void,
      };
      const session = yield* f.createSession("recover-after-close-defect");
      const connectedIdentities: PreviewGatewayChannelIdentity[] = [];
      const recoveredIdentities: PreviewGatewayChannelIdentity[] = [];
      const externalChannels = new Map<string, PreviewGatewayChannelIdentity>();
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        connectChannel: (channel) =>
          Effect.sync(() => {
            connectedIdentities.push(channel);
            externalChannels.set(channel.channelId, channel);
          }).pipe(
            Effect.as({
              identity: channel.target,
              connected: Effect.succeed(true),
              http: () => Effect.succeed(`probe:${channel.target.sessionId}`),
              socket: Effect.fail(bad()),
              close: Effect.die(new Error("tracked-close-defect")),
            }),
          ),
        recoverChannel: (channel) =>
          Effect.sync(() => {
            recoveredIdentities.push(channel);
            externalChannels.delete(channel.channelId);
            return recoveryProof(channel);
          }),
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters,
        now: f.now,
      });
      const route = yield* gateway.register(session.target, session.ownerIdentity);
      const authorization = f.token(
        "recover-after-close-defect-token",
        session.target,
        "recover-after-close-defect",
      );
      const admission = yield* gateway.open({ hostname: route.hostname, headers: authorization });

      yield* controller.stop(session.target.sessionId, session.ownerIdentity);
      const cleanup = yield* Effect.exit(
        gateway.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );

      expect({
        cleanupSucceeded: Exit.isSuccess(cleanup),
        connectedIdentities,
        recoveredIdentities,
        externalChannelIds: [...externalChannels.keys()],
      }).toEqual({
        cleanupSucceeded: true,
        connectedIdentities: [
          expect.objectContaining({
            hostname: route.hostname,
            userId: "recover-after-close-defect",
            target: session.target,
          }),
        ],
        recoveredIdentities: connectedIdentities,
        externalChannelIds: [],
      });
      yield* admission.fenced;
      yield* denied(admission.guard(Effect.succeed("late frame")));
    }),
  ),
);

it.effect("bounds durable channel deletion with the scoped close fence and retries it", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const session = yield* f.createSession("scope-delete-timeout");
      const sql = yield* SqlClient.SqlClient;
      const deleteStarted = yield* Deferred.make<void>();
      const deleteRelease = yield* Deferred.make<void>();
      let deleteAttempts = 0;
      const interceptedSql = new Proxy(sql, {
        apply: (target, thisArgument, argumentsList) => {
          const statement = Reflect.apply(target, thisArgument, argumentsList);
          if (!statement.compile()[0].startsWith("DELETE FROM preview_gateway_channels"))
            return statement;
          return Effect.suspend(() => {
            deleteAttempts += 1;
            return deleteAttempts === 1
              ? Deferred.succeed(deleteStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(deleteRelease)),
                  Effect.as([]),
                )
              : statement;
          });
        },
      });
      let closeAttempts = 0;
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        connectChannel: ({ target }) =>
          Effect.succeed({
            identity: target,
            connected: Effect.succeed(true),
            http: () => Effect.succeed(`probe:${target.sessionId}`),
            socket: Effect.fail(bad()),
            close: Effect.sync(() => {
              closeAttempts += 1;
              f.closed.push(target.sessionId);
            }),
          }),
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller: f.controller,
        adapters,
        now: f.now,
      }).pipe(Effect.provideService(SqlClient.SqlClient, interceptedSql));
      const route = yield* gateway.register(session.target, session.ownerIdentity);
      const authorization = f.token(
        "scope-delete-timeout-token",
        session.target,
        "scope-delete-timeout",
      );
      const scopeFiber = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* gateway.open({ hostname: route.hostname, headers: authorization });
        }),
      ).pipe(Effect.exit, Effect.forkChild);

      yield* Deferred.await(deleteStarted);
      yield* TestClock.adjust(Duration.seconds(5));
      for (let attempt = 0; attempt < 20; attempt++) yield* Effect.yieldNow;
      const completedAtDeadline = scopeFiber.pollUnsafe() !== undefined;
      if (!completedAtDeadline) yield* Deferred.succeed(deleteRelease, undefined);
      const scopeExit = yield* Fiber.join(scopeFiber);

      expect(completedAtDeadline).toBe(true);
      expect(Exit.isFailure(scopeExit)).toBe(true);
      expect(closeAttempts).toBe(1);
      expect(deleteAttempts).toBe(1);
      const retained =
        yield* f.sql`SELECT state FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      expect(retained.map((row) => row.state)).toEqual(["open"]);

      yield* f.controller.stop(session.target.sessionId, session.ownerIdentity);
      yield* gateway.cleanupSession(session.target.sessionId, session.ownerIdentity);
      expect(closeAttempts).toBe(1);
      expect(deleteAttempts).toBe(2);
      expect(f.closed).toContain(session.target.sessionId);
    }),
  ),
);

it.effect("keeps offline cleanup blocked while another gateway owns an open channel", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const session = yield* f.createSession("offline-gateway-cleanup");
      const route = yield* f.gateway.register(session.target, session.ownerIdentity);
      const authorization = f.token(
        "offline-gateway-cleanup-token",
        session.target,
        "offline-gateway-cleanup",
      );
      const closeStarted = yield* Deferred.make<void>();
      const closeRelease = yield* Deferred.make<void>();
      let closeAttempts = 0;
      f.setCloseBehavior((sessionId) => {
        closeAttempts += 1;
        return Deferred.succeed(closeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(closeRelease)),
          Effect.tap(() => Effect.sync(() => f.closed.push(sessionId))),
        );
      });
      yield* f.gateway.open({ hostname: route.hostname, headers: authorization });
      yield* f.controller.stop(session.target.sessionId, session.ownerIdentity);
      yield* Deferred.await(closeStarted);

      const offlineGateway = yield* makePreviewGateway({
        domain: "",
        controller: f.controller,
        now: f.now,
      });
      const offlineCleanup = yield* Effect.exit(
        offlineGateway.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );
      expect(Exit.isFailure(offlineCleanup)).toBe(true);
      if (Exit.isFailure(offlineCleanup)) {
        expect(
          offlineCleanup.cause.reasons.some(
            (reason) =>
              Cause.isFailReason(reason) &&
              reason.error instanceof PreviewGatewayError &&
              reason.error.reason === "unavailable",
          ),
        ).toBe(true);
      }
      const outstanding =
        yield* f.sql`SELECT state FROM preview_gateway_channels WHERE hostname=${route.hostname}`;
      expect(outstanding.map((record) => record.state)).toEqual(["open"]);

      yield* Deferred.succeed(closeRelease, undefined);
      yield* f.gateway.cleanupSession(session.target.sessionId, session.ownerIdentity);
      expect(closeAttempts).toBe(1);
      expect(f.closed).toContain(session.target.sessionId);
      const afterOwnerClose =
        yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE hostname=${route.hostname}`;
      expect(afterOwnerClose).toHaveLength(0);

      const offlineRetry = yield* Effect.exit(
        offlineGateway.cleanupSession(session.target.sessionId, session.ownerIdentity),
      );
      expect(Exit.isSuccess(offlineRetry)).toBe(true);
      const removedRoutes =
        yield* f.sql`SELECT removed FROM preview_gateway_routes WHERE session_id=${session.target.sessionId}`;
      expect(removedRoutes.map((record) => record.removed)).toEqual([1]);
      yield* f.gateway.cleanupSession(session.target.sessionId, session.ownerIdentity);
    }),
  ),
);

it.effect("cleans an ended route-only session without gateway adapters", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const route = f.routeA;
      yield* f.gateway.grant(route.hostname, f.a.ownerIdentity, "offline-guest", true);
      yield* f.sql`INSERT INTO preview_gateway_dependency_routes
        (session_id, role, group_id, target, removed)
        VALUES (${f.a.target.sessionId}, ${f.a.target.role}, 'auth', '{}', 0)`;
      yield* f.controller.stop(f.a.target.sessionId, f.a.ownerIdentity);

      const offlineGateway = yield* makePreviewGateway({
        domain: "",
        controller: f.controller,
        now: f.now,
      });

      yield* offlineGateway.cleanupSession(f.a.target.sessionId, f.a.ownerIdentity);
      const routes = yield* f.sql`SELECT removed FROM preview_gateway_routes
        WHERE session_id=${f.a.target.sessionId}`;
      const grants = yield* f.sql`SELECT user_id FROM preview_gateway_grants
        WHERE hostname=${route.hostname}`;
      const dependencies = yield* f.sql`SELECT group_id FROM preview_gateway_dependency_routes
        WHERE session_id=${f.a.target.sessionId}`;
      expect({
        removedRoutes: routes.map((row) => row.removed),
        grants: grants.map((row) => row.user_id),
        dependencies: dependencies.map((row) => row.group_id),
      }).toEqual({ removedRoutes: [1], grants: [], dependencies: [] });

      yield* offlineGateway.cleanupSession(f.a.target.sessionId, f.a.ownerIdentity);
    }),
  ),
);

it.effect("cleans an ended route offline through the per-host boundary", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const route = f.routeA;
      yield* f.gateway.grant(route.hostname, f.a.ownerIdentity, "offline-host-guest", true);
      yield* f.sql`INSERT INTO preview_gateway_dependency_routes
        (session_id, role, group_id, target, removed)
        VALUES (${f.a.target.sessionId}, ${f.a.target.role}, 'auth', '{}', 0)`;
      yield* f.controller.stop(f.a.target.sessionId, f.a.ownerIdentity);
      const offlineGateway = yield* makePreviewGateway({
        domain: "",
        controller: f.controller,
        now: f.now,
      });

      yield* offlineGateway.cleanup(route.hostname, f.a.ownerIdentity);
      yield* offlineGateway.cleanup(route.hostname, f.a.ownerIdentity);
      const routes = yield* f.sql`SELECT removed FROM preview_gateway_routes
        WHERE session_id=${f.a.target.sessionId}`;
      const grants = yield* f.sql`SELECT user_id FROM preview_gateway_grants
        WHERE hostname=${route.hostname}`;
      const dependencies = yield* f.sql`SELECT group_id FROM preview_gateway_dependency_routes
        WHERE session_id=${f.a.target.sessionId}`;
      expect({
        removedRoutes: routes.map((row) => row.removed),
        grants: grants.map((row) => row.user_id),
        dependencies: dependencies.map((row) => row.group_id),
      }).toEqual({ removedRoutes: [1], grants: [], dependencies: [] });
    }),
  ),
);

it.effect("removes only the requested host from an ended multi-route session offline", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const roles = ["sheet-web", "sheet-auth"] as const;
      const created = yield* f.controller.create({
        owner: "offline-multi-route",
        checkout: "/test/offline-multi-route",
        requestedRevision: "rev-a",
        manifests: { "sheet-web": "web-manifest", "sheet-auth": "auth-manifest" },
        groups: ["application-zero"],
      });
      const targets: PreviewGatewayTarget[] = [];
      for (const role of roles) {
        const target: PreviewGatewayTarget = {
          ...f.a.target,
          sessionId: created.session.id,
          generation: created.session.generation,
          role,
          processId: `offline-multi-route-${role}`,
          revision: created.session.requestedRevision,
          serviceFqdn: `${relayNameFor(created.session.id, role)}.preview-relays.svc.cluster.local`,
          serviceResourceId: `offline-service-${role}`,
          attachmentResourceId: `offline-attachment-${role}`,
        };
        targets.push(target);
        for (const kind of ["service", "attachment"] as const) {
          const ownerToken = `offline-multi-route-${role}-${kind}`;
          const providerResourceId =
            kind === "service" ? target.serviceResourceId : target.attachmentResourceId;
          const reference = JSON.stringify({
            version: 1,
            kind,
            sessionId: target.sessionId,
            role,
            processId: target.processId,
            ownerTokenDigest: createHash("sha256").update(ownerToken).digest("hex").slice(0, 63),
            providerResourceId,
          });
          yield* f.sql`INSERT INTO preview_allocation_ledger
            VALUES (${target.sessionId}, ${`preview-relay-${kind}-${role}`}, ${ownerToken}, ${reference}, 'owned')`;
        }
      }
      yield* f.controller.activate(
        created.session.id,
        created.session.generation,
        created.supervisorIdentity,
        created.session.requestedRevision,
      );
      const routes = yield* Effect.forEach(targets, (target) =>
        f.gateway.register(target, created.ownerIdentity),
      );
      const selected = routes.find((route) => route.target.role === "sheet-web");
      const retained = routes.find((route) => route.target.role === "sheet-auth");
      if (selected === undefined || retained === undefined)
        return yield* Effect.die(new Error("multi-route fixture did not register both roles"));

      yield* f.gateway.grant(selected.hostname, created.ownerIdentity, "offline-web-guest", true);
      yield* f.gateway.grant(retained.hostname, created.ownerIdentity, "offline-auth-guest", true);
      for (const route of routes)
        yield* f.sql`INSERT INTO preview_gateway_dependency_routes
          (session_id, role, group_id, target, removed)
          VALUES (${created.session.id}, ${route.target.role}, 'auth', '{}', 0)`;
      yield* f.controller.stop(created.session.id, created.ownerIdentity);

      const offlineGateway = yield* makePreviewGateway({
        domain: "",
        controller: f.controller,
        now: f.now,
      });
      yield* offlineGateway.cleanup(selected.hostname, created.ownerIdentity);
      const selectedRoute =
        yield* f.sql`SELECT removed FROM preview_gateway_routes WHERE hostname=${selected.hostname}`;
      const retainedRoute =
        yield* f.sql`SELECT removed FROM preview_gateway_routes WHERE hostname=${retained.hostname}`;
      const selectedGrants =
        yield* f.sql`SELECT user_id FROM preview_gateway_grants WHERE hostname=${selected.hostname}`;
      const retainedGrants =
        yield* f.sql`SELECT user_id FROM preview_gateway_grants WHERE hostname=${retained.hostname}`;
      const selectedDependencies =
        yield* f.sql`SELECT group_id FROM preview_gateway_dependency_routes
        WHERE session_id=${created.session.id} AND role='sheet-web'`;
      const retainedDependencies =
        yield* f.sql`SELECT group_id FROM preview_gateway_dependency_routes
        WHERE session_id=${created.session.id} AND role='sheet-auth'`;

      expect({
        selectedRouteRemoved: selectedRoute[0]?.removed,
        retainedRouteRemoved: retainedRoute[0]?.removed,
        selectedGrants: selectedGrants.map((row) => row.user_id),
        retainedGrants: retainedGrants.map((row) => row.user_id),
        selectedDependencies: selectedDependencies.map((row) => row.group_id),
        retainedDependencies: retainedDependencies.map((row) => row.group_id),
      }).toEqual({
        selectedRouteRemoved: 1,
        retainedRouteRemoved: 0,
        selectedGrants: [],
        retainedGrants: ["offline-auth-guest"],
        selectedDependencies: [],
        retainedDependencies: ["auth"],
      });

      yield* offlineGateway.cleanupSession(created.session.id, created.ownerIdentity);
      const allRoutes = yield* f.sql`SELECT removed FROM preview_gateway_routes
        WHERE session_id=${created.session.id} ORDER BY hostname`;
      expect(allRoutes.map((row) => row.removed)).toEqual([1, 1]);
    }),
  ),
);

it.effect("preflights every session route before adapterless cleanup mutates metadata", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const route = f.routeA;
      const otherHostname = `other-${route.hostname}`;
      yield* f.gateway.grant(route.hostname, f.a.ownerIdentity, "held-guest", true);
      yield* f.sql`INSERT INTO preview_gateway_dependency_routes
        (session_id, role, group_id, target, removed)
        VALUES (${f.a.target.sessionId}, ${f.a.target.role}, 'auth', '{}', 0)`;
      yield* f.sql`INSERT INTO preview_gateway_routes
        (hostname, session_id, generation, target)
        VALUES (${otherHostname}, ${f.a.target.sessionId}, ${f.a.target.generation}, ${JSON.stringify(f.a.target)})`;
      yield* f.sql`CREATE TABLE preview_gateway_channels (
        channel_id TEXT PRIMARY KEY, hostname TEXT NOT NULL, session_id TEXT NOT NULL,
        generation INTEGER NOT NULL, user_id TEXT NOT NULL, target_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('opening', 'open'))
      )`;
      yield* f.sql`INSERT INTO preview_gateway_channels
        (channel_id, hostname, session_id, generation, user_id, target_json, state)
        VALUES ('00000000-0000-4000-8000-000000000001', ${otherHostname},
          'foreign-session', 7, 'foreign-user', NULL, 'opening')`;
      yield* f.controller.stop(f.a.target.sessionId, f.a.ownerIdentity);
      const offlineGateway = yield* makePreviewGateway({
        domain: "",
        controller: f.controller,
        now: f.now,
      });

      const sessionCleanup = yield* Effect.exit(
        offlineGateway.cleanupSession(f.a.target.sessionId, f.a.ownerIdentity),
      );
      const hostCleanup = yield* Effect.exit(
        offlineGateway.cleanup(route.hostname, f.a.ownerIdentity),
      );
      const routes =
        yield* f.sql`SELECT hostname, removed FROM preview_gateway_routes WHERE session_id=${f.a.target.sessionId} ORDER BY hostname`;
      const grants =
        yield* f.sql`SELECT user_id FROM preview_gateway_grants WHERE hostname=${route.hostname}`;
      const dependencies = yield* f.sql`SELECT group_id FROM preview_gateway_dependency_routes
        WHERE session_id=${f.a.target.sessionId}`;
      const channel =
        yield* f.sql`SELECT hostname, session_id, state FROM preview_gateway_channels WHERE channel_id='00000000-0000-4000-8000-000000000001'`;
      expect({
        sessionCleanupFailed: Exit.isFailure(sessionCleanup),
        hostCleanupFailed: Exit.isFailure(hostCleanup),
        routes: routes.map((row) => ({ hostname: row.hostname, removed: row.removed })),
        grants: grants.map((row) => row.user_id),
        dependencies: dependencies.map((row) => row.group_id),
        channel: channel.map((row) => ({
          hostname: row.hostname,
          sessionId: row.session_id,
          state: row.state,
        })),
      }).toEqual({
        sessionCleanupFailed: true,
        hostCleanupFailed: true,
        routes: [
          { hostname: route.hostname, removed: 0 },
          { hostname: otherHostname, removed: 0 },
        ].sort((left, right) => left.hostname.localeCompare(right.hostname)),
        grants: ["held-guest"],
        dependencies: ["auth"],
        channel: [{ hostname: otherHostname, sessionId: "foreign-session", state: "opening" }],
      });
    }),
  ),
);

it.effect("retains an orphan channel row owned by the ended session", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const route = f.routeA;
      yield* f.controller.stop(f.a.target.sessionId, f.a.ownerIdentity);
      yield* f.sql`CREATE TABLE preview_gateway_channels (
        channel_id TEXT PRIMARY KEY, hostname TEXT NOT NULL, session_id TEXT NOT NULL,
        generation INTEGER NOT NULL, user_id TEXT NOT NULL, target_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('opening', 'open'))
      )`;
      yield* f.sql`INSERT INTO preview_gateway_channels
        (channel_id, hostname, session_id, generation, user_id, target_json, state)
        VALUES ('00000000-0000-4000-8000-000000000002', 'orphan-host',
          ${f.a.target.sessionId}, ${f.a.target.generation}, 'alice', NULL, 'open')`;
      const offlineGateway = yield* makePreviewGateway({
        domain: "",
        controller: f.controller,
        now: f.now,
      });

      const sessionCleanup = yield* Effect.exit(
        offlineGateway.cleanupSession(f.a.target.sessionId, f.a.ownerIdentity),
      );
      const hostCleanup = yield* Effect.exit(
        offlineGateway.cleanup(route.hostname, f.a.ownerIdentity),
      );
      const routes = yield* f.sql`SELECT removed FROM preview_gateway_routes
        WHERE session_id=${f.a.target.sessionId}`;
      const orphan = yield* f.sql`SELECT hostname, state FROM preview_gateway_channels
        WHERE channel_id='00000000-0000-4000-8000-000000000002'`;
      expect({
        sessionCleanupFailed: Exit.isFailure(sessionCleanup),
        hostCleanupFailed: Exit.isFailure(hostCleanup),
        removedRoutes: routes.map((row) => row.removed),
        orphan: orphan.map((row) => ({ hostname: row.hostname, state: row.state })),
      }).toEqual({
        sessionCleanupFailed: true,
        hostCleanupFailed: true,
        removedRoutes: [0],
        orphan: [{ hostname: "orphan-host", state: "open" }],
      });
    }),
  ),
);

it.effect("fences an in-flight open after adapterless cleanup proves channel absence", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const authenticationStarted = yield* Deferred.make<void>();
      const releaseAuthentication = yield* Deferred.make<void>();
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        authenticate: (request) =>
          Deferred.succeed(authenticationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseAuthentication)),
            Effect.andThen(f.adapters.authenticate(request)),
          ),
      };
      const openingGateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller: f.controller,
        adapters,
        now: f.now,
      });
      const opening = yield* openingGateway
        .open({ hostname: f.routeA.hostname, headers: f.alice })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(authenticationStarted);
      yield* f.controller.stop(f.a.target.sessionId, f.a.ownerIdentity);

      const offlineGateway = yield* makePreviewGateway({
        domain: "",
        controller: f.controller,
        now: f.now,
      });
      yield* offlineGateway.cleanupSession(f.a.target.sessionId, f.a.ownerIdentity);
      yield* Deferred.succeed(releaseAuthentication, undefined);
      const openingExit = yield* Fiber.join(opening);
      const channels = yield* f.sql`SELECT channel_id FROM preview_gateway_channels
        WHERE session_id=${f.a.target.sessionId}`;
      const routes = yield* f.sql`SELECT removed FROM preview_gateway_routes
        WHERE session_id=${f.a.target.sessionId}`;
      expect({
        openFailed: Exit.isFailure(openingExit),
        channelCount: channels.length,
        removedRoutes: routes.map((row) => row.removed),
      }).toEqual({ openFailed: true, channelCount: 0, removedRoutes: [1] });
    }),
  ),
);

it.effect("keeps an opening channel fence when adapterless cleanup follows registration", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const route = f.routeA;
      yield* f.gateway.grant(route.hostname, f.a.ownerIdentity, "opening-row-guest", true);
      yield* f.sql`INSERT INTO preview_gateway_dependency_routes
        (session_id, role, group_id, target, removed)
        VALUES (${f.a.target.sessionId}, ${f.a.target.role}, 'auth', '{}', 0)`;
      const channelConnectStarted = yield* Deferred.make<void>();
      const releaseChannelConnect = yield* Deferred.make<void>();
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        connectChannel: (identity) =>
          Deferred.succeed(channelConnectStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseChannelConnect)),
            Effect.andThen(f.adapters.connectChannel(identity)),
          ),
      };
      const openingGateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller: f.controller,
        adapters,
        now: f.now,
      });
      const callerScope = yield* Scope.make();
      const opening = yield* openingGateway
        .open({ hostname: route.hostname, headers: f.alice })
        .pipe(Effect.provideService(Scope.Scope, callerScope), Effect.exit, Effect.forkChild);
      yield* Deferred.await(channelConnectStarted);

      const openingRows = yield* f.sql`SELECT channel_id, state FROM preview_gateway_channels
        WHERE session_id=${f.a.target.sessionId}`;
      expect(openingRows).toHaveLength(1);
      expect(openingRows[0]?.state).toBe("opening");
      yield* f.controller.stop(f.a.target.sessionId, f.a.ownerIdentity);
      const offlineGateway = yield* makePreviewGateway({
        domain: "",
        controller: f.controller,
        now: f.now,
      });
      const cleanupBeforeRelease = yield* Effect.exit(
        offlineGateway.cleanupSession(f.a.target.sessionId, f.a.ownerIdentity),
      );
      expect(Exit.isFailure(cleanupBeforeRelease)).toBe(true);
      const openingRowsAfterFailedCleanup =
        yield* f.sql`SELECT channel_id, state FROM preview_gateway_channels
        WHERE session_id=${f.a.target.sessionId}`;
      expect(openingRowsAfterFailedCleanup).toEqual(openingRows);
      const routeBeforeRelease = yield* f.sql`SELECT removed FROM preview_gateway_routes
        WHERE hostname=${route.hostname}`;
      const grantsBeforeRelease = yield* f.sql`SELECT user_id FROM preview_gateway_grants
        WHERE hostname=${route.hostname}`;
      const dependenciesBeforeRelease =
        yield* f.sql`SELECT group_id FROM preview_gateway_dependency_routes
        WHERE session_id=${f.a.target.sessionId} AND role=${f.a.target.role}`;

      yield* Deferred.succeed(releaseChannelConnect, undefined);
      const openingExit = yield* Fiber.join(opening);
      const callerScopeExit = yield* Effect.exit(Scope.close(callerScope, Exit.void));
      const cleanupAfterClose = yield* Effect.exit(
        offlineGateway.cleanupSession(f.a.target.sessionId, f.a.ownerIdentity),
      );
      const channelsAfterClose = yield* f.sql`SELECT channel_id FROM preview_gateway_channels
        WHERE session_id=${f.a.target.sessionId}`;
      const routesAfterClose = yield* f.sql`SELECT removed FROM preview_gateway_routes
        WHERE session_id=${f.a.target.sessionId}`;

      expect({
        openingStateBeforeCleanup: openingRows.map((row) => row.state),
        cleanupBlocked: Exit.isFailure(cleanupBeforeRelease),
        routeRemovedBeforeRelease: routeBeforeRelease[0]?.removed,
        grantsBeforeRelease: grantsBeforeRelease.map((row) => row.user_id),
        dependenciesBeforeRelease: dependenciesBeforeRelease.map((row) => row.group_id),
        openFailedAfterStop: Exit.isFailure(openingExit),
        callerScopeClosed: Exit.isSuccess(callerScopeExit),
        cleanupSucceededAfterChannelClose: Exit.isSuccess(cleanupAfterClose),
        channelsAfterClose: channelsAfterClose.length,
        routeRemovedAfterClose: routesAfterClose.map((row) => row.removed),
      }).toEqual({
        openingStateBeforeCleanup: ["opening"],
        cleanupBlocked: true,
        routeRemovedBeforeRelease: 0,
        grantsBeforeRelease: ["opening-row-guest"],
        dependenciesBeforeRelease: ["auth"],
        openFailedAfterStop: true,
        callerScopeClosed: true,
        cleanupSucceededAfterChannelClose: true,
        channelsAfterClose: 0,
        routeRemovedAfterClose: [1],
      });
    }),
  ),
);

it.effect("retains timeout and defect causes from parallel gateway channel closes", () =>
  Effect.gen(function* () {
    const timeout = new PreviewGatewayError({ reason: "unavailable" });
    const adapterDefect = new Error("parallel-channel-close-defect");
    const exit = yield* Effect.exit(
      closePreviewGatewayFences([Effect.fail(timeout), Effect.die(adapterDefect)]),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons).toHaveLength(2);
      expect(
        exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error === timeout),
      ).toBe(true);
      expect(
        exit.cause.reasons.some(
          (reason) => Cause.isDieReason(reason) && reason.defect === adapterDefect,
        ),
      ).toBe(true);
    }
  }),
);

it.effect("runs the bounded gateway fence before an acquireRelease adapter finalizer", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const controller = { ...f.controller, watchFences: () => Effect.void };
      const session = yield* f.createSession("acquireRelease-finalizer-order");
      const route = yield* f.gateway.register(session.target, session.ownerIdentity);
      const authorization = f.token(
        "acquireRelease-finalizer-order-token",
        session.target,
        "acquireRelease-finalizer-order",
      );
      const closeStarted = yield* Deferred.make<void>();
      const releaseClose = yield* Deferred.make<void>();
      let closeAttempts = 0;
      let recoveryAttempts = 0;
      let remoteAbsent = false;
      let fenced = false;
      let scopeCloseCompleted = false;
      const connectedIdentities: PreviewGatewayChannelIdentity[] = [];
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        connectChannel: (channel) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              connectedIdentities.push(channel);
              return {
                identity: channel.target,
                connected: Effect.succeed(true),
                http: () => Effect.succeed(`probe:${channel.target.sessionId}`),
                socket: Effect.fail(bad()),
                close: Effect.suspend(() => {
                  closeAttempts += 1;
                  return remoteAbsent
                    ? Effect.void
                    : Deferred.succeed(closeStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseClose)),
                      );
                }),
              };
            }),
            (connection) => connection.close.pipe(Effect.orDie),
          ),
        recoverChannel: (channel) =>
          Effect.gen(function* () {
            recoveryAttempts += 1;
            expect(channel).toEqual(connectedIdentities[0]);
            remoteAbsent = true;
            yield* Deferred.succeed(releaseClose, undefined);
            return recoveryProof(channel);
          }),
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters,
        now: f.now,
      });
      const callerScope = yield* Scope.make();
      const admission = yield* gateway
        .open({ hostname: route.hostname, headers: authorization })
        .pipe(Effect.provideService(Scope.Scope, callerScope));
      const scopeClose = yield* Scope.close(callerScope, Exit.void).pipe(
        Effect.exit,
        Effect.tap(() => Effect.sync(() => (scopeCloseCompleted = true))),
        Effect.forkChild,
      );
      const started = yield* Deferred.await(closeStarted).pipe(
        Effect.timeoutOption(Duration.seconds(1)),
      );
      expect(started._tag).toBe("Some");
      if (started._tag === "None") return;
      const fenceObserver = yield* admission.fenced.pipe(
        Effect.tap(() => Effect.sync(() => (fenced = true))),
        Effect.forkChild,
      );

      yield* TestClock.adjust(Duration.seconds(5));
      const beforeAdapterRelease = { recoveryAttempts, scopeCloseCompleted, fenced };
      yield* Deferred.succeed(releaseClose, undefined);
      const scopeExit = yield* Fiber.join(scopeClose);
      yield* Fiber.join(fenceObserver);
      const rows =
        yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;

      expect(Exit.isSuccess(scopeExit)).toBe(true);
      expect(beforeAdapterRelease).toEqual({
        recoveryAttempts: 1,
        scopeCloseCompleted: true,
        fenced: true,
      });
      expect(closeAttempts).toBe(2);
      expect(rows).toHaveLength(0);
    }),
  ),
);

it.effect("retains an acquireRelease channel after unknown scoped cleanup for exact retry", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const controller = { ...f.controller, watchFences: () => Effect.void };
      const session = yield* f.createSession("unknown-scope-cleanup-retry");
      const route = yield* f.gateway.register(session.target, session.ownerIdentity);
      const authorization = f.token(
        "unknown-scope-cleanup-retry-token",
        session.target,
        "unknown-scope-cleanup-retry",
      );
      let recoveryAvailable = false;
      let closeAttempts = 0;
      let recoveryAttempts = 0;
      const connectedIdentities: PreviewGatewayChannelIdentity[] = [];
      let closeBehavior: () => Effect.Effect<void, PreviewGatewayError> = () => Effect.fail(bad());
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        connectChannel: (channel) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              connectedIdentities.push(channel);
              return {
                identity: channel.target,
                connected: Effect.succeed(true),
                http: () => Effect.succeed(`probe:${channel.target.sessionId}`),
                socket: Effect.fail(bad()),
                close: Effect.suspend(() => {
                  closeAttempts += 1;
                  return closeBehavior();
                }),
              };
            }),
            (connection) => connection.close.pipe(Effect.orDie),
          ),
        recoverChannel: (channel) =>
          Effect.suspend(() => {
            recoveryAttempts += 1;
            expect(channel).toEqual(connectedIdentities[0]);
            return recoveryAvailable ? Effect.succeed(recoveryProof(channel)) : Effect.fail(bad());
          }),
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters,
        now: f.now,
      });
      const callerScope = yield* Scope.make();
      const admission = yield* gateway
        .open({ hostname: route.hostname, headers: authorization })
        .pipe(Effect.provideService(Scope.Scope, callerScope));
      yield* controller.stop(session.target.sessionId, session.ownerIdentity);

      const firstScopeClose = yield* Effect.exit(Scope.close(callerScope, Exit.void));
      const retainedRows =
        yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      expect({
        scopeCloseFailed: Exit.isFailure(firstScopeClose),
        recoveryAttempts,
        retainedRows: retainedRows.length,
        fenced: yield* Effect.exit(admission.fenced),
      }).toMatchObject({ scopeCloseFailed: true, recoveryAttempts: 1, retainedRows: 1 });

      recoveryAvailable = true;
      closeBehavior = () => Effect.void;
      yield* gateway.cleanupSession(session.target.sessionId, session.ownerIdentity);
      const remainingRows =
        yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;

      expect({
        closeAttempts,
        recoveryAttempts,
        remainingRows: remainingRows.length,
        recoveredIdentity: connectedIdentities[0],
      }).toEqual({
        closeAttempts: 3,
        recoveryAttempts: 2,
        remainingRows: 0,
        recoveredIdentity: expect.any(Object),
      });
    }),
  ),
);

it.effect("coordinates owner cleanup with caller Scope.close on one tracked channel", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const controller = { ...f.controller, watchFences: () => Effect.void };
      const session = yield* f.createSession("scope-close-cleanup-race");
      const route = yield* f.gateway.register(session.target, session.ownerIdentity);
      const authorization = f.token(
        "scope-close-cleanup-race-token",
        session.target,
        "scope-close-cleanup-race",
      );
      const closeStarted = yield* Deferred.make<void>();
      const releaseClose = yield* Deferred.make<void>();
      let remoteAbsent = false;
      let closeAttempts = 0;
      let recoveryAttempts = 0;
      const connectedIdentities: PreviewGatewayChannelIdentity[] = [];
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        connectChannel: (channel) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              connectedIdentities.push(channel);
              return {
                identity: channel.target,
                connected: Effect.succeed(true),
                http: () => Effect.succeed(`probe:${channel.target.sessionId}`),
                socket: Effect.fail(bad()),
                close: Effect.suspend(() => {
                  closeAttempts += 1;
                  return remoteAbsent
                    ? Effect.void
                    : Deferred.succeed(closeStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseClose)),
                      );
                }),
              };
            }),
            (connection) => connection.close.pipe(Effect.orDie),
          ),
        recoverChannel: (channel) =>
          Effect.gen(function* () {
            recoveryAttempts += 1;
            expect(channel).toEqual(connectedIdentities[0]);
            remoteAbsent = true;
            yield* Deferred.succeed(releaseClose, undefined);
            return recoveryProof(channel);
          }),
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters,
        now: f.now,
      });
      const callerScope = yield* Scope.make();
      yield* gateway
        .open({ hostname: route.hostname, headers: authorization })
        .pipe(Effect.provideService(Scope.Scope, callerScope));
      yield* controller.stop(session.target.sessionId, session.ownerIdentity);

      const scopeClose = yield* Scope.close(callerScope, Exit.void).pipe(
        Effect.exit,
        Effect.forkChild,
      );
      const started = yield* Deferred.await(closeStarted).pipe(
        Effect.timeoutOption(Duration.seconds(1)),
      );
      expect(started._tag).toBe("Some");
      if (started._tag === "None") return;
      const ownerCleanup = yield* gateway
        .cleanupSession(session.target.sessionId, session.ownerIdentity)
        .pipe(Effect.exit, Effect.forkChild);

      yield* TestClock.adjust(Duration.millis(2_500));
      const [scopeExit, cleanupExit] = yield* Effect.all([
        Fiber.join(scopeClose),
        Fiber.join(ownerCleanup),
      ] as const);
      const remainingRows =
        yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;

      expect({
        scopeSucceeded: Exit.isSuccess(scopeExit),
        cleanupSucceeded: Exit.isSuccess(cleanupExit),
        recoveryAttempts,
        remainingRows: remainingRows.length,
      }).toEqual({
        scopeSucceeded: true,
        cleanupSucceeded: true,
        recoveryAttempts: 1,
        remainingRows: 0,
      });
    }),
  ),
);

it.effect("preserves the close defect when exact recovery reaches the fence deadline", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const controller = { ...f.controller, watchFences: () => Effect.void };
      const session = yield* f.createSession("recovery-deadline-cause");
      const route = yield* f.gateway.register(session.target, session.ownerIdentity);
      const authorization = f.token(
        "recovery-deadline-cause-token",
        session.target,
        "recovery-deadline-cause",
      );
      const closeDefect = new Error("tracked-close-before-stalled-recovery");
      const recoveryStarted = yield* Deferred.make<void>();
      const releaseRecovery = yield* Deferred.make<void>();
      let recoveryAvailable = false;
      let recoveryAttempts = 0;
      let closeAttempts = 0;
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        connectChannel: (channel) =>
          Effect.sync(() => ({
            identity: channel.target,
            connected: Effect.succeed(true),
            http: () => Effect.succeed(`probe:${channel.target.sessionId}`),
            socket: Effect.fail(bad()),
            close: Effect.suspend(() => {
              closeAttempts += 1;
              return Effect.die(closeDefect);
            }),
          })),
        recoverChannel: (channel) =>
          Effect.suspend(() => {
            recoveryAttempts += 1;
            if (recoveryAvailable) return Effect.succeed(recoveryProof(channel));
            return Deferred.succeed(recoveryStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRecovery)),
              Effect.andThen(Effect.succeed(recoveryProof(channel))),
            );
          }),
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters,
        now: f.now,
      });
      yield* gateway.open({ hostname: route.hostname, headers: authorization });
      yield* controller.stop(session.target.sessionId, session.ownerIdentity);
      const cleanupFiber = yield* gateway
        .cleanupSession(session.target.sessionId, session.ownerIdentity)
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(recoveryStarted);
      yield* TestClock.adjust(Duration.seconds(5));

      const timedOutFiberExit = cleanupFiber.pollUnsafe();
      const timedOutPublicExit =
        timedOutFiberExit !== undefined && Exit.isSuccess(timedOutFiberExit)
          ? timedOutFiberExit.value
          : undefined;
      const retainedRows =
        yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      yield* Deferred.succeed(releaseRecovery, undefined);
      yield* Fiber.join(cleanupFiber);
      recoveryAvailable = true;
      yield* gateway.cleanupSession(session.target.sessionId, session.ownerIdentity);
      const remainingRows =
        yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      const timedOutReasons =
        timedOutPublicExit !== undefined && Exit.isFailure(timedOutPublicExit)
          ? timedOutPublicExit.cause.reasons
          : [];
      const timedOutCause =
        timedOutPublicExit !== undefined && Exit.isFailure(timedOutPublicExit)
          ? Cause.pretty(timedOutPublicExit.cause)
          : "no timed-out cause captured";

      expect({
        timedOut: timedOutPublicExit !== undefined && Exit.isFailure(timedOutPublicExit),
        preservedCloseDefect: timedOutReasons.some(
          (reason) => Cause.isDieReason(reason) && reason.defect === closeDefect,
        ),
        closeAttempts,
        timedOutCause,
        retainedRows: retainedRows.length,
        remainingRows: remainingRows.length,
      }).toEqual({
        timedOut: true,
        preservedCloseDefect: true,
        closeAttempts: 2,
        timedOutCause: expect.stringContaining(closeDefect.message),
        retainedRows: 1,
        remainingRows: 0,
      });
      expect(recoveryAttempts).toBeGreaterThanOrEqual(2);
    }),
  ),
);

it.effect("preserves the typed close failure when exact recovery reaches the fence deadline", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const controller = { ...f.controller, watchFences: () => Effect.void };
      const session = yield* f.createSession("typed-recovery-deadline-cause");
      const route = yield* f.gateway.register(session.target, session.ownerIdentity);
      const authorization = f.token(
        "typed-recovery-deadline-cause-token",
        session.target,
        "typed-recovery-deadline-cause",
      );
      const closeFailure = new PreviewGatewayError({ reason: "identity-mismatch" });
      const recoveryStarted = yield* Deferred.make<void>();
      const releaseRecovery = yield* Deferred.make<void>();
      let recoveryAvailable = false;
      let recoveryAttempts = 0;
      let closeAttempts = 0;
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        connectChannel: (channel) =>
          Effect.sync(() => ({
            identity: channel.target,
            connected: Effect.succeed(true),
            http: () => Effect.succeed(`probe:${channel.target.sessionId}`),
            socket: Effect.fail(bad()),
            close: Effect.suspend(() => {
              closeAttempts += 1;
              return Effect.fail(closeFailure);
            }),
          })),
        recoverChannel: (channel) =>
          Effect.suspend(() => {
            recoveryAttempts += 1;
            if (recoveryAvailable) return Effect.succeed(recoveryProof(channel));
            return Deferred.succeed(recoveryStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRecovery)),
              Effect.andThen(Effect.succeed(recoveryProof(channel))),
            );
          }),
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters,
        now: f.now,
      });
      yield* gateway.open({ hostname: route.hostname, headers: authorization });
      yield* controller.stop(session.target.sessionId, session.ownerIdentity);
      const cleanupFiber = yield* gateway
        .cleanupSession(session.target.sessionId, session.ownerIdentity)
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(recoveryStarted);
      yield* TestClock.adjust(Duration.seconds(5));

      const timedOutFiberExit = cleanupFiber.pollUnsafe();
      const timedOutPublicExit =
        timedOutFiberExit !== undefined && Exit.isSuccess(timedOutFiberExit)
          ? timedOutFiberExit.value
          : undefined;
      const retainedRows =
        yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      yield* Deferred.succeed(releaseRecovery, undefined);
      yield* Fiber.join(cleanupFiber);
      recoveryAvailable = true;
      yield* gateway.cleanupSession(session.target.sessionId, session.ownerIdentity);
      const remainingRows =
        yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
      const timedOutReasons =
        timedOutPublicExit !== undefined && Exit.isFailure(timedOutPublicExit)
          ? timedOutPublicExit.cause.reasons
          : [];
      expect({
        timedOut: timedOutPublicExit !== undefined && Exit.isFailure(timedOutPublicExit),
        preservedCloseFailure: timedOutReasons.some(
          (reason) => Cause.isFailReason(reason) && reason.error === closeFailure,
        ),
        closeAttempts,
        retainedRows: retainedRows.length,
        remainingRows: remainingRows.length,
      }).toEqual({
        timedOut: true,
        preservedCloseFailure: true,
        closeAttempts: 2,
        retainedRows: 1,
        remainingRows: 0,
      });
      expect(recoveryAttempts).toBeGreaterThanOrEqual(2);
    }),
  ),
);

it.effect(
  "returns by the public close deadline without joining uninterruptible recovery cleanup",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const controller = { ...f.controller, watchFences: () => Effect.void };
        const session = yield* f.createSession("uninterruptible-recovery-finalizer");
        const route = yield* f.gateway.register(session.target, session.ownerIdentity);
        const authorization = f.token(
          "uninterruptible-recovery-finalizer-token",
          session.target,
          "uninterruptible-recovery-finalizer",
        );
        const recoveryStarted = yield* Deferred.make<void>();
        const releaseRecovery = yield* Deferred.make<void>();
        const closeFailure = new PreviewGatewayError({ reason: "identity-mismatch" });
        const adapters: PreviewGatewayAdapters = {
          ...f.adapters,
          connectChannel: (channel) =>
            Effect.succeed({
              identity: channel.target,
              connected: Effect.succeed(true),
              http: () => Effect.succeed(`probe:${channel.target.sessionId}`),
              socket: Effect.fail(bad()),
              close: Effect.fail(closeFailure),
            }),
          recoverChannel: (channel) =>
            Effect.uninterruptible(
              Deferred.succeed(recoveryStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRecovery)),
                Effect.andThen(Effect.succeed(recoveryProof(channel))),
              ),
            ),
        };
        const gateway = yield* makePreviewGateway({
          domain: "dev.example.test",
          controller,
          adapters,
          now: f.now,
        });
        yield* gateway.open({ hostname: route.hostname, headers: authorization });
        yield* controller.stop(session.target.sessionId, session.ownerIdentity);

        const cleanup = yield* gateway
          .cleanupSession(session.target.sessionId, session.ownerIdentity)
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(recoveryStarted);
        const advanceClock = yield* TestClock.adjust(Duration.seconds(5)).pipe(Effect.forkChild);
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
        const completedByDeadline = cleanup.pollUnsafe() !== undefined;
        const rowsAtDeadline =
          yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;

        // Release the deliberately uninterruptible adapter wait so this red control terminates.
        yield* Deferred.succeed(releaseRecovery, undefined);
        yield* Fiber.join(advanceClock);
        const cleanupExit = yield* Fiber.join(cleanup);
        const remainingRows =
          yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;

        expect(completedByDeadline).toBe(true);
        expect(rowsAtDeadline).toHaveLength(1);
        expect(Exit.isFailure(cleanupExit)).toBe(true);
        expect(remainingRows).toHaveLength(1);
      }),
    ),
);

it.effect(
  "bounds caller Scope.close around an uninterruptible acquireRelease close finalizer",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const controller = { ...f.controller, watchFences: () => Effect.void };
        const session = yield* f.createSession("uninterruptible-acquire-release-finalizer");
        const route = yield* f.gateway.register(session.target, session.ownerIdentity);
        const authorization = f.token(
          "uninterruptible-acquire-release-finalizer-token",
          session.target,
          "uninterruptible-acquire-release-finalizer",
        );
        const finalizerStarted = yield* Deferred.make<void>();
        const releaseFinalizer = yield* Deferred.make<void>();
        const finalizerCompleted = yield* Deferred.make<void>();
        let closeAttempts = 0;
        let recoveryAttempts = 0;
        const connectedIdentities: PreviewGatewayChannelIdentity[] = [];
        const recoveredIdentities: PreviewGatewayChannelIdentity[] = [];
        const adapters: PreviewGatewayAdapters = {
          ...f.adapters,
          connectChannel: (channel) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                connectedIdentities.push(channel);
                return {
                  identity: channel.target,
                  connected: Effect.succeed(true),
                  http: () => Effect.succeed(`probe:${channel.target.sessionId}`),
                  socket: Effect.fail(bad()),
                  close: Effect.sync(() => {
                    closeAttempts += 1;
                  }),
                };
              }),
              (connection) =>
                connection.close.pipe(
                  Effect.andThen(
                    Effect.uninterruptible(
                      Deferred.succeed(finalizerStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseFinalizer)),
                        Effect.andThen(Deferred.succeed(finalizerCompleted, undefined)),
                      ),
                    ),
                  ),
                ),
            ),
          recoverChannel: (channel) =>
            Effect.gen(function* () {
              recoveryAttempts += 1;
              recoveredIdentities.push(channel);
              expect(channel).toEqual(connectedIdentities[0]);
              const retainedBeforeProof =
                yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE channel_id=${channel.channelId}`.pipe(
                  Effect.mapError(() => bad()),
                );
              expect(retainedBeforeProof).toHaveLength(1);
              return recoveryProof(channel);
            }),
        };
        const gateway = yield* makePreviewGateway({
          domain: "dev.example.test",
          controller,
          adapters,
          now: f.now,
        });
        const callerScope = yield* Scope.make();
        const admission = yield* gateway
          .open({ hostname: route.hostname, headers: authorization })
          .pipe(Effect.provideService(Scope.Scope, callerScope));
        yield* controller.stop(session.target.sessionId, session.ownerIdentity);

        const attemptStartedAt = f.now();
        const scopeClose = yield* Scope.close(callerScope, Exit.void).pipe(
          Effect.exit,
          Effect.forkChild,
        );
        yield* Deferred.await(finalizerStarted);
        const advanceClock = yield* TestClock.adjust(Duration.seconds(5)).pipe(Effect.forkChild);
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
        const elapsedAtDeadline = f.now() - attemptStartedAt;
        const completedByDeadline = scopeClose.pollUnsafe() !== undefined;
        const rowsAtDeadline =
          yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;
        const finalizerStillRunning = !(yield* Deferred.isDone(finalizerCompleted));

        // Drain the intentionally uninterruptible acquireRelease finalizer after measuring the fence.
        yield* Deferred.succeed(releaseFinalizer, undefined);
        yield* Fiber.join(advanceClock);
        const scopeCloseExit = yield* Fiber.join(scopeClose);
        yield* Deferred.await(finalizerCompleted);
        const rowsAfterScopeClose =
          yield* f.sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${session.target.sessionId}`;

        expect(elapsedAtDeadline).toBeGreaterThanOrEqual(5_000);
        expect(completedByDeadline).toBe(true);
        expect(finalizerStillRunning).toBe(true);
        expect(recoveryAttempts).toBe(1);
        expect(recoveredIdentities).toEqual([connectedIdentities[0]]);
        expect(rowsAtDeadline).toHaveLength(0);
        expect(Exit.isSuccess(scopeCloseExit)).toBe(true);
        expect(rowsAfterScopeClose).toHaveLength(0);
        expect((yield* Effect.exit(admission.fenced))._tag).toBe("Success");
        expect(closeAttempts).toBe(2);
      }),
    ),
);

it.effect("bounds a stalled scoped close finalizer and retains its retry record", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const controller = {
        ...f.controller,
        watchFences: () => Effect.void,
      };
      const session = yield* f.createSession("scope-finalizer-timeout");
      const route = yield* f.gateway.register(session.target, session.ownerIdentity);
      const authorization = f.token(
        "scope-finalizer-timeout-token",
        session.target,
        "scope-finalizer-timeout",
      );
      const closeStarted = yield* Deferred.make<void>();
      let closeAttempts = 0;
      let recoveryAvailable = false;
      let recoveryAttempts = 0;
      const connectedIdentities: PreviewGatewayChannelIdentity[] = [];
      const recoveredIdentities: PreviewGatewayChannelIdentity[] = [];
      let closeBehavior: (sessionId: string) => Effect.Effect<void> = () => Effect.die(bad());
      const adapters: PreviewGatewayAdapters = {
        ...f.adapters,
        connectChannel: (channel) =>
          Effect.sync(() => {
            connectedIdentities.push(channel);
            return {
              identity: channel.target,
              connected: Effect.succeed(true),
              http: () => Effect.succeed(`probe:${channel.target.sessionId}`),
              socket: Effect.fail(bad()),
              close: Effect.suspend(() => {
                closeAttempts += 1;
                return closeBehavior(channel.target.sessionId);
              }),
            };
          }),
        recoverChannel: (channel) =>
          Effect.suspend(() => {
            recoveryAttempts += 1;
            recoveredIdentities.push(channel);
            return recoveryAvailable ? Effect.succeed(recoveryProof(channel)) : Effect.fail(bad());
          }),
      };
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller,
        adapters,
        now: f.now,
      });
      let fenced: Effect.Effect<void> | undefined;
      let lateFrame: Effect.Effect<string, PreviewGatewayError> | undefined;
      closeBehavior = () =>
        Deferred.succeed(closeStarted, undefined).pipe(Effect.andThen(Effect.never));
      const scopeFiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* gateway.open({
            hostname: route.hostname,
            headers: authorization,
          });
          fenced = connection.fenced;
          lateFrame = connection.guard(Effect.succeed("late frame"));
        }),
      ).pipe(Effect.exit, Effect.forkChild);
      const started = yield* Deferred.await(closeStarted).pipe(
        Effect.timeoutOption(Duration.seconds(1)),
      );
      expect(started._tag).toBe("Some");
      if (started._tag === "None") return;
      yield* TestClock.adjust(Duration.seconds(5));
      const scopeExit = yield* Fiber.join(scopeFiber);

      expect(scopeExit._tag).toBe("Failure");
      expect(closeAttempts).toBe(1);
      expect(recoveryAttempts).toBe(1);
      expect(fenced).toBeDefined();
      expect(lateFrame).toBeDefined();
      if (fenced === undefined || lateFrame === undefined) return;
      yield* fenced;
      closeBehavior = () => Effect.die(bad());
      expect((yield* Effect.exit(lateFrame))._tag).toBe("Failure");
      expect(closeAttempts).toBe(2);
      expect(recoveryAttempts).toBe(2);

      yield* controller.stop(session.target.sessionId, session.ownerIdentity);
      recoveryAvailable = true;
      closeBehavior = () =>
        Deferred.succeed(closeStarted, undefined).pipe(Effect.andThen(Effect.never));
      const retryStartedAt = f.now();
      const retry = yield* gateway
        .cleanupSession(session.target.sessionId, session.ownerIdentity)
        .pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(2_500));
      const retryExit = yield* Fiber.join(retry);
      expect(Exit.isSuccess(retryExit)).toBe(true);
      expect(closeAttempts).toBe(3);
      expect(recoveryAttempts).toBe(3);
      expect(recoveredIdentities).toEqual([
        connectedIdentities[0],
        connectedIdentities[0],
        connectedIdentities[0],
      ]);
      expect(f.now() - retryStartedAt).toBeLessThanOrEqual(5_000);
    }),
  ),
);

it.effect("starts each queued close deadline when its fence is invoked", () =>
  Effect.gen(function* () {
    const baseClock = yield* Clock.Clock;
    let virtualTime = 0;
    let closeTimeoutsReleased = false;
    let closeTimeoutSleeps = 0;
    const releaseCloseTimeouts = yield* Deferred.make<void>();
    const closeTimeoutClock: Clock.Clock = {
      ...baseClock,
      sleep: (duration) =>
        Duration.toMillis(duration) === 5_000
          ? Effect.suspend(() => {
              closeTimeoutSleeps += 1;
              return closeTimeoutsReleased
                ? Effect.sync(() => (virtualTime += 5_000)).pipe(Effect.asVoid)
                : Deferred.await(releaseCloseTimeouts);
            })
          : baseClock.sleep(duration),
    };
    const closeStarted = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const fence = makeRetryableConnectionFence(
      () => Deferred.succeed(closeStarted, undefined).pipe(Effect.andThen(Effect.never)),
      closed,
      () => Effect.fail(bad()),
    );
    const firstFence = yield* Effect.forkChild(
      fence.pipe(Effect.provideService(Clock.Clock, closeTimeoutClock)),
    );
    yield* Deferred.await(closeStarted);
    const secondFence = yield* Effect.forkChild(
      fence.pipe(Effect.provideService(Clock.Clock, closeTimeoutClock)),
    );
    const finalizerInvokedAt = virtualTime;
    let finalizerCompletedAt: number | undefined;
    const finalizer = yield* fence.pipe(
      Effect.provideService(Clock.Clock, closeTimeoutClock),
      Effect.exit,
      Effect.tap(() => Effect.sync(() => (finalizerCompletedAt = virtualTime))),
      Effect.forkChild,
    );
    for (let attempt = 0; attempt < 20; attempt++) yield* Effect.yieldNow;
    const timeoutSleepsAtInvocation = closeTimeoutSleeps;

    virtualTime += 5_000;
    closeTimeoutsReleased = true;
    yield* Deferred.succeed(releaseCloseTimeouts, undefined);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        firstFence.pollUnsafe() !== undefined &&
        secondFence.pollUnsafe() !== undefined &&
        finalizer.pollUnsafe() !== undefined
      )
        break;
      yield* Effect.yieldNow;
    }
    const finalizerExit = yield* Fiber.join(finalizer);
    yield* Fiber.await(firstFence);
    yield* Fiber.await(secondFence);

    expect(finalizerExit._tag).toBe("Failure");
    if (finalizerExit._tag === "Failure") {
      const typedError = Cause.findErrorOption(finalizerExit.cause);
      expect(typedError._tag).toBe("Some");
      if (typedError._tag === "Some") expect(typedError.value).toBeInstanceOf(PreviewGatewayError);
    }
    expect(timeoutSleepsAtInvocation).toBeGreaterThanOrEqual(3);
    expect(finalizerCompletedAt).toBeDefined();
    if (finalizerCompletedAt !== undefined)
      expect(finalizerCompletedAt - finalizerInvokedAt).toBeLessThanOrEqual(5_000);
  }),
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

it.effect("preserves mixed gateway causes through HTTP error mapping", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const gatewayFailure = new PreviewGatewayError({ reason: "unavailable" });
      const adapterDefect = new Error("http-adapter-close-defect");
      const gateway: PreviewGatewayApi = {
        ...f.gateway,
        open: () =>
          Effect.failCause(Cause.combine(Cause.fail(gatewayFailure), Cause.die(adapterDefect))),
      };
      const handler = yield* HttpRouter.toHttpEffect(
        PreviewGatewayHttpRoutes(gateway).pipe(Layer.provide(HttpRouter.layer)),
      );
      const exit = yield* Effect.exit(
        handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`https://${f.routeA.hostname}/_preview/probe`, {
                headers: {
                  ...f.alice,
                  host: f.routeA.hostname,
                  origin: `https://${f.routeA.hostname}`,
                },
              }),
            ),
          ),
        ),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isFailReason(reason) && reason.error === gatewayFailure,
          ),
        ).toBe(true);
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect === adapterDefect,
          ),
        ).toBe(true);
      }
    }),
  ),
);

it.effect("maps only the pure legacy unavailable timeout at the HTTP boundary", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      let openBehavior: () => Effect.Effect<never> = () =>
        Effect.die(new PreviewGatewayError({ reason: "unavailable" }));
      const gateway: PreviewGatewayApi = {
        ...f.gateway,
        open: () => openBehavior(),
      };
      const handler = yield* HttpRouter.toHttpEffect(
        PreviewGatewayHttpRoutes(gateway).pipe(Layer.provide(HttpRouter.layer)),
      );
      const request = () =>
        handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`https://${f.routeA.hostname}/_preview/probe`, {
                headers: {
                  ...f.alice,
                  host: f.routeA.hostname,
                  origin: `https://${f.routeA.hostname}`,
                },
              }),
            ),
          ),
        );
      const legacyExit = yield* Effect.exit(request());
      expect(legacyExit._tag).toBe("Success");
      if (legacyExit._tag === "Success") expect(legacyExit.value.status).toBe(503);

      const unrelatedDefect = new PreviewGatewayError({ reason: "identity-mismatch" });
      openBehavior = () => Effect.die(unrelatedDefect);
      const unrelatedExit = yield* Effect.exit(request());
      expect(unrelatedExit._tag).toBe("Failure");
      if (unrelatedExit._tag === "Failure") {
        const defect = Cause.findDefect(unrelatedExit.cause);
        expect(defect._tag).toBe("Success");
        if (defect._tag === "Success") expect(defect.success).toBe(unrelatedDefect);
      }
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

it.effect(
  "probes producer API readiness through the published session route without admitting workflow work",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const created = yield* f.createSession(
          "workflow-api-readiness-owner",
          "application",
          "sheet-workflows-api",
        );
        const digest = (character: string) => `sha256:${character.repeat(64)}`;
        const group: PreviewSharedWorkflowGroup = {
          sessionId: created.session.id,
          generation: created.session.generation,
          groupId: "workflow-execution",
          endpoint: "https://workflows.dev.tiara-stack.moe",
          databaseEndpointIdentity: digest("d"),
          stateIdentity: "workflow-state-dev",
          deployedManifestDigest: digest("a"),
          schemaArtifactDigest: digest("b"),
          apiArtifactDigest: digest("c"),
          workflowContractCatalogDigest: digest("e"),
        };
        const session = {
          ...created.session,
          resources: {
            "preview-relay-service-sheet-workflows-api": created.target.serviceResourceId,
            "preview-relay-attachment-sheet-workflows-api": created.target.attachmentResourceId,
          },
        };
        const target: PreviewGatewayTarget = {
          ...created.target,
          stateGroup: "workflow-execution",
          artifactDigest: group.apiArtifactDigest,
          catalogDigest: group.workflowContractCatalogDigest,
        };
        const applicationRoute = makePreviewWorkflowApiApplicationRoute(f.gateway);
        const origin = yield* applicationRoute.applicationOrigin({
          sessionId: session.id,
          role: "sheet-workflows-api",
        });
        const admission = makePreviewWorkflowApiWorkflowRequestRunner({
          controller: f.controller,
          group,
          oauthClientId: "workflow-api-client",
          endpoint: () => origin,
        });
        yield* applicationRoute.publish({
          session,
          ownerIdentity: created.ownerIdentity,
          revision: target.revision,
          group,
          listener: {
            role: "sheet-workflows-api",
            host: "127.0.0.1",
            port: target.port,
            processId: target.processId,
          },
          admitWorkflowRequest: admission,
        });

        const hostname = `p-${session.id}-sheet-workflows-api.dev.example.test`;
        const authorization = f.token(
          "workflow-api-readiness-token",
          target,
          "workflow-api-readiness-owner",
        );
        const handler = yield* HttpRouter.toHttpEffect(
          PreviewGatewayHttpRoutes(f.gateway).pipe(Layer.provide(HttpRouter.layer)),
        );
        const before = yield* f.control;
        const applicationObservationsBefore = f.applicationObservations.length;
        const response = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`${origin}/ready`, {
                method: "GET",
                headers: {
                  ...authorization,
                  host: hostname,
                  origin,
                  "sec-fetch-site": "same-origin",
                },
              }),
            ),
          ),
        );

        expect(response.status).toBe(200);
        expect(f.applicationObservations.at(-1)).toMatchObject({
          sessionId: session.id,
          method: "GET",
          path: "/ready",
        });
        expect(f.applicationObservations).toHaveLength(applicationObservationsBefore + 1);
        expect(yield* f.control).toEqual(before);

        yield* applicationRoute.remove({
          sessionId: session.id,
          generation: session.generation,
          ownerIdentity: created.ownerIdentity,
          expectedRevision: session.activeRevision ?? session.requestedRevision,
        });
      }),
    ),
);

it.effect(
  "rejects producer route publication when authority expires during gateway readiness preflight",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const created = yield* f.createSession(
          "workflow-api-expiring-publication-owner",
          "application",
          "sheet-workflows-api",
        );
        const digest = (character: string) => `sha256:${character.repeat(64)}`;
        const group: PreviewSharedWorkflowGroup = {
          sessionId: created.session.id,
          generation: created.session.generation,
          groupId: "workflow-execution",
          endpoint: "https://workflows.dev.tiara-stack.moe",
          databaseEndpointIdentity: digest("d"),
          stateIdentity: "workflow-state-dev",
          deployedManifestDigest: digest("a"),
          schemaArtifactDigest: digest("b"),
          apiArtifactDigest: digest("c"),
          workflowContractCatalogDigest: digest("e"),
        };
        const session = {
          ...created.session,
          resources: {
            "preview-relay-service-sheet-workflows-api": created.target.serviceResourceId,
            "preview-relay-attachment-sheet-workflows-api": created.target.attachmentResourceId,
          },
        };
        const target: PreviewGatewayTarget = {
          ...created.target,
          stateGroup: group.groupId,
          artifactDigest: group.apiArtifactDigest,
          catalogDigest: group.workflowContractCatalogDigest,
        };
        let authorityNow = f.now();
        const expiresAt = authorityNow + 1;
        const assertAuthorityCurrent = (): Effect.Effect<void, PreviewWorkflowApiHostError> =>
          authorityNow < expiresAt
            ? Effect.void
            : Effect.fail(
                new PreviewWorkflowApiHostError({ reason: "workflow-api-authority-expired" }),
              );
        const adapters: PreviewGatewayAdapters = {
          ...f.adapters,
          connect: (connectTarget) =>
            f.adapters.connect(connectTarget).pipe(
              Effect.map((connection) => {
                const applicationRequest = connection.applicationRequest;
                if (applicationRequest === undefined) return connection;
                return {
                  ...connection,
                  applicationRequest: (
                    request: Parameters<
                      NonNullable<PreviewGatewayRelayConnection["applicationRequest"]>
                    >[0],
                  ) =>
                    applicationRequest(request).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          if (request.path === "/ready") authorityNow = expiresAt;
                        }),
                      ),
                    ),
                };
              }),
            ),
        };
        const gateway = yield* makePreviewGateway({
          domain: "dev.example.test",
          controller: f.controller,
          adapters,
          now: f.now,
        });
        const route = makePreviewWorkflowApiApplicationRoute(gateway);
        const origin = yield* route.applicationOrigin({
          sessionId: session.id,
          role: "sheet-workflows-api",
        });
        const admission = makePreviewWorkflowApiWorkflowRequestRunner({
          controller: f.controller,
          group,
          oauthClientId: "workflow-api-expiring-publication-client",
          endpoint: () => origin,
          assertAuthorityCurrent,
        });
        const before = yield* f.control;
        const observationsBefore = f.applicationObservations.length;

        // The real host caller checks immediately before route publication. The common gateway
        // then spends time connecting and probing /ready before persisting its route row.
        yield* assertAuthorityCurrent();
        const publication = yield* Effect.exit(
          route.publish({
            session,
            ownerIdentity: created.ownerIdentity,
            revision: target.revision,
            group,
            listener: {
              role: "sheet-workflows-api",
              host: "127.0.0.1",
              port: target.port,
              processId: target.processId,
            },
            admitWorkflowRequest: admission,
            assertAuthorityCurrent,
          }),
        );

        expect(authorityNow).toBe(expiresAt);
        const hostname = `p-${session.id}-sheet-workflows-api.dev.example.test`;
        const rows =
          yield* f.sql`SELECT removed FROM preview_gateway_routes WHERE hostname=${hostname}`;
        expect({
          publicationRejected: Exit.isFailure(publication),
          activeRouteCount: rows.filter((row) => row.removed === 0).length,
        }).toEqual({ publicationRejected: true, activeRouteCount: 0 });
        expect(f.applicationObservations).toHaveLength(observationsBefore + 1);
        expect(yield* f.control).toEqual(before);
      }),
    ),
);

it.effect(
  "keeps the supervisor from admitting a session when authority expires during route preflight",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const owner = "workflow-api-supervisor-expiring-publication-owner";
        const created = yield* f.controller.create({
          owner,
          checkout: `/test/${owner}`,
          requestedRevision: "rev-a",
          manifests: { "sheet-workflows-api": "manifest" },
          groups: ["workflow-execution"],
          endpoints: ["https://workflows.dev.tiara-stack.moe"],
        });
        const digest = (character: string) => `sha256:${character.repeat(64)}`;
        const group: PreviewSharedWorkflowGroup = {
          sessionId: created.session.id,
          generation: created.session.generation,
          groupId: "workflow-execution",
          endpoint: "https://workflows.dev.tiara-stack.moe",
          databaseEndpointIdentity: digest("d"),
          stateIdentity: "workflow-state-dev",
          deployedManifestDigest: digest("a"),
          schemaArtifactDigest: digest("b"),
          apiArtifactDigest: digest("c"),
          workflowContractCatalogDigest: digest("e"),
        };
        const target: PreviewGatewayTarget = {
          sessionId: created.session.id,
          generation: created.session.generation,
          role: "sheet-workflows-api",
          processId: "workflow-api-expiring-publication-process",
          revision: "rev-a",
          artifactDigest: group.apiArtifactDigest,
          catalogDigest: group.workflowContractCatalogDigest,
          stateGroup: group.groupId,
          kind: "application",
          serviceFqdn: `${relayNameFor(created.session.id, "sheet-workflows-api")}.preview-relays.svc.cluster.local`,
          port: 43123,
          serviceResourceId: `service-${owner}`,
          attachmentResourceId: `attachment-${owner}`,
        };
        for (const kind of ["service", "attachment"] as const) {
          const ownerToken = `${owner}-${kind}`;
          const providerResourceId =
            kind === "service" ? target.serviceResourceId : target.attachmentResourceId;
          const reference = JSON.stringify({
            version: 1,
            kind,
            sessionId: target.sessionId,
            role: target.role,
            processId: target.processId,
            ownerTokenDigest: createHash("sha256").update(ownerToken).digest("hex").slice(0, 63),
            providerResourceId,
          });
          yield* f.sql`INSERT INTO preview_allocation_ledger VALUES (
            ${target.sessionId},
            ${`preview-relay-${kind}-${target.role}`},
            ${ownerToken},
            ${reference},
            'owned'
          )`;
        }

        let authorityNow = f.now();
        const expiresAt = authorityNow + 1;
        const assertAuthorityCurrent = (): Effect.Effect<void, PreviewWorkflowApiHostError> =>
          authorityNow < expiresAt
            ? Effect.void
            : Effect.fail(
                new PreviewWorkflowApiHostError({ reason: "workflow-api-authority-expired" }),
              );
        const adapters: PreviewGatewayAdapters = {
          ...f.adapters,
          connect: (connectTarget) =>
            f.adapters.connect(connectTarget).pipe(
              Effect.map((connection) => {
                const applicationRequest = connection.applicationRequest;
                if (applicationRequest === undefined) return connection;
                return {
                  ...connection,
                  applicationRequest: (
                    request: Parameters<
                      NonNullable<PreviewGatewayRelayConnection["applicationRequest"]>
                    >[0],
                  ) =>
                    applicationRequest(request).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          if (request.path === "/ready") authorityNow = expiresAt;
                        }),
                      ),
                    ),
                };
              }),
            ),
        };
        const gateway = yield* makePreviewGateway({
          domain: "dev.example.test",
          controller: f.controller,
          adapters,
          now: f.now,
        });
        const route = makePreviewWorkflowApiApplicationRoute(gateway);
        const endpoint = yield* route.applicationOrigin({
          sessionId: created.session.id,
          role: "sheet-workflows-api",
        });
        const sessionWithResources = (session: typeof created.session) => ({
          ...session,
          resources: {
            "preview-relay-service-sheet-workflows-api": target.serviceResourceId,
            "preview-relay-attachment-sheet-workflows-api": target.attachmentResourceId,
          },
        });
        const processFor = (revision: string): PreviewWorkflowApiProcess => ({
          id: `workflow-api-${revision}`,
          endpoint,
          opaque: revision,
        });
        const readiness = (
          process: PreviewWorkflowApiProcess,
          revision: string,
        ): PreviewWorkflowApiReadiness => ({
          sessionId: created.session.id,
          generation: created.session.generation,
          revision,
          endpoint: process.endpoint,
          workflowGroupTarget: previewSharedWorkflowGroupTarget(group),
          apiArtifactDigest: group.apiArtifactDigest,
          deployedManifestDigest: group.deployedManifestDigest,
          schemaArtifactDigest: group.schemaArtifactDigest,
          workflowContractCatalogDigest: group.workflowContractCatalogDigest,
          role: "producer",
          producerOnly: true,
          workflowRunner: false,
          reconciliationConsumer: false,
          autonomousTriggers: [],
          smokeEnqueue: false,
        });
        const config = {
          schemaVersion: 1,
          environment: "tiara-stack-dev",
          profile: "connected-preview-dev-v1",
          owner,
          roles: ["sheet-workflows-api"],
          hostListeners: [
            {
              role: "sheet-workflows-api",
              host: "127.0.0.1",
              port: target.port,
              processId: target.processId,
            },
          ],
          identities: {
            sourceRevision: "rev-a",
            artifactDigests: { "sheet-workflows-api": group.apiArtifactDigest },
            deployedManifestDigest: group.deployedManifestDigest,
            schemaArtifactDigest: group.schemaArtifactDigest,
            workflowContractCatalogDigest: group.workflowContractCatalogDigest,
            catalogVersion: 1,
          },
          environmentFileInputs: [],
          groups: [
            {
              id: group.groupId,
              ownership: "reused",
              endpoint: group.endpoint,
              stateIdentity: group.stateIdentity,
              deployedManifestDigest: group.deployedManifestDigest,
              databaseEndpointIdentity: group.databaseEndpointIdentity,
              schemaArtifactDigest: group.schemaArtifactDigest,
              workflowContractCatalogDigest: group.workflowContractCatalogDigest,
            },
          ],
          changes: [],
          credentialReferences: {},
          sharedExecution: "producer-only",
        } as const;
        const successfulRoutePublications: string[] = [];
        const publishedRouteProbes: string[] = [];
        let workflowAdmissionCalls = 0;
        let processStops = 0;
        let readyCallbacks = 0;
        const admitWorkflowRequest: PreviewSharedWorkflowHttpRequestRunner = <A, E, R>(
          request: PreviewSharedWorkflowHttpRequestInput<A, E, R>,
        ) =>
          Effect.sync(() => {
            workflowAdmissionCalls += 1;
          }).pipe(
            Effect.andThen(request.forward),
            Effect.map((value) => ({ value, continuationId: "expiry-test", group })),
          );
        const authorityIsCurrent = (revision: string) =>
          assertAuthorityCurrent().pipe(
            Effect.mapError(() =>
              makePreviewWorkflowApiSupervisorError(
                "workflow-api-credentials-unavailable",
                created.session,
                revision,
              ),
            ),
          );
        const supervisor = makePreviewWorkflowApiSupervisor({
          currentSourceRevision: () => Effect.succeed("rev-a"),
          startProcess: ({ revision }) => Effect.succeed(processFor(revision)),
          probe: ({ process, revision }) => Effect.succeed(readiness(process, revision)),
          probePublishedRoute: ({ process, revision }) =>
            Effect.sync(() => publishedRouteProbes.push(revision)).pipe(
              Effect.andThen(authorityIsCurrent(revision)),
              Effect.as(readiness(process, revision)),
            ),
          sourceRevisions: () => Stream.never,
          publishRoute: (input) =>
            Effect.gen(function* () {
              yield* authorityIsCurrent(input.revision);
              const published = yield* route
                .publish({
                  session: sessionWithResources(input.session),
                  ownerIdentity: input.ownerIdentity,
                  revision: input.revision,
                  group: input.group,
                  listener: {
                    role: "sheet-workflows-api",
                    host: "127.0.0.1",
                    port: target.port,
                    processId: target.processId,
                  },
                  admitWorkflowRequest,
                  assertAuthorityCurrent,
                })
                .pipe(
                  Effect.mapError(() =>
                    makePreviewWorkflowApiSupervisorError(
                      "route-failed",
                      input.session,
                      input.revision,
                    ),
                  ),
                );
              successfulRoutePublications.push(input.revision);
              return published;
            }),
          removeRoute: ({ sessionId, generation, ownerIdentity, expectedRevision }) =>
            route
              .remove({ sessionId, generation, ownerIdentity, expectedRevision })
              .pipe(
                Effect.mapError(() =>
                  makePreviewWorkflowApiSupervisorError(
                    "workflow-api-route-removal-failed",
                    created.session,
                  ),
                ),
              ),
          awaitExit: () => Effect.never,
          stopProcess: () => Effect.sync(() => (processStops += 1)),
        });
        const before = yield* f.control;
        const observationsBefore = f.applicationObservations.length;
        const runCompletion = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
        const running = yield* Effect.forkChild(
          supervisor
            .run({
              checkout: created.session.checkout,
              session: created.session,
              ownerIdentity: created.ownerIdentity,
              supervisorIdentity: created.supervisorIdentity,
              config,
              group,
              controller: f.controller,
              onReady: () => Effect.sync(() => (readyCallbacks += 1)),
            })
            .pipe(
              Effect.exit,
              Effect.tap((exit) => Deferred.succeed(runCompletion, exit)),
            ),
        );
        for (let attempt = 0; attempt < 20; attempt += 1) {
          yield* TestClock.adjust(Duration.millis(250));
          if (yield* Deferred.isDone(runCompletion)) break;
        }
        const runCompleted = yield* Deferred.isDone(runCompletion);
        if (!runCompleted) yield* Fiber.interrupt(running);
        expect(runCompleted).toBe(true);
        const run = yield* Deferred.await(runCompletion);

        expect(authorityNow).toBe(expiresAt);
        expect(Exit.isFailure(run)).toBe(true);
        expect(successfulRoutePublications).toEqual([]);
        expect(publishedRouteProbes).toEqual([]);
        expect(readyCallbacks).toBe(0);
        expect(processStops).toBe(1);
        expect(workflowAdmissionCalls).toBe(0);
        const hostname = `p-${created.session.id}-sheet-workflows-api.dev.example.test`;
        const rows =
          yield* f.sql`SELECT removed FROM preview_gateway_routes WHERE hostname=${hostname}`;
        expect(rows.filter((row) => row.removed === 0)).toHaveLength(0);
        expect(f.applicationObservations).toHaveLength(observationsBefore + 1);
        expect(yield* f.control).toEqual(before);
      }),
    ),
);

it.effect(
  "publishes the producer API through common HTTPS admission and removes only its exact route",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const created = yield* f.createSession(
          "workflow-api-owner",
          "application",
          "sheet-workflows-api",
        );
        const digest = (character: string) => `sha256:${character.repeat(64)}`;
        const group: PreviewSharedWorkflowGroup = {
          sessionId: created.session.id,
          generation: created.session.generation,
          groupId: "workflow-execution",
          endpoint: "https://workflows.dev.tiara-stack.moe",
          databaseEndpointIdentity: digest("d"),
          stateIdentity: "workflow-state-dev",
          deployedManifestDigest: digest("a"),
          schemaArtifactDigest: digest("b"),
          apiArtifactDigest: digest("c"),
          workflowContractCatalogDigest: digest("e"),
        };
        const session = {
          ...created.session,
          resources: {
            "preview-relay-service-sheet-workflows-api": created.target.serviceResourceId,
            "preview-relay-attachment-sheet-workflows-api": created.target.attachmentResourceId,
          },
        };
        const target: PreviewGatewayTarget = {
          ...created.target,
          stateGroup: "workflow-execution",
          artifactDigest: group.apiArtifactDigest,
          catalogDigest: group.workflowContractCatalogDigest,
        };
        const admittedRequests: { method: string; path: string; body?: string }[] = [];
        const admitWorkflowRequest: PreviewSharedWorkflowHttpRequestRunner = <A, E, R>(
          request: PreviewSharedWorkflowHttpRequestInput<A, E, R>,
        ) => {
          admittedRequests.push({
            method: request.method,
            path: request.path,
            ...(request.body === undefined ? {} : { body: new TextDecoder().decode(request.body) }),
          });
          return request.forward.pipe(
            Effect.map((value) => ({
              value,
              continuationId: "admission-local-test",
              group,
            })),
          );
        };
        const applicationRoute = makePreviewWorkflowApiApplicationRoute(f.gateway);
        const listener = {
          role: "sheet-workflows-api" as const,
          host: "127.0.0.1" as const,
          port: target.port,
          processId: target.processId,
        };
        const origin = yield* applicationRoute.publish({
          session,
          ownerIdentity: created.ownerIdentity,
          revision: target.revision,
          group,
          listener,
          admitWorkflowRequest,
        });
        const hostname = `p-${session.id}-sheet-workflows-api.dev.example.test`;
        expect(origin).toBe(`https://${hostname}`);
        const applicationObservationsBefore = f.applicationObservations.length;
        const authorization = f.token("workflow-api-owner-token", target, "workflow-api-owner");
        const handler = yield* HttpRouter.toHttpEffect(
          PreviewGatewayHttpRoutes(f.gateway).pipe(Layer.provide(HttpRouter.layer)),
        );
        const before = yield* f.control;
        const response = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`${origin}/_preview/app/workflows/test`, {
                method: "POST",
                headers: {
                  ...authorization,
                  host: hostname,
                  origin,
                  "content-type": "application/json",
                },
                body: '{"invocationId":"test"}',
              }),
            ),
          ),
        );
        expect(response.status).toBe(201);
        expect(admittedRequests).toEqual([
          {
            method: "POST",
            path: "/workflows/test",
            body: '{"invocationId":"test"}',
          },
        ]);
        expect(f.applicationObservations.at(-1)).toMatchObject({
          sessionId: session.id,
          method: "POST",
          path: "/workflows/test",
          body: new TextEncoder().encode('{"invocationId":"test"}'),
        });
        expect(f.applicationObservations).toHaveLength(applicationObservationsBefore + 1);

        yield* applicationRoute.remove({
          sessionId: session.id,
          generation: session.generation,
          ownerIdentity: created.ownerIdentity,
          expectedRevision: session.activeRevision ?? session.requestedRevision,
        });
        const afterRemoval = yield* Effect.exit(
          f.gateway.open({
            hostname,
            headers: authorization,
            path: "/_preview/app/workflows/test",
          }),
        );
        expect(afterRemoval._tag).toBe("Failure");
        expect(admittedRequests).toHaveLength(1);
        expect(f.applicationObservations).toHaveLength(applicationObservationsBefore + 1);
        expect(yield* f.control).toEqual(before);
      }),
    ),
);

it.effect("reopens an exact workflow API tombstone for its resumed session generation", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const created = yield* f.createSession(
        "workflow-api-resume-owner",
        "application",
        "sheet-workflows-api",
      );
      const digest = (character: string) => `sha256:${character.repeat(64)}`;
      const groupFor = (generation: number): PreviewSharedWorkflowGroup => ({
        sessionId: created.session.id,
        generation,
        groupId: "workflow-execution",
        endpoint: "https://workflows.dev.tiara-stack.moe",
        databaseEndpointIdentity: digest("d"),
        stateIdentity: "workflow-state-dev",
        deployedManifestDigest: digest("a"),
        schemaArtifactDigest: digest("b"),
        apiArtifactDigest: digest("c"),
        workflowContractCatalogDigest: digest("e"),
      });
      const sessionWithResources = (session: typeof created.session) => ({
        ...session,
        resources: {
          "preview-relay-service-sheet-workflows-api": created.target.serviceResourceId,
          "preview-relay-attachment-sheet-workflows-api": created.target.attachmentResourceId,
        },
      });
      const route = makePreviewWorkflowApiApplicationRoute(f.gateway);
      const publish = (session: typeof created.session, generation: number) => {
        const group = groupFor(generation);
        return route.publish({
          session: sessionWithResources(session),
          ownerIdentity: created.ownerIdentity,
          revision: "rev-a",
          group,
          listener: {
            role: "sheet-workflows-api",
            host: "127.0.0.1",
            port: created.target.port,
            processId: created.target.processId,
          },
          admitWorkflowRequest: (request) =>
            request.forward.pipe(
              Effect.map((value) => ({ value, continuationId: "resume-test", group })),
            ),
        });
      };

      yield* publish(created.session, created.session.generation);
      yield* route.remove({
        sessionId: created.session.id,
        generation: created.session.generation,
        ownerIdentity: created.ownerIdentity,
        expectedRevision: "rev-a",
      });
      yield* f.sql`UPDATE preview_sessions SET supervisor_lease_until=${f.now()}
        WHERE id=${created.session.id} AND generation=${created.session.generation}`;
      const resumed = yield* f.controller.resume(created.session.id, created.ownerIdentity);
      expect(resumed.session.generation).toBe(created.session.generation + 1);

      yield* publish(resumed.session, resumed.session.generation);
      const hostname = `p-${created.session.id}-sheet-workflows-api.dev.example.test`;
      const routeRows = yield* f.sql`SELECT target, removed FROM preview_gateway_routes
        WHERE hostname=${hostname}`;
      const target = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(PreviewGatewayTargetSchema),
      )(String(routeRows[0]?.target));
      expect({
        count: routeRows.length,
        removed: routeRows[0]?.removed,
        targetGeneration: target.generation,
        targetSession: target.sessionId,
        targetRole: target.role,
      }).toEqual({
        count: 1,
        removed: 0,
        targetGeneration: resumed.session.generation,
        targetSession: created.session.id,
        targetRole: "sheet-workflows-api",
      });
      const sibling = yield* f.sql`SELECT removed FROM preview_gateway_routes
        WHERE hostname=${f.routeB.hostname}`;
      expect(sibling).toEqual([{ removed: 0 }]);
      const stalePriorPublish = yield* Effect.exit(
        publish(created.session, created.session.generation),
      );
      expect(Exit.isFailure(stalePriorPublish)).toBe(true);

      yield* route.remove({
        sessionId: created.session.id,
        generation: resumed.session.generation,
        ownerIdentity: created.ownerIdentity,
        expectedRevision: "rev-a",
      });
      const mismatchedTombstone = { ...target, processId: "unowned-process" };
      yield* f.sql`UPDATE preview_gateway_routes SET target=${JSON.stringify(mismatchedTombstone)}
        WHERE hostname=${hostname} AND removed=1`;
      yield* f.sql`UPDATE preview_sessions SET supervisor_lease_until=${f.now()}
        WHERE id=${created.session.id} AND generation=${resumed.session.generation}`;
      const resumedAgain = yield* f.controller.resume(created.session.id, created.ownerIdentity);
      const refusedMismatchedTombstone = yield* Effect.exit(
        publish(resumedAgain.session, resumedAgain.session.generation),
      );
      expect(Exit.isFailure(refusedMismatchedTombstone)).toBe(true);
      const retainedTombstone = yield* f.sql`SELECT target, generation, removed
        FROM preview_gateway_routes WHERE hostname=${hostname}`;
      expect(retainedTombstone).toEqual([
        {
          target: JSON.stringify(mismatchedTombstone),
          generation: resumed.session.generation,
          removed: 1,
        },
      ]);
    }),
  ),
);

it.effect("gates producer API HTTPS requests through the exact session workflow admission", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const created = yield* f.createSession(
        "workflow-api-owner",
        "application",
        "sheet-workflows-api",
      );
      const digest = (character: string) => `sha256:${character.repeat(64)}`;
      const group: PreviewSharedWorkflowGroup = {
        sessionId: created.session.id,
        generation: created.session.generation,
        groupId: "workflow-execution",
        endpoint: "https://workflows.dev.tiara-stack.moe",
        databaseEndpointIdentity: digest("d"),
        stateIdentity: "workflow-state-dev",
        deployedManifestDigest: digest("a"),
        schemaArtifactDigest: digest("b"),
        apiArtifactDigest: digest("c"),
        workflowContractCatalogDigest: digest("e"),
      };
      const session = {
        ...created.session,
        resources: {
          "preview-relay-service-sheet-workflows-api": created.target.serviceResourceId,
          "preview-relay-attachment-sheet-workflows-api": created.target.attachmentResourceId,
        },
      };
      const target: PreviewGatewayTarget = {
        ...created.target,
        stateGroup: "workflow-execution",
        artifactDigest: group.apiArtifactDigest,
        catalogDigest: group.workflowContractCatalogDigest,
      };
      const admittedRequests: { method: string; path: string; body?: string }[] = [];
      const expectedBody = '{"invocationId":"test"}';
      let authorityNow = 100;
      const assertAuthorityCurrent = () =>
        authorityNow < 200
          ? Effect.void
          : Effect.fail(new PreviewWorkflowApiHostError({ reason: "authority-expired" }));
      const admitWorkflowRequest: PreviewSharedWorkflowHttpRequestRunner = (request) =>
        Effect.gen(function* () {
          if (
            request.method !== "POST" ||
            request.path !== "/workflows/test" ||
            request.body === undefined ||
            new TextDecoder().decode(request.body) !== expectedBody
          )
            return yield* Effect.fail(
              new PreviewSharedWorkflowError({ reason: "invalid-request", outcome: "not-sent" }),
            );
          admittedRequests.push({
            method: request.method,
            path: request.path,
            body: new TextDecoder().decode(request.body),
          });
          return {
            value: yield* request.forward,
            continuationId: "admission-local-test",
            group,
          };
        });
      const applicationRoute = makePreviewWorkflowApiApplicationRoute(f.gateway);
      const listener = {
        role: "sheet-workflows-api" as const,
        host: "127.0.0.1" as const,
        port: target.port,
        processId: target.processId,
      };
      const origin = yield* applicationRoute.publish({
        session,
        ownerIdentity: created.ownerIdentity,
        revision: target.revision,
        group,
        listener,
        admitWorkflowRequest,
        assertAuthorityCurrent,
      });
      const hostname = `p-${session.id}-sheet-workflows-api.dev.example.test`;
      expect(origin).toBe(`https://${hostname}`);
      const authorization = f.token("workflow-api-owner-token", target, "workflow-api-owner");
      const handler = yield* HttpRouter.toHttpEffect(
        PreviewGatewayHttpRoutes(f.gateway).pipe(Layer.provide(HttpRouter.layer)),
      );
      const before = yield* f.control;
      const applicationObservationsBefore = f.applicationObservations.length;
      const request = (body: string) =>
        handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`${origin}/_preview/app/workflows/test`, {
                method: "POST",
                headers: {
                  ...authorization,
                  host: hostname,
                  origin,
                  "content-type": "application/json",
                },
                body,
              }),
            ),
          ),
        );
      const response = yield* request(expectedBody);
      expect(response.status).toBe(201);
      expect(admittedRequests).toEqual([
        { method: "POST", path: "/workflows/test", body: expectedBody },
      ]);
      expect(f.applicationObservations.at(-1)).toMatchObject({
        sessionId: session.id,
        method: "POST",
        path: "/workflows/test",
        body: new TextEncoder().encode(expectedBody),
      });
      expect(f.applicationObservations).toHaveLength(applicationObservationsBefore + 1);
      yield* Effect.promise(() => HttpServerResponse.toWeb(response).text());

      const applicationSocketObservationsBefore = f.applicationSocketObservations.length;
      const admittedRequestsBeforeUpgrade = admittedRequests.length;
      const applicationRequestsBeforeUpgrade = f.applicationObservations.length;
      const browser = yield* testSocket;
      const upgraded = yield* Deferred.make<void>();
      const upgradeRequest = HttpServerRequest.fromWeb(
        new Request(`${origin}/_preview/app/socket`, {
          headers: {
            ...authorization,
            host: hostname,
            origin,
            upgrade: "websocket",
            "sec-fetch-site": "same-origin",
          },
        }),
      );
      const wrappedUpgrade = new Proxy(upgradeRequest, {
        get: (target, key, receiver) =>
          key === "upgrade"
            ? Deferred.succeed(upgraded, undefined).pipe(Effect.as(browser.socket))
            : Reflect.get(target, key, receiver),
      });
      const websocketResponse = yield* handler.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, wrappedUpgrade),
      );
      expect(websocketResponse.status).toBe(503);
      expect(f.applicationSocketObservations).toHaveLength(applicationSocketObservationsBefore);
      expect(admittedRequests).toHaveLength(admittedRequestsBeforeUpgrade);
      expect(f.applicationObservations).toHaveLength(applicationRequestsBeforeUpgrade);
      expect(yield* f.control).toEqual(before);

      authorityNow = 200;
      const readinessRequestsBeforeExpiry = f.applicationObservations.length;
      const readinessAfterExpiry = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`${origin}/ready`, {
              method: "GET",
              headers: {
                ...authorization,
                host: hostname,
                origin,
                "sec-fetch-site": "same-origin",
              },
            }),
          ),
        ),
      );
      expect(readinessAfterExpiry.status).toBe(503);
      const requestsBeforeExpiredAdmission = admittedRequests.length;
      const applicationRequestsBeforeExpiredAdmission = f.applicationObservations.length;
      const expiredAdmission = yield* request(expectedBody);
      expect(expiredAdmission.status).toBe(503);
      expect(admittedRequests).toHaveLength(requestsBeforeExpiredAdmission);
      expect(f.applicationObservations).toHaveLength(applicationRequestsBeforeExpiredAdmission);
      expect(f.applicationObservations).toHaveLength(readinessRequestsBeforeExpiry);
      expect(yield* f.control).toEqual(before);

      const rejected = yield* request('{"invocationId":"other"}');
      expect(rejected.status).toBe(503);
      expect(admittedRequests).toHaveLength(1);
      expect(f.applicationObservations).toHaveLength(applicationObservationsBefore + 1);
      yield* Effect.promise(() => HttpServerResponse.toWeb(rejected).text());

      yield* applicationRoute.remove({
        sessionId: session.id,
        generation: session.generation,
        ownerIdentity: created.ownerIdentity,
        expectedRevision: session.activeRevision ?? session.requestedRevision,
      });
      const afterRemoval = yield* Effect.exit(
        f.gateway.open({ hostname, headers: authorization, path: "/_preview/app/workflows/test" }),
      );
      expect(afterRemoval._tag).toBe("Failure");
      expect(yield* f.control).toEqual(before);
    }),
  ),
);

it.effect("fences each admitted workflow response chunk after authority expires", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const created = yield* f.createSession(
        "workflow-api-stream-expiry-owner",
        "application",
        "sheet-workflows-api",
      );
      const digest = (character: string) => `sha256:${character.repeat(64)}`;
      const group: PreviewSharedWorkflowGroup = {
        sessionId: created.session.id,
        generation: created.session.generation,
        groupId: "workflow-execution",
        endpoint: "https://workflows.dev.tiara-stack.moe",
        databaseEndpointIdentity: digest("d"),
        stateIdentity: "workflow-state-dev",
        deployedManifestDigest: digest("a"),
        schemaArtifactDigest: digest("b"),
        apiArtifactDigest: digest("c"),
        workflowContractCatalogDigest: digest("e"),
      };
      const session = {
        ...created.session,
        resources: {
          "preview-relay-service-sheet-workflows-api": created.target.serviceResourceId,
          "preview-relay-attachment-sheet-workflows-api": created.target.attachmentResourceId,
        },
      };
      const target: PreviewGatewayTarget = {
        ...created.target,
        stateGroup: group.groupId,
        artifactDigest: group.apiArtifactDigest,
        catalogDigest: group.workflowContractCatalogDigest,
      };
      const firstChunk = new TextEncoder().encode("data: first\n\n");
      const secondChunk = new TextEncoder().encode("data: after-expiry\n\n");
      let authorityNow = 100;
      const assertAuthorityCurrent = () =>
        authorityNow < 200
          ? Effect.void
          : Effect.fail(new PreviewWorkflowApiHostError({ reason: "authority-expired" }));
      const admittedRequests: string[] = [];
      const admitWorkflowRequest: PreviewSharedWorkflowHttpRequestRunner = (request) => {
        admittedRequests.push(`${request.method} ${request.path}`);
        return request.forward.pipe(
          Effect.map((value) => ({
            value,
            continuationId: "stream-expiry-test",
            group,
          })),
        );
      };
      f.setApplicationResponseBody(
        Stream.concat(
          Stream.make(firstChunk),
          Stream.fromEffect(
            Effect.sync(() => {
              authorityNow = 200;
              return secondChunk;
            }),
          ),
        ),
      );
      const applicationRoute = makePreviewWorkflowApiApplicationRoute(f.gateway);
      yield* applicationRoute.publish({
        session,
        ownerIdentity: created.ownerIdentity,
        revision: target.revision,
        group,
        listener: {
          role: "sheet-workflows-api",
          host: "127.0.0.1",
          port: target.port,
          processId: target.processId,
        },
        admitWorkflowRequest,
        assertAuthorityCurrent,
      });

      const hostname = `p-${session.id}-sheet-workflows-api.dev.example.test`;
      const authorization = f.token(
        "workflow-api-stream-expiry-token",
        target,
        "workflow-api-stream-expiry-owner",
      );
      const gatewayAdmission = yield* f.gateway.open({
        hostname,
        headers: authorization,
        path: "/_preview/app/workflows/test",
      });
      const response = yield* gatewayAdmission.applicationRequest({
        method: "GET",
        path: "/runs/invocation-1/events",
        headers: { accept: "text/event-stream" },
      });

      const received: Uint8Array[] = [];
      const bodyExit = yield* Effect.exit(
        response.body.pipe(Stream.runForEach((chunk) => Effect.sync(() => received.push(chunk)))),
      );

      expect(response.status).toBe(201);
      expect(admittedRequests).toEqual(["GET /runs/invocation-1/events"]);
      expect(received).toEqual([firstChunk]);
      expect(Exit.isFailure(bodyExit)).toBe(true);
      expect(authorityNow).toBe(200);
    }),
  ),
);

type PreviewGatewayTestFixture = Effect.Success<typeof fixture>;
type PendingRevisionSession = Effect.Success<
  ReturnType<PreviewGatewayTestFixture["createPendingSession"]>
>;
type RevisionRecoveryConfig = Parameters<PreviewWorkflowApiSupervisorApi["run"]>[0]["config"];
type RevisionRecoverySetup = {
  readonly created: PendingRevisionSession;
  readonly group: PreviewSharedWorkflowGroup;
  readonly target: PreviewGatewayTarget;
  readonly route: ReturnType<typeof makePreviewWorkflowApiApplicationRoute>;
  readonly routeOrigin: string;
  readonly config: RevisionRecoveryConfig;
};

type RevisionRecoverySignals = {
  readonly continueWithRecoveryRevision: Deferred.Deferred<void>;
  readonly readyRevisionA: Deferred.Deferred<void>;
  readonly readyRevisionAAfterRevert: Deferred.Deferred<void>;
  readonly readyRevisionC: Deferred.Deferred<void>;
  readonly revisionBFailure: Deferred.Deferred<void>;
  readonly runCompletion: Deferred.Deferred<Exit.Exit<unknown, unknown>>;
  readonly processExits: Map<string, Deferred.Deferred<void>>;
  readonly started: string[];
  readonly removedRevisions: string[];
  readonly stoppedRevisions: string[];
  readonly sourceReads: string[];
  readonly candidateProbes: string[];
  readonly publishedRouteProbes: string[];
  readonly routePublishAttempts: string[];
  readonly routePublishFailures: string[];
  readonly supervisorFailures: string[];
  readonly processStartFailures: string[];
  readonly recoveryRevision: "rev-a" | "rev-c";
  sourceRevision: string;
  sourceWatchStarted: boolean;
};

const makeRevisionRecoveryGroup = (created: PendingRevisionSession): PreviewSharedWorkflowGroup => {
  const digest = (character: string) => `sha256:${character.repeat(64)}`;
  return {
    sessionId: created.session.id,
    generation: created.session.generation,
    groupId: "workflow-execution",
    endpoint: "https://workflows.dev.theerapakg.moe",
    databaseEndpointIdentity: digest("d"),
    stateIdentity: "workflow-state-dev",
    deployedManifestDigest: digest("a"),
    schemaArtifactDigest: digest("b"),
    apiArtifactDigest: digest("c"),
    workflowContractCatalogDigest: digest("e"),
  };
};

const makeRevisionRecoveryTarget = (
  created: PendingRevisionSession,
  group: PreviewSharedWorkflowGroup,
): PreviewGatewayTarget => ({
  ...created.target,
  stateGroup: group.groupId,
  artifactDigest: group.apiArtifactDigest,
  catalogDigest: group.workflowContractCatalogDigest,
});

const makeRevisionRecoveryConfig = (
  owner: string,
  target: PreviewGatewayTarget,
  group: PreviewSharedWorkflowGroup,
): RevisionRecoveryConfig => ({
  schemaVersion: 1,
  environment: "tiara-stack-dev",
  profile: "connected-preview-dev-v1",
  owner,
  roles: ["sheet-workflows-api"],
  hostListeners: [
    {
      role: "sheet-workflows-api",
      host: "127.0.0.1",
      port: target.port,
      processId: target.processId,
    },
  ],
  identities: {
    sourceRevision: "rev-a",
    artifactDigests: { "sheet-workflows-api": group.apiArtifactDigest },
    deployedManifestDigest: group.deployedManifestDigest,
    schemaArtifactDigest: group.schemaArtifactDigest,
    workflowContractCatalogDigest: group.workflowContractCatalogDigest,
    catalogVersion: 1,
  },
  environmentFileInputs: [],
  groups: [
    {
      id: group.groupId,
      ownership: "reused",
      endpoint: group.endpoint,
      stateIdentity: group.stateIdentity,
      deployedManifestDigest: group.deployedManifestDigest,
      databaseEndpointIdentity: group.databaseEndpointIdentity,
      schemaArtifactDigest: group.schemaArtifactDigest,
      workflowContractCatalogDigest: group.workflowContractCatalogDigest,
    },
  ],
  changes: [],
  credentialReferences: {},
  sharedExecution: "producer-only",
});

const withWorkflowApiResources = (session: PreviewSession, target: PreviewGatewayTarget) => ({
  ...session,
  resources: {
    "preview-relay-service-sheet-workflows-api": target.serviceResourceId,
    "preview-relay-attachment-sheet-workflows-api": target.attachmentResourceId,
  },
});

const makeRevisionRecoverySetup = (f: PreviewGatewayTestFixture, owner: string) =>
  Effect.gen(function* () {
    const created = yield* f.createPendingSession(owner, "application", "sheet-workflows-api");
    const group = makeRevisionRecoveryGroup(created);
    const target = makeRevisionRecoveryTarget(created, group);
    const route = makePreviewWorkflowApiApplicationRoute(f.gateway);
    const routeOrigin = yield* route.applicationOrigin({
      sessionId: created.session.id,
      role: "sheet-workflows-api",
    });
    const config = makeRevisionRecoveryConfig(owner, target, group);
    return { created, group, target, route, routeOrigin, config } satisfies RevisionRecoverySetup;
  });

const makeRevisionRecoverySignals = (recoveryRevision: "rev-a" | "rev-c" = "rev-c") =>
  Effect.gen(function* () {
    return {
      continueWithRecoveryRevision: yield* Deferred.make<void>(),
      readyRevisionA: yield* Deferred.make<void>(),
      readyRevisionAAfterRevert: yield* Deferred.make<void>(),
      readyRevisionC: yield* Deferred.make<void>(),
      revisionBFailure: yield* Deferred.make<void>(),
      runCompletion: yield* Deferred.make<Exit.Exit<unknown, unknown>>(),
      processExits: new Map<string, Deferred.Deferred<void>>(),
      started: [],
      removedRevisions: [],
      stoppedRevisions: [],
      sourceReads: [],
      candidateProbes: [],
      publishedRouteProbes: [],
      routePublishAttempts: [],
      routePublishFailures: [],
      supervisorFailures: [],
      processStartFailures: [],
      recoveryRevision,
      sourceRevision: "rev-a",
      sourceWatchStarted: false,
    } satisfies RevisionRecoverySignals;
  });

const makeRevisionRecoveryReadiness =
  (group: PreviewSharedWorkflowGroup) =>
  (
    process: PreviewWorkflowApiProcess,
    session: PreviewSession,
    revision: string,
  ): PreviewWorkflowApiReadiness => ({
    sessionId: session.id,
    generation: session.generation,
    revision,
    endpoint: process.endpoint,
    workflowGroupTarget: previewSharedWorkflowGroupTarget(group),
    apiArtifactDigest: group.apiArtifactDigest,
    deployedManifestDigest: group.deployedManifestDigest,
    schemaArtifactDigest: group.schemaArtifactDigest,
    workflowContractCatalogDigest: group.workflowContractCatalogDigest,
    role: "producer",
    producerOnly: true,
    workflowRunner: false,
    reconciliationConsumer: false,
    autonomousTriggers: [],
    smokeEnqueue: false,
  });

const makeRevisionRecoveryProcessAdapters = (
  setup: RevisionRecoverySetup,
  signals: RevisionRecoverySignals,
) => ({
  currentSourceRevision: () =>
    Effect.sync(() => {
      signals.sourceReads.push(signals.sourceRevision);
      return signals.sourceRevision;
    }),
  startProcess: ({ revision, session }: { revision: string; session: PreviewSession }) => {
    signals.started.push(revision);
    if (revision === "rev-b")
      return Effect.fail(
        makePreviewWorkflowApiSupervisorError("workflow-source-unavailable", session, revision),
      ).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            signals.processStartFailures.push(
              JSON.stringify({
                reason: error.reason,
                requestedRevision: error.requestedRevision,
                sourceStage: error.sourceStage,
                cleanup: error.cleanup,
              }),
            );
            yield* Deferred.succeed(signals.revisionBFailure, undefined);
          }),
        ),
      );
    return Effect.gen(function* () {
      const process: PreviewWorkflowApiProcess = {
        id: `workflow-api-${revision}`,
        endpoint: setup.routeOrigin,
        opaque: revision,
      };
      signals.processExits.set(process.id, yield* Deferred.make<void>());
      return process;
    });
  },
  sourceRevisions: () => {
    signals.sourceWatchStarted = true;
    return Stream.concat(
      Stream.fromEffect(
        Effect.sync(() => {
          signals.sourceRevision = "rev-b";
          return signals.sourceRevision;
        }),
      ),
      Stream.concat(
        Stream.fromEffect(
          Deferred.await(signals.continueWithRecoveryRevision).pipe(
            Effect.andThen(
              Effect.sync(() => {
                signals.sourceRevision = signals.recoveryRevision;
                return signals.sourceRevision;
              }),
            ),
          ),
        ),
        Stream.never,
      ),
    );
  },
  awaitExit: (process: PreviewWorkflowApiProcess) => {
    const exited = signals.processExits.get(process.id);
    return exited === undefined ? Effect.void : Deferred.await(exited);
  },
  stopProcess: (process: PreviewWorkflowApiProcess) =>
    Effect.sync(() => signals.stoppedRevisions.push(String(process.opaque))).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const exited = signals.processExits.get(process.id);
          return exited === undefined ? Effect.void : Deferred.succeed(exited, undefined);
        }),
      ),
    ),
});

const makeRevisionRecoveryRouteAdapters = (
  setup: RevisionRecoverySetup,
  signals: RevisionRecoverySignals,
) => {
  const readiness = makeRevisionRecoveryReadiness(setup.group);
  return {
    probe: ({
      process,
      session,
      revision,
    }: {
      process: PreviewWorkflowApiProcess;
      session: PreviewSession;
      revision: string;
    }) =>
      Effect.sync(() => {
        signals.candidateProbes.push(revision);
        return readiness(process, session, revision);
      }),
    probePublishedRoute: ({
      process,
      session,
      revision,
    }: {
      process: PreviewWorkflowApiProcess;
      session: PreviewSession;
      revision: string;
    }) =>
      Effect.sync(() => {
        signals.publishedRouteProbes.push(revision);
        return readiness(process, session, revision);
      }),
    publishRoute: (input: {
      readonly session: PreviewSession;
      readonly ownerIdentity: string;
      readonly revision: string;
      readonly group: PreviewSharedWorkflowGroup;
    }) => {
      signals.routePublishAttempts.push(input.revision);
      return setup.route
        .publish({
          session: withWorkflowApiResources(input.session, setup.target),
          ownerIdentity: input.ownerIdentity,
          revision: input.revision,
          group: input.group,
          listener: {
            role: "sheet-workflows-api",
            host: "127.0.0.1",
            port: setup.target.port,
            processId: setup.target.processId,
          },
          admitWorkflowRequest: (request) =>
            request.forward.pipe(
              Effect.map((value) => ({
                value,
                continuationId: "pre-spawn-recovery-test",
                group: setup.group,
              })),
            ),
        })
        .pipe(
          Effect.tapError((error) =>
            Effect.sync(() => signals.routePublishFailures.push(String(error))),
          ),
          Effect.mapError(() =>
            makePreviewWorkflowApiSupervisorError("route-failed", input.session, input.revision),
          ),
        );
    },
    removeRoute: (input: {
      readonly expectedRevision: string;
      readonly sessionId: string;
      readonly generation: number;
      readonly ownerIdentity: string;
    }) =>
      Effect.sync(() => signals.removedRevisions.push(input.expectedRevision)).pipe(
        Effect.andThen(setup.route.remove(input)),
        Effect.mapError(() =>
          makePreviewWorkflowApiSupervisorError(
            "workflow-api-route-removal-failed",
            setup.created.session,
            input.expectedRevision,
          ),
        ),
      ),
  };
};

const startRevisionRecoverySupervisor = (
  f: PreviewGatewayTestFixture,
  setup: RevisionRecoverySetup,
  signals: RevisionRecoverySignals,
) => {
  const supervisor = makePreviewWorkflowApiSupervisor({
    ...makeRevisionRecoveryProcessAdapters(setup, signals),
    ...makeRevisionRecoveryRouteAdapters(setup, signals),
  });
  return Effect.forkChild(
    supervisor
      .run({
        checkout: setup.created.session.checkout,
        session: setup.created.session,
        ownerIdentity: setup.created.ownerIdentity,
        supervisorIdentity: setup.created.supervisorIdentity,
        config: setup.config,
        group: setup.group,
        controller: f.controller,
        onReady: (session) => {
          if (session.activeRevision === "rev-a")
            return Deferred.isDone(signals.revisionBFailure).pipe(
              Effect.flatMap((revisionBFailed) => {
                if (revisionBFailed)
                  return Deferred.succeed(signals.readyRevisionAAfterRevert, undefined);
                return Deferred.succeed(signals.readyRevisionA, undefined);
              }),
            );
          if (session.activeRevision === "rev-c")
            return Deferred.succeed(signals.readyRevisionC, undefined);
          return Effect.void;
        },
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.sync(() =>
            signals.supervisorFailures.push(
              JSON.stringify({
                reason: error.reason,
                requestedRevision: error.requestedRevision,
                sourceStage: error.sourceStage,
                cleanup: error.cleanup,
              }),
            ),
          ),
        ),
        Effect.exit,
        Effect.tap((exit) => Deferred.succeed(signals.runCompletion, exit)),
      ),
  );
};

const waitForRevisionSignal = (
  signal: Deferred.Deferred<void>,
  runCompletion: Deferred.Deferred<Exit.Exit<unknown, unknown>>,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (yield* Deferred.isDone(signal)) return true;
      if (yield* Deferred.isDone(runCompletion)) return false;
      yield* Effect.sleep(Duration.millis(10));
    }
    return yield* Deferred.isDone(signal);
  });

const assertRevisionATombstone = (
  f: PreviewGatewayTestFixture,
  setup: RevisionRecoverySetup,
  signals: RevisionRecoverySignals,
) =>
  Effect.gen(function* () {
    expect(yield* waitForRevisionSignal(signals.readyRevisionA, signals.runCompletion)).toBe(true);
    expect(signals.sourceWatchStarted).toBe(true);
    expect(
      yield* waitForRevisionSignal(signals.revisionBFailure, signals.runCompletion),
      JSON.stringify({
        started: signals.started,
        processStartFailures: signals.processStartFailures,
        removedRevisions: signals.removedRevisions,
        supervisorFailures: signals.supervisorFailures,
      }),
    ).toBe(true);
    const hostname = new URL(setup.routeOrigin).hostname;
    const tombstone =
      yield* f.sql`SELECT target, removed FROM preview_gateway_routes WHERE hostname=${hostname}`;
    expect(tombstone).toHaveLength(1);
    const row = tombstone[0];
    if (row === undefined) return hostname;
    const target = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(PreviewGatewayTargetSchema),
    )(String(row.target));
    expect(row.removed).toBe(1);
    expect(target.revision).toBe("rev-a");
    expect((yield* f.controller.status(setup.created.session.id)).requestedRevision).toBe("rev-b");
    expect(signals.started).toEqual(["rev-a", "rev-b"]);
    expect(signals.removedRevisions).toEqual(["rev-a"]);
    return hostname;
  });

const assertRevisionCActive = (
  f: PreviewGatewayTestFixture,
  setup: RevisionRecoverySetup,
  signals: RevisionRecoverySignals,
  hostname: string,
) =>
  Effect.gen(function* () {
    expect(yield* waitForRevisionSignal(signals.readyRevisionC, signals.runCompletion)).toBe(true);
    expect(signals.started).toEqual(["rev-a", "rev-b", "rev-c"]);
    expect(signals.removedRevisions).toEqual(["rev-a"]);
    const rows =
      yield* f.sql`SELECT target, removed FROM preview_gateway_routes WHERE hostname=${hostname}`;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) return;
    const target = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(PreviewGatewayTargetSchema),
    )(String(row.target));
    expect(row.removed).toBe(0);
    expect(target.revision).toBe("rev-c");
    expect(target.sessionId).toBe(setup.created.session.id);
    expect(target.generation).toBe(setup.created.session.generation);
    expect(target.role).toBe("sheet-workflows-api");
    const sibling =
      yield* f.sql`SELECT removed FROM preview_gateway_routes WHERE hostname=${f.routeA.hostname}`;
    expect(sibling).toEqual([{ removed: 0 }]);
    expect((yield* f.controller.status(setup.created.session.id)).activeRevision).toBe("rev-c");
  });

const assertRevisionRecoveryCleanup = (
  f: PreviewGatewayTestFixture,
  setup: RevisionRecoverySetup,
  signals: RevisionRecoverySignals,
  running: Effect.Success<ReturnType<typeof startRevisionRecoverySupervisor>>,
  recoveredRevision: "rev-a" | "rev-c",
) =>
  Effect.gen(function* () {
    yield* Fiber.interrupt(running);
    expect(signals.removedRevisions).toEqual(["rev-a", recoveredRevision]);
    expect(signals.stoppedRevisions).toEqual(["rev-a", recoveredRevision]);
    expect((yield* f.controller.status(setup.created.session.id)).phase).toBe("ended");
  });

it.live("reopens the prior route tombstone after a recoverable pre-spawn revision failure", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const setup = yield* makeRevisionRecoverySetup(f, "workflow-api-pre-spawn-recovery-owner");
      const signals = yield* makeRevisionRecoverySignals();
      const running = yield* startRevisionRecoverySupervisor(f, setup, signals);
      const hostname = yield* assertRevisionATombstone(f, setup, signals);
      yield* Deferred.succeed(signals.continueWithRecoveryRevision, undefined);
      yield* assertRevisionCActive(f, setup, signals, hostname);
      yield* assertRevisionRecoveryCleanup(f, setup, signals, running, "rev-c");
    }),
  ),
);

it.live(
  "reopens the exact workflow API tombstone after a recoverable pre-spawn failure and same-revision revert",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const listenerPort = 45_443;
        f.gateway = yield* makePreviewGateway({
          domain: "dev.example.test",
          controller: f.controller,
          adapters: f.adapters,
          now: f.now,
          publicPort: () => listenerPort,
          listenerLeaseManagement: true,
        });
        const setup = yield* makeRevisionRecoverySetup(
          f,
          "workflow-api-same-revision-revert-owner",
        );
        const signals = yield* makeRevisionRecoverySignals("rev-a");
        const running = yield* startRevisionRecoverySupervisor(f, setup, signals);
        const hostname = yield* assertRevisionATombstone(f, setup, signals);
        const handler = yield* HttpRouter.toHttpEffect(
          PreviewGatewayHttpRoutes(f.gateway).pipe(Layer.provide(HttpRouter.layer)),
        );
        const ownerProof = f.token(
          "workflow-api-same-revision-revert-proof",
          setup.target,
          setup.created.session.owner,
        );
        const requestCurrentRoute = () =>
          handler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(`${setup.routeOrigin}/ready`, {
                  headers: {
                    ...ownerProof,
                    host: `${hostname}:${listenerPort}`,
                    origin: `https://${hostname}:${listenerPort}`,
                  },
                }),
              ),
            ),
          );
        const observationsBeforeTombstoneRequest = f.applicationObservations.length;
        const tombstoneResponse = yield* requestCurrentRoute();
        expect(tombstoneResponse.status).toBe(503);
        expect(f.applicationObservations).toHaveLength(observationsBeforeTombstoneRequest);

        yield* Deferred.succeed(signals.continueWithRecoveryRevision, undefined);
        const restored = yield* waitForRevisionSignal(
          signals.readyRevisionAAfterRevert,
          signals.runCompletion,
        );
        const sessionAfterRevert = yield* f.controller.status(setup.created.session.id);
        expect(
          restored,
          JSON.stringify({
            started: signals.started,
            sourceRevision: signals.sourceRevision,
            currentSession: {
              phase: sessionAfterRevert.phase,
              requestedRevision: sessionAfterRevert.requestedRevision,
              activeRevision: sessionAfterRevert.activeRevision,
            },
            routePublishAttempts: signals.routePublishAttempts,
            routePublishFailures: signals.routePublishFailures,
            processStartFailures: signals.processStartFailures,
            supervisorFailures: signals.supervisorFailures,
          }),
        ).toBe(true);
        expect(signals.started).toEqual(["rev-a", "rev-b", "rev-a"]);
        expect(signals.removedRevisions).toEqual(["rev-a"]);

        const rows =
          yield* f.sql`SELECT target, removed FROM preview_gateway_routes WHERE hostname=${hostname}`;
        expect(rows).toHaveLength(1);
        const row = rows[0];
        if (row === undefined) return;
        const target = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(PreviewGatewayTargetSchema),
        )(String(row.target));
        expect(row.removed).toBe(0);
        expect(target).toMatchObject({
          sessionId: setup.created.session.id,
          generation: setup.created.session.generation,
          role: "sheet-workflows-api",
          revision: "rev-a",
        });
        expect(
          yield* f.sql`SELECT removed FROM preview_gateway_routes WHERE hostname=${f.routeA.hostname}`,
        ).toEqual([{ removed: 0 }]);
        expect((yield* f.controller.status(setup.created.session.id)).activeRevision).toBe("rev-a");
        const restoredResponse = yield* requestCurrentRoute();
        expect(restoredResponse.status).toBe(200);
        expect(f.applicationObservations.at(-1)?.sessionId).toBe(setup.created.session.id);
        expect(
          yield* f.sql`SELECT public_port, generation FROM preview_gateway_listener_leases
            WHERE session_id=${setup.created.session.id}`,
        ).toEqual([{ public_port: listenerPort, generation: setup.created.session.generation }]);

        yield* assertRevisionRecoveryCleanup(f, setup, signals, running, "rev-a");
        yield* f.gateway.cleanupSession(setup.created.session.id, setup.created.ownerIdentity);
        expect(
          yield* f.sql`SELECT session_id FROM preview_gateway_listener_leases
            WHERE session_id=${setup.created.session.id}`,
        ).toEqual([]);
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
  "restarts a compatible workflow API source revision through the supervisor and published session route",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const created = yield* f.controller.create({
          owner: "workflow-api-revision-owner",
          checkout: "/test/workflow-api-revision-owner",
          requestedRevision: "rev-a",
          manifests: { "sheet-workflows-api": "manifest" },
          groups: ["workflow-execution"],
          endpoints: ["https://workflows.dev.tiara-stack.moe"],
        });
        const digest = (character: string) => `sha256:${character.repeat(64)}`;
        const group: PreviewSharedWorkflowGroup = {
          sessionId: created.session.id,
          generation: created.session.generation,
          groupId: "workflow-execution",
          endpoint: "https://workflows.dev.tiara-stack.moe",
          databaseEndpointIdentity: digest("d"),
          stateIdentity: "workflow-state-dev",
          deployedManifestDigest: digest("a"),
          schemaArtifactDigest: digest("b"),
          apiArtifactDigest: digest("c"),
          workflowContractCatalogDigest: digest("e"),
        };
        const revisionGateway = yield* makePreviewGateway({
          domain: "dev.tiara-stack.moe",
          controller: f.controller,
          now: f.now,
          adapters: {
            ...f.adapters,
            checkSetup: f.adapters.checkSetup.pipe(
              Effect.map((setup) => ({ ...setup, domain: "dev.tiara-stack.moe" })),
            ),
          },
        });
        const targetBase: PreviewGatewayTarget = {
          sessionId: created.session.id,
          generation: created.session.generation,
          role: "sheet-workflows-api",
          processId: "workflow-api-host",
          revision: "rev-a",
          artifactDigest: group.apiArtifactDigest,
          catalogDigest: group.workflowContractCatalogDigest,
          stateGroup: group.groupId,
          kind: "application",
          serviceFqdn: `${relayNameFor(created.session.id, "sheet-workflows-api")}.preview-relays.svc.cluster.local`,
          port: 43123,
          serviceResourceId: "service-workflow-api-revision-owner",
          attachmentResourceId: "attachment-workflow-api-revision-owner",
        };
        for (const kind of ["service", "attachment"] as const) {
          const ownerToken = `workflow-api-revision-${kind}-owner`;
          const providerResourceId =
            kind === "service" ? targetBase.serviceResourceId : targetBase.attachmentResourceId;
          const reference = JSON.stringify({
            version: 1,
            kind,
            sessionId: targetBase.sessionId,
            role: targetBase.role,
            processId: targetBase.processId,
            ownerTokenDigest: createHash("sha256").update(ownerToken).digest("hex").slice(0, 63),
            providerResourceId,
          });
          yield* f.sql`INSERT INTO preview_allocation_ledger VALUES (
            ${targetBase.sessionId},
            ${`preview-relay-${kind}-${targetBase.role}`},
            ${ownerToken},
            ${reference},
            'owned'
          )`;
        }
        const sessionWithResources = (session: typeof created.session) => ({
          ...session,
          resources: {
            "preview-relay-service-sheet-workflows-api": targetBase.serviceResourceId,
            "preview-relay-attachment-sheet-workflows-api": targetBase.attachmentResourceId,
          },
        });
        const route = makePreviewWorkflowApiApplicationRoute(revisionGateway);
        const routeOrigin = yield* route.applicationOrigin({
          sessionId: created.session.id,
          role: "sheet-workflows-api",
        });
        const routeTarget = (revision: string): PreviewGatewayTarget => ({
          ...targetBase,
          revision,
          stateGroup: group.groupId,
          artifactDigest: group.apiArtifactDigest,
          catalogDigest: group.workflowContractCatalogDigest,
        });
        const processFor = (revision: string): PreviewWorkflowApiProcess => ({
          id: `workflow-api-${revision}`,
          endpoint: routeOrigin,
          opaque: revision,
        });
        const config = {
          schemaVersion: 1,
          environment: "tiara-stack-dev",
          profile: "connected-preview-dev-v1",
          owner: "workflow-api-revision-owner",
          roles: ["sheet-workflows-api"],
          hostListeners: [
            {
              role: "sheet-workflows-api",
              host: "127.0.0.1",
              port: targetBase.port,
              processId: targetBase.processId,
            },
          ],
          identities: {
            sourceRevision: "rev-a",
            artifactDigests: { "sheet-workflows-api": group.apiArtifactDigest },
            deployedManifestDigest: group.deployedManifestDigest,
            schemaArtifactDigest: group.schemaArtifactDigest,
            workflowContractCatalogDigest: group.workflowContractCatalogDigest,
            catalogVersion: 1,
          },
          environmentFileInputs: [],
          groups: [
            {
              id: "workflow-execution",
              ownership: "reused",
              endpoint: group.endpoint,
              stateIdentity: group.stateIdentity,
              deployedManifestDigest: group.deployedManifestDigest,
              databaseEndpointIdentity: group.databaseEndpointIdentity,
              schemaArtifactDigest: group.schemaArtifactDigest,
              workflowContractCatalogDigest: group.workflowContractCatalogDigest,
            },
          ],
          changes: [],
          credentialReferences: {},
          sharedExecution: "producer-only",
        } as const;
        const readiness = (
          process: PreviewWorkflowApiProcess,
          revision: string,
        ): PreviewWorkflowApiReadiness => ({
          sessionId: created.session.id,
          generation: created.session.generation,
          revision,
          endpoint: process.endpoint,
          workflowGroupTarget: previewSharedWorkflowGroupTarget(group),
          apiArtifactDigest: group.apiArtifactDigest,
          deployedManifestDigest: group.deployedManifestDigest,
          schemaArtifactDigest: group.schemaArtifactDigest,
          workflowContractCatalogDigest: group.workflowContractCatalogDigest,
          role: "producer",
          producerOnly: true,
          workflowRunner: false,
          reconciliationConsumer: false,
          autonomousTriggers: [],
          smokeEnqueue: false,
        });
        const publishedRouteProbeRevisions: string[] = [];
        const publishAttempts: string[] = [];
        const publishFailures: string[] = [];
        const supervisorFailures: string[] = [];
        const readyRevisions: string[] = [];
        const removedRouteRevisions: string[] = [];
        const acceptedSharedJobs = new Set<string>();
        const revisionBReady = yield* Deferred.make<void>();
        let sourceRevision = "rev-a";
        const authorityExpiresAt = f.now() + 10_000;
        const assertAuthorityCurrent = (): Effect.Effect<void, PreviewWorkflowApiHostError> =>
          f.now() < authorityExpiresAt
            ? Effect.void
            : Effect.fail(
                new PreviewWorkflowApiHostError({ reason: "workflow-api-authority-expired" }),
              );
        const supervisor = makePreviewWorkflowApiSupervisor({
          authorityExpiresAt,
          authorityNow: f.now,
          assertAuthorityCurrent: () =>
            assertAuthorityCurrent().pipe(
              Effect.mapError(() =>
                makePreviewWorkflowApiSupervisorError(
                  "workflow-api-authority-expired",
                  created.session,
                ),
              ),
            ),
          currentSourceRevision: () => Effect.succeed(sourceRevision),
          startProcess: ({ revision }) => Effect.succeed(processFor(revision)),
          probe: ({ process, revision }) => Effect.succeed(readiness(process, revision)),
          probePublishedRoute: ({ process, revision }) =>
            Effect.sync(() => {
              publishedRouteProbeRevisions.push(revision);
              return readiness(process, revision);
            }),
          sourceRevisions: () =>
            Stream.fromEffect(
              Effect.sync(() => {
                sourceRevision = "rev-b";
                return sourceRevision;
              }),
            ).pipe(Stream.concat(Stream.never)),
          publishRoute: (input) => {
            publishAttempts.push(input.revision);
            return route
              .publish({
                session: sessionWithResources(input.session),
                ownerIdentity: input.ownerIdentity,
                revision: input.revision,
                group: input.group,
                listener: {
                  role: "sheet-workflows-api",
                  host: "127.0.0.1",
                  port: targetBase.port,
                  processId: targetBase.processId,
                },
                assertAuthorityCurrent,
                admitWorkflowRequest: (request) =>
                  request.forward.pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        if (request.method === "POST")
                          acceptedSharedJobs.add("accepted-rev-b-workflow");
                      }),
                    ),
                    Effect.map((value) => ({
                      value,
                      continuationId: "revision-restart-test",
                      group,
                    })),
                  ),
              })
              .pipe(
                Effect.tapError((error) => Effect.sync(() => publishFailures.push(String(error)))),
                Effect.mapError(() =>
                  makePreviewWorkflowApiSupervisorError(
                    "route-failed",
                    input.session,
                    input.revision,
                  ),
                ),
              );
          },
          removeRoute: ({ sessionId, generation, ownerIdentity, expectedRevision }) =>
            Effect.sync(() => removedRouteRevisions.push(expectedRevision))
              .pipe(
                Effect.andThen(
                  route.remove({ sessionId, generation, ownerIdentity, expectedRevision }),
                ),
              )
              .pipe(
                Effect.mapError(() =>
                  makePreviewWorkflowApiSupervisorError(
                    "workflow-api-route-removal-failed",
                    created.session,
                  ),
                ),
              ),
          awaitExit: () => Effect.never,
          stopProcess: () => Effect.void,
        });
        const running = yield* Effect.forkChild(
          supervisor
            .run({
              checkout: created.session.checkout,
              session: created.session,
              ownerIdentity: created.ownerIdentity,
              supervisorIdentity: created.supervisorIdentity,
              config,
              group,
              controller: f.controller,
              onReady: (session) =>
                Effect.sync(() => {
                  readyRevisions.push(session.activeRevision ?? "");
                }).pipe(
                  Effect.andThen(
                    session.activeRevision === "rev-b"
                      ? Deferred.succeed(revisionBReady, undefined)
                      : Effect.void,
                  ),
                ),
            })
            .pipe(
              Effect.tapError((error) => Effect.sync(() => supervisorFailures.push(String(error)))),
            ),
        );

        // The supervisor deliberately pauses between candidate and published-route probes.
        // Advance the fixture clock while its real route path runs, without changing deadlines.
        for (let attempt = 0; attempt < 20; attempt += 1) {
          yield* TestClock.adjust(Duration.millis(250));
          if (yield* Deferred.isDone(revisionBReady)) break;
        }
        const revisionBPublished = yield* Deferred.isDone(revisionBReady);
        if (revisionBPublished) {
          expect(readyRevisions).toEqual(["rev-a", "rev-b"]);
          expect(publishedRouteProbeRevisions).toEqual(["rev-a", "rev-a", "rev-b", "rev-b"]);
          const target = routeTarget("rev-a");
          const wrongOwner = yield* Effect.exit(
            route.publish({
              session: sessionWithResources(created.session),
              ownerIdentity: "wrong-owner",
              revision: "rev-b",
              group,
              listener: {
                role: "sheet-workflows-api",
                host: "127.0.0.1",
                port: targetBase.port,
                processId: targetBase.processId,
              },
              admitWorkflowRequest: (request) =>
                request.forward.pipe(
                  Effect.map((value) => ({ value, continuationId: "wrong-owner", group })),
                ),
            }),
          );
          expect(wrongOwner._tag).toBe("Failure");
          const staleRevision = yield* Effect.exit(
            route.publish({
              session: sessionWithResources(created.session),
              ownerIdentity: created.ownerIdentity,
              revision: "rev-a",
              group,
              listener: {
                role: "sheet-workflows-api",
                host: "127.0.0.1",
                port: targetBase.port,
                processId: targetBase.processId,
              },
              admitWorkflowRequest: (request) =>
                request.forward.pipe(
                  Effect.map((value) => ({ value, continuationId: "stale-revision", group })),
                ),
            }),
          );
          expect(staleRevision._tag).toBe("Failure");
          expect(target.revision).toBe("rev-a");

          const staleCleanupRequest = {
            sessionId: created.session.id,
            generation: created.session.generation,
            ownerIdentity: created.ownerIdentity,
            expectedRevision: "rev-a",
          };
          const staleCleanup = yield* Effect.exit(route.remove(staleCleanupRequest));
          expect(staleCleanup._tag).toBe("Failure");
          const currentRevisionProof = f.token(
            "workflow-api-current-revision",
            routeTarget("rev-b"),
            created.session.owner,
          );
          const currentRoute = yield* revisionGateway.open({
            hostname: new URL(routeOrigin).hostname,
            headers: currentRevisionProof,
          });
          expect(currentRoute.route.target.revision).toBe("rev-b");
          const accepted = yield* currentRoute.applicationRequest({
            method: "POST",
            path: "/workflows/test",
            headers: {},
          });
          expect(accepted.status).toBe(201);
          expect([...acceptedSharedJobs]).toEqual(["accepted-rev-b-workflow"]);

          yield* TestClock.adjust(Duration.millis(authorityExpiresAt - f.now()));
          const expiredRun = yield* Fiber.await(running);
          expect(Exit.isFailure(expiredRun)).toBe(true);
          expect(removedRouteRevisions).toEqual(["rev-a", "rev-b"]);
          expect([...acceptedSharedJobs]).toEqual(["accepted-rev-b-workflow"]);
          const afterExpiry = yield* Effect.exit(
            revisionGateway.open({
              hostname: new URL(routeOrigin).hostname,
              headers: currentRevisionProof,
            }),
          );
          expect(afterExpiry._tag).toBe("Failure");
        }

        const endedSession = yield* Effect.exit(
          route.publish({
            session: sessionWithResources(created.session),
            ownerIdentity: created.ownerIdentity,
            revision: "rev-b",
            group,
            listener: {
              role: "sheet-workflows-api",
              host: "127.0.0.1",
              port: targetBase.port,
              processId: targetBase.processId,
            },
            admitWorkflowRequest: (request) =>
              request.forward.pipe(
                Effect.map((value) => ({ value, continuationId: "ended-session", group })),
              ),
          }),
        );
        expect(endedSession._tag).toBe("Failure");
        expect(
          revisionBPublished,
          JSON.stringify({
            readyRevisions,
            publishedRouteProbeRevisions,
            publishAttempts,
            publishFailures,
            supervisorFailures,
          }),
        ).toBe(true);
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
              new Request(
                `${/* oxlint-disable typescript/restrict-template-expressions -- inherited master site */ origin /* oxlint-enable typescript/restrict-template-expressions -- inherited master site */}sync/v50/connect`,
                {
                  headers: {
                    ...f.carol,
                    host: f.routeC.hostname,
                    origin: `https://${f.routeC.hostname}`,
                    cookie: "shared-token=must-not-forward",
                    accept: "application/json",
                  },
                },
              ),
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
              new Request(
                `${/* oxlint-disable typescript/restrict-template-expressions -- inherited master site */ origin /* oxlint-enable typescript/restrict-template-expressions -- inherited master site */}sync/v50/connect`,
                {
                  headers: {
                    ...f.carol,
                    host: f.routeC.hostname,
                    origin: "https://external.example",
                    "sec-fetch-site": "cross-site",
                    "sec-fetch-mode": "navigate",
                    "sec-fetch-dest": "document",
                  },
                },
              ),
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
              new Request(
                `${/* oxlint-disable typescript/restrict-template-expressions -- inherited master site */ workflowOrigin /* oxlint-enable typescript/restrict-template-expressions -- inherited master site */}workflows/unknown`,
                {
                  headers: {
                    ...f.carol,
                    host: f.routeC.hostname,
                    origin: `https://${f.routeC.hostname}`,
                  },
                },
              ),
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
        const created = yield* f.createSession("erin", "application", "sheet-auth");
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

it.effect("binds a per-session public origin to its allocated listener port and route scope", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const listenerPort = 45_331;
      const gateway = yield* makePreviewGateway({
        domain: "dev.example.test",
        controller: f.controller,
        adapters: f.adapters,
        now: f.now,
        publicPort: () => listenerPort,
        listenerLeaseManagement: true,
      });
      const route = yield* gateway.register(f.c.target, f.c.ownerIdentity);
      expect(route.publicPort).toBe(listenerPort);
      expect(gateway.applicationOrigin(f.c.target.sessionId, f.c.target.role)).toBe(
        `https://${route.hostname}:${listenerPort}`,
      );
      expect(gateway.applicationOrigin(f.d.target.sessionId, f.d.target.role)).toBeUndefined();

      const handler = yield* HttpRouter.toHttpEffect(
        PreviewGatewayHttpRoutes(gateway).pipe(Layer.provide(HttpRouter.layer)),
      );
      const publicRequest = (
        hostname: string,
        port: number,
        proof: Readonly<Record<string, string>>,
      ) =>
        handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`https://${hostname}:${port}/`, {
                method: "GET",
                headers: {
                  ...proof,
                  host: `${hostname}:${port}`,
                  origin: `https://${hostname}:${port}`,
                },
              }),
            ),
          ),
        );
      const observationCount = f.applicationObservations.length;
      const ownResponse = yield* publicRequest(route.hostname, listenerPort, f.carol);
      expect(ownResponse.status).toBe(201);
      expect(f.applicationObservations.at(-1)?.sessionId).toBe(f.c.target.sessionId);

      const afterOwnRequest = f.applicationObservations.length;
      const wrongPort = yield* publicRequest(route.hostname, listenerPort + 1, f.carol);
      expect(wrongPort.status).toBe(403);
      expect(f.applicationObservations).toHaveLength(afterOwnRequest);

      const sibling = yield* publicRequest(f.routeD.hostname, listenerPort, f.dave);
      expect(sibling.status).toBe(503);
      expect(f.applicationObservations).toHaveLength(afterOwnRequest);
      expect(f.applicationObservations.length).toBeGreaterThan(observationCount);
    }),
  ),
);
