import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import { Effect, Exit, Fiber } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect } from "vitest";
import {
  listenerSessionIdForAction,
  makeEphemeralListenerPortCandidate,
  readStoredListenerPort,
  selectUnleasedListenerPort,
  type ListenerPortProbe,
} from "./preview-gateway-session-layer";
import { PreviewGatewayError } from "./preview-gateway";

const withDatabase = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(
    Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    Effect.provide(NodeServices.layer),
  );

const createLeaseSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE preview_sessions (
    id TEXT PRIMARY KEY, identity_digest TEXT NOT NULL, generation INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE preview_gateway_routes (
    hostname TEXT PRIMARY KEY, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
    target TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE preview_gateway_listener_leases (
    session_id TEXT PRIMARY KEY, owner_identity_digest TEXT NOT NULL,
    generation INTEGER NOT NULL, public_port INTEGER NOT NULL UNIQUE
  )`;
});

const isIdentityMismatch = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) return false;
  return exit.cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      reason.error instanceof PreviewGatewayError &&
      reason.error.reason === "identity-mismatch",
  );
};

const isUnavailable = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) return false;
  return exit.cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      reason.error instanceof PreviewGatewayError &&
      reason.error.reason === "unavailable",
  );
};

class ControlledListenerPortProbe implements ListenerPortProbe {
  readonly started: Promise<void>;
  private signalStarted: () => void = () => {};
  private signalClosed: () => void = () => {};
  private errorListener: ((error: Error) => void) | undefined;
  private listeningListener: (() => void) | undefined;
  private listening = false;
  closeCalls = 0;
  readonly closed: Promise<void>;

  constructor() {
    this.started = new Promise((resolve) => {
      this.signalStarted = resolve;
    });
    this.closed = new Promise((resolve) => {
      this.signalClosed = resolve;
    });
  }

  isListening = () => this.listening;
  addressPort = () => 45_123;
  listen = (_host: string) => this.signalStarted();
  close = () => {
    this.closeCalls += 1;
    this.listening = false;
    this.signalClosed();
    return this.closed;
  };
  onError = (listener: (error: Error) => void) => {
    this.errorListener = listener;
  };
  offError = (listener: (error: Error) => void) => {
    if (this.errorListener === listener) this.errorListener = undefined;
  };
  onListening = (listener: () => void) => {
    this.listeningListener = listener;
  };
  offListening = (listener: () => void) => {
    if (this.listeningListener === listener) this.listeningListener = undefined;
  };

  emitBindError(error: Error) {
    if (this.errorListener === undefined) throw error;
    this.errorListener(error);
  }

  get hasErrorListener() {
    return this.errorListener !== undefined;
  }

  get hasListeningListener() {
    return this.listeningListener !== undefined;
  }

  emitListening() {
    this.listening = true;
    const listener = this.listeningListener;
    this.listeningListener = undefined;
    listener?.();
  }
}

it.effect("reuses a saved listener only for compatible resume, not a separate recreate", () =>
  Effect.sync(() => {
    expect(listenerSessionIdForAction("resume", "old-session")).toBe("old-session");
    expect(listenerSessionIdForAction("recreate", "old-session")).toBeUndefined();
    expect(listenerSessionIdForAction("start", undefined)).toBeUndefined();
    expect(listenerSessionIdForAction(undefined, "old-session")).toBeUndefined();
  }),
);

it.effect("keeps handling a pending listener bind error after acquisition is interrupted", () =>
  Effect.gen(function* () {
    const probe = new ControlledListenerPortProbe();
    const pending = yield* makeEphemeralListenerPortCandidate(() => probe)("127.0.0.1").pipe(
      Effect.forkChild,
    );
    yield* Effect.promise(() => probe.started);
    yield* Fiber.interrupt(pending);
    yield* Fiber.interrupt(pending);

    expect(probe.hasErrorListener).toBe(true);

    const emitted = yield* Effect.exit(
      Effect.sync(() => probe.emitBindError(new Error("listener bind failed"))),
    );

    expect(Exit.isSuccess(emitted)).toBe(true);
    yield* Effect.promise(() => probe.closed);
    expect({
      hasErrorListener: probe.hasErrorListener,
      hasListeningListener: probe.hasListeningListener,
      closeCalls: probe.closeCalls,
    }).toEqual({
      hasErrorListener: false,
      hasListeningListener: false,
      closeCalls: 1,
    });
  }),
);

it.live("uses the Node listener adapter to choose a real ephemeral loopback port", () =>
  Effect.gen(function* () {
    const port = yield* makeEphemeralListenerPortCandidate()("127.0.0.1");

    expect(Number.isSafeInteger(port) && port > 0 && port <= 65_535).toBe(true);
  }),
);

it.effect("closes a listener that finishes binding after its allocation is interrupted", () =>
  Effect.gen(function* () {
    const probe = new ControlledListenerPortProbe();
    const pending = yield* makeEphemeralListenerPortCandidate(() => probe)("127.0.0.1").pipe(
      Effect.forkChild,
    );
    yield* Effect.promise(() => probe.started);
    yield* Fiber.interrupt(pending);

    probe.emitListening();
    yield* Effect.promise(() => probe.closed);

    expect({
      hasErrorListener: probe.hasErrorListener,
      hasListeningListener: probe.hasListeningListener,
      closeCalls: probe.closeCalls,
    }).toEqual({
      hasErrorListener: false,
      hasListeningListener: false,
      closeCalls: 1,
    });
  }),
);

it.effect("keeps ordinary candidate error and success outcomes typed and owned", () =>
  Effect.gen(function* () {
    const failedProbe = new ControlledListenerPortProbe();
    const failed = yield* makeEphemeralListenerPortCandidate(() => failedProbe)("127.0.0.1").pipe(
      Effect.forkChild,
    );
    yield* Effect.promise(() => failedProbe.started);
    failedProbe.emitBindError(new Error("normal bind failure"));
    const failure = yield* Effect.exit(Fiber.join(failed));

    const successfulProbe = new ControlledListenerPortProbe();
    const successful = yield* makeEphemeralListenerPortCandidate(() => successfulProbe)(
      "127.0.0.1",
    ).pipe(Effect.forkChild);
    yield* Effect.promise(() => successfulProbe.started);
    successfulProbe.emitListening();
    const port = yield* Fiber.join(successful);
    yield* Effect.promise(() => successfulProbe.closed);
    yield* Fiber.interrupt(successful);

    expect({
      typedFailure: isUnavailable(failure),
      port,
      failedProbeClosed: failedProbe.closeCalls,
      failedProbeListenersRemoved:
        !failedProbe.hasErrorListener && !failedProbe.hasListeningListener,
      successfulProbeClosed: successfulProbe.closeCalls,
      successfulErrorListenerRemoved: !successfulProbe.hasErrorListener,
      successfulListeningListenerRemoved: !successfulProbe.hasListeningListener,
    }).toEqual({
      typedFailure: true,
      port: 45_123,
      failedProbeClosed: 1,
      failedProbeListenersRemoved: true,
      successfulProbeClosed: 1,
      successfulErrorListenerRemoved: true,
      successfulListeningListenerRemoved: true,
    });
  }),
);

it.effect("reselects a bounded port candidate that belongs to a retained session lease", () =>
  Effect.gen(function* () {
    const candidates = [45_123, 45_124];
    const observed: number[] = [];
    const selected = yield* selectUnleasedListenerPort(
      "127.0.0.1",
      [45_123],
      () =>
        Effect.sync(() => {
          const candidate = candidates.shift();
          if (candidate === undefined) throw new Error("candidate control was exhausted");
          observed.push(candidate);
          return candidate;
        }),
      2,
    );

    expect({ selected, observed }).toEqual({ selected: 45_124, observed: [45_123, 45_124] });
  }),
);

it.effect("fails after its configured port candidate attempts are exhausted", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const result = yield* Effect.exit(
      selectUnleasedListenerPort(
        "127.0.0.1",
        [45_123],
        () =>
          Effect.sync(() => {
            attempts += 1;
            return 45_123;
          }),
        2,
      ),
    );

    expect({ failed: Exit.isFailure(result), attempts }).toEqual({ failed: true, attempts: 2 });
  }),
);

it.effect("allows a new session without route history to select a fresh listener", () =>
  withDatabase(
    Effect.gen(function* () {
      yield* createLeaseSchema;
      const stored = yield* readStoredListenerPort("never-published-session");
      expect(stored).toBeUndefined();
      const freshPort = yield* selectUnleasedListenerPort("127.0.0.1", [], () =>
        Effect.succeed(45_678),
      );
      expect(freshPort).toBe(45_678);
    }),
  ),
);

it.effect("fails closed when a published route has no matching durable listener lease", () =>
  withDatabase(
    Effect.gen(function* () {
      yield* createLeaseSchema;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO preview_sessions (id, identity_digest, generation)
        VALUES ('published-session', 'owner-digest', 1)`;
      yield* sql`INSERT INTO preview_gateway_routes
        (hostname, session_id, generation, target, removed)
        VALUES ('p-published-session-sheet-web.dev.example.test', 'published-session', 1, '{}', 1)`;

      const result = yield* Effect.exit(readStoredListenerPort("published-session"));
      expect(isIdentityMismatch(result)).toBe(true);
    }),
  ),
);

it.effect("rejects a durable listener lease owned by a different session identity", () =>
  withDatabase(
    Effect.gen(function* () {
      yield* createLeaseSchema;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO preview_sessions (id, identity_digest, generation)
        VALUES ('owned-session', 'current-owner-digest', 3)`;
      yield* sql`INSERT INTO preview_gateway_routes
        (hostname, session_id, generation, target, removed)
        VALUES ('p-owned-session-sheet-web.dev.example.test', 'owned-session', 2, '{}', 0)`;
      yield* sql`INSERT INTO preview_gateway_listener_leases
        (session_id, owner_identity_digest, generation, public_port)
        VALUES ('owned-session', 'different-owner-digest', 2, 45_123)`;

      const result = yield* Effect.exit(readStoredListenerPort("owned-session"));
      expect(isIdentityMismatch(result)).toBe(true);
    }),
  ),
);

it.effect("reuses an exact retained lease for an existing published session", () =>
  withDatabase(
    Effect.gen(function* () {
      yield* createLeaseSchema;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO preview_sessions (id, identity_digest, generation)
        VALUES ('resumable-session', 'owner-digest', 4)`;
      yield* sql`INSERT INTO preview_gateway_routes
        (hostname, session_id, generation, target, removed)
        VALUES ('p-resumable-session-sheet-web.dev.example.test', 'resumable-session', 3, '{}', 0)`;
      yield* sql`INSERT INTO preview_gateway_listener_leases
        (session_id, owner_identity_digest, generation, public_port)
        VALUES ('resumable-session', 'owner-digest', 3, 45_321)`;

      expect(yield* readStoredListenerPort("resumable-session")).toBe(45_321);
    }),
  ),
);
