import { createServer as createTcpServer } from "node:net";
import { Effect, Layer, Option, Predicate } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { makePreviewGateway, PreviewGateway, PreviewGatewayError } from "./preview-gateway";
import { PreviewGatewayHttpsLive } from "./preview-gateway-http";
import { PreviewGatewayRuntime } from "./preview-gateway-runtime";
import { PreviewSessionController } from "./preview-sessions";
import { PreviewWorkflowApiApplicationRoute } from "./preview-workflow-api-host";
import { makePreviewWorkflowApiApplicationRoute } from "./preview-workflow-api-route";

const unavailable = () => new PreviewGatewayError({ reason: "unavailable" });
const identityMismatch = () => new PreviewGatewayError({ reason: "identity-mismatch" });

export const listenerSessionIdForAction = (
  action: string | undefined,
  sessionId: string | undefined,
) => (action === "resume" ? sessionId : undefined);

const isUsablePort = (port: number) => Number.isSafeInteger(port) && port >= 1 && port <= 65535;
const isUsableGeneration = (generation: number) =>
  Number.isSafeInteger(generation) && generation >= 1;

const readPortWithoutLease = (sql: SqlClient.SqlClient, sessionId: string) =>
  Effect.gen(function* () {
    const routes = yield* sql`SELECT generation FROM preview_gateway_routes
      WHERE session_id=${sessionId}`;
    if (routes.length > 0) return yield* Effect.fail(identityMismatch());
    // A never-published session has no port identity to recover.
    return undefined;
  });

const leaseMatchesSession = (
  ownerDigest: unknown,
  sessionDigest: unknown,
  leaseGeneration: number,
  sessionGeneration: number,
) =>
  ownerDigest === sessionDigest &&
  isUsableGeneration(leaseGeneration) &&
  isUsableGeneration(sessionGeneration) &&
  sessionGeneration >= leaseGeneration;

const routeGenerationsFitLease = (routes: readonly unknown[], leaseGeneration: number) =>
  routes.every((route) => {
    if (!Predicate.isObject(route)) return false;
    const routeGeneration = Number(Reflect.get(route, "generation"));
    return isUsableGeneration(routeGeneration) && routeGeneration <= leaseGeneration;
  });

const readExistingListenerPort = (sql: SqlClient.SqlClient, sessionId: string, lease: unknown) =>
  Effect.gen(function* () {
    if (!Predicate.isObject(lease)) return yield* Effect.fail(identityMismatch());
    const routes = yield* sql`SELECT generation FROM preview_gateway_routes
      WHERE session_id=${sessionId}`;
    if (routes.length === 0) return yield* Effect.fail(identityMismatch());
    const sessionRows = yield* sql`SELECT identity_digest, generation FROM preview_sessions
      WHERE id=${sessionId}`;
    if (sessionRows.length !== 1 || !Predicate.isObject(sessionRows[0]))
      return yield* Effect.fail(identityMismatch());
    const session = sessionRows[0];
    const port = Number(Reflect.get(lease, "public_port"));
    const leaseGeneration = Number(Reflect.get(lease, "generation"));
    const sessionGeneration = Number(Reflect.get(session, "generation"));
    const ownerDigest = Reflect.get(lease, "owner_identity_digest");
    const sessionDigest = Reflect.get(session, "identity_digest");
    if (!isUsablePort(port)) return yield* Effect.fail(identityMismatch());
    if (!leaseMatchesSession(ownerDigest, sessionDigest, leaseGeneration, sessionGeneration))
      return yield* Effect.fail(identityMismatch());
    if (!routeGenerationsFitLease(routes, leaseGeneration))
      return yield* Effect.fail(identityMismatch());
    return port;
  });

export const readStoredListenerPort = (sessionId: string | undefined) =>
  Effect.gen(function* () {
    if (sessionId === undefined) return undefined;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT owner_identity_digest, generation, public_port
      FROM preview_gateway_listener_leases WHERE session_id=${sessionId}`;
    if (rows.length === 0) return yield* readPortWithoutLease(sql, sessionId);
    if (rows.length !== 1) return yield* Effect.fail(identityMismatch());
    return yield* readExistingListenerPort(sql, sessionId, rows[0]);
  });

export type ListenerPortCandidate = (host: string) => Effect.Effect<number, PreviewGatewayError>;

/** Narrow Node listener boundary so pending bind outcomes can be controlled in package tests. */
export type ListenerPortProbe = {
  readonly isListening: () => boolean;
  readonly addressPort: () => number | undefined;
  readonly listen: (host: string) => void;
  readonly close: () => Promise<void>;
  readonly onError: (listener: (error: Error) => void) => void;
  readonly offError: (listener: (error: Error) => void) => void;
  readonly onListening: (listener: () => void) => void;
  readonly offListening: (listener: () => void) => void;
};

const makeNodeListenerPortProbe = (): ListenerPortProbe => {
  const server = createTcpServer();
  return {
    isListening: () => server.listening,
    addressPort: () => {
      const address = server.address();
      return address === null || typeof address === "string" ? undefined : address.port;
    },
    listen: (host) => {
      server.listen({ host, port: 0 });
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
    onError: (listener) => {
      server.once("error", listener);
    },
    offError: (listener) => {
      server.off("error", listener);
    },
    onListening: (listener) => {
      server.once("listening", listener);
    },
    offListening: (listener) => {
      server.off("listening", listener);
    },
  };
};

export const makeEphemeralListenerPortCandidate =
  (makeProbe: () => ListenerPortProbe = makeNodeListenerPortProbe): ListenerPortCandidate =>
  (host) =>
    Effect.callback((resume) => {
      const server = makeProbe();
      let completed = false;
      let cancelled = false;
      let closing: Promise<void> | undefined;
      const close = () => {
        if (closing !== undefined) return closing;
        closing = server.close();
        return closing;
      };
      const cleanupListeners = () => {
        server.offError(onError);
        server.offListening(onListening);
      };
      const finish = (effect: Effect.Effect<number, PreviewGatewayError>) => {
        if (completed) return;
        completed = true;
        void close().then(() => {
          cleanupListeners();
          if (!cancelled) resume(effect);
        });
      };
      const onError = (_error: Error) => finish(Effect.fail(unavailable()));
      const onListening = () => {
        if (cancelled) {
          void close().then(cleanupListeners);
          return;
        }
        const port = server.addressPort();
        if (port === undefined) {
          finish(Effect.fail(unavailable()));
          return;
        }
        finish(Effect.succeed(port));
      };
      server.onError(onError);
      server.onListening(onListening);
      server.listen(host);
      return Effect.sync(() => {
        cancelled = true;
        // Keep the error handler attached until a pending bind reports its outcome.
        // Removing the last listener here would make a late Node `error` event fatal.
        if (!completed && server.isListening()) void close().then(cleanupListeners);
      });
    });

const ephemeralListenerPortCandidate = makeEphemeralListenerPortCandidate();

const makeRetainedPortSet = (ports: readonly number[]) =>
  Effect.gen(function* () {
    const retained = new Set<number>();
    for (const port of ports) {
      if (!isUsablePort(port)) return yield* Effect.fail(unavailable());
      retained.add(port);
    }
    return retained;
  });

const selectCandidateOutsideRetainedPorts = (
  host: string,
  retained: ReadonlySet<number>,
  candidatePort: ListenerPortCandidate,
  maxAttempts: number,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate = yield* candidatePort(host);
      if (!isUsablePort(candidate)) return yield* Effect.fail(unavailable());
      if (!retained.has(candidate)) return candidate;
    }
    return yield* Effect.fail(unavailable());
  });

export const selectUnleasedListenerPort = (
  host: string,
  retainedPorts: readonly number[],
  candidatePort: ListenerPortCandidate = ephemeralListenerPortCandidate,
  maxAttempts = 4,
) =>
  makeRetainedPortSet(retainedPorts).pipe(
    Effect.flatMap((retained) =>
      selectCandidateOutsideRetainedPorts(host, retained, candidatePort, maxAttempts),
    ),
  );

/**
 * The session CLI's gateway composition. Kept as one production module so the
 * command and process-level tests exercise the same route and listener layers.
 */
export const makePreviewGatewaySessionLayer = <
  RuntimeError,
  RuntimeRequirements,
  SessionError,
  SessionRequirements,
>(input: {
  readonly runtimeLayer: Layer.Layer<PreviewGatewayRuntime, RuntimeError, RuntimeRequirements>;
  readonly sessionLayer: Layer.Layer<
    import("./preview-sessions").PreviewSessionController,
    SessionError,
    SessionRequirements
  >;
  readonly now: () => number;
  readonly action?: string | undefined;
  readonly sessionId?: string;
  readonly listenerLeaseManagement?: boolean;
  readonly onListenerPort?: (port: number) => void;
  readonly allocateListenerPortCandidate?: ListenerPortCandidate;
}) => {
  const listener = { port: 0 };
  const gatewayLayer = Layer.effect(
    PreviewGateway,
    Effect.gen(function* () {
      const controller = yield* PreviewSessionController;
      const runtimeState = yield* Effect.serviceOption(PreviewGatewayRuntime);
      const configured =
        Option.isSome(runtimeState) && Option.isSome(runtimeState.value.runtime)
          ? runtimeState.value.runtime.value
          : undefined;
      if (configured !== undefined)
        return yield* makePreviewGateway({
          domain: configured.domain,
          controller,
          adapters: configured.adapters,
          now: input.now,
          publicPort: () => listener.port,
          ...(input.listenerLeaseManagement === undefined
            ? {}
            : { listenerLeaseManagement: input.listenerLeaseManagement }),
        });
      return yield* makePreviewGateway({
        domain: "",
        controller,
        now: input.now,
        ...(input.listenerLeaseManagement === undefined
          ? {}
          : { listenerLeaseManagement: input.listenerLeaseManagement }),
      });
    }),
  ).pipe(Layer.provideMerge(input.sessionLayer), Layer.provideMerge(input.runtimeLayer));
  const httpsLayer = Layer.unwrap(
    Effect.gen(function* () {
      const runtime = yield* Effect.serviceOption(PreviewGatewayRuntime);
      const gateway = yield* Effect.serviceOption(PreviewGateway);
      if (Option.isNone(runtime) || Option.isNone(runtime.value.runtime) || Option.isNone(gateway))
        return Layer.empty;
      const sql = yield* SqlClient.SqlClient;
      const listenerSessionId = listenerSessionIdForAction(input.action, input.sessionId);
      const storedPort = yield* readStoredListenerPort(listenerSessionId);
      const retainedRows =
        storedPort === undefined
          ? yield* sql`SELECT public_port FROM preview_gateway_listener_leases`
          : [];
      const retainedPorts = retainedRows.map((row) => Number(row.public_port));
      const selectedPort =
        storedPort ??
        (yield* selectUnleasedListenerPort(
          runtime.value.runtime.value.https.host,
          retainedPorts,
          input.allocateListenerPortCandidate,
        ));
      const https = {
        ...runtime.value.runtime.value.https,
        port: selectedPort,
      };
      return PreviewGatewayHttpsLive(https, (port) => {
        listener.port = port;
        input.onListenerPort?.(port);
      }).pipe(Layer.provide(Layer.succeed(PreviewGateway, gateway.value)));
    }),
  ).pipe(Layer.provideMerge(gatewayLayer));
  return Layer.effect(
    PreviewWorkflowApiApplicationRoute,
    Effect.gen(function* () {
      const gateway = yield* PreviewGateway;
      return makePreviewWorkflowApiApplicationRoute(gateway);
    }),
  ).pipe(Layer.provideMerge(httpsLayer));
};
