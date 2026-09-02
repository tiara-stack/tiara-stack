import { Zero } from "@rocicorp/zero";
import { createIsomorphicFn } from "@tanstack/react-start";
import { Duration, Effect, Match, Option, Predicate, Redacted, Schema, Stream } from "effect";
import { Atom } from "effect/unstable/reactivity";
import {
  WorkflowObservationInvalidData,
  WorkflowTransportUnavailable,
  type WorkflowEnqueueError,
  type WorkflowObservationError,
} from "effect-zero-workflow/contract/transport";
import {
  type AnyWorkflowContract,
  type RunReference,
  type WorkflowClient,
  type WorkflowContractInput,
  type WorkflowRun,
} from "effect-zero-workflow/contract";
import { ZeroClient as BaseZeroClient } from "typhoon-zero/client";
import {
  makeSheetClient,
  mutators,
  schema,
  type Schema as SheetZeroSchema,
  type SheetClient,
} from "sheet-zero-api";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeSheetWorkflowHttpClients } from "sheet-workflow-http-client";
import { authClientAtom, sessionAtom } from "#/lib/auth";
import { sheetWorkflowsBaseUrlAtom, sheetZeroBaseUrlAtom } from "#/lib/configAtoms";
import { ensureSheetWebOAuthAccessToken, refreshSheetWebOAuthAccessToken } from "#/lib/oauth";
import { runtimeAtom } from "#/lib/runtime";
import { getAccount } from "sheet-auth/client";

class SheetWebZeroBrowserOnlyError extends Schema.TaggedErrorClass<SheetWebZeroBrowserOnlyError>()(
  "SheetWebZeroBrowserOnlyError",
  {
    message: Schema.Literal("Sheet Zero is available after browser hydration"),
  },
) {}

class SheetWebZeroUnauthorized extends Schema.TaggedErrorClass<SheetWebZeroUnauthorized>()(
  "SheetWebZeroUnauthorized",
  { message: Schema.String },
) {}

class SheetWebWorkflowFailure extends Schema.TaggedErrorClass<SheetWebWorkflowFailure>()(
  "SheetWebWorkflowFailure",
  {
    workflow: Schema.String,
    message: Schema.String,
    failure: Schema.Unknown,
  },
) {}

type WorkflowZeroContext = {
  readonly principalId: string;
  readonly visibilityKey: string;
};
type BrowserZero = Zero<SheetZeroSchema, undefined, WorkflowZeroContext>;
type SheetWorkflowClients = ReturnType<typeof makeSheetWorkflowHttpClients>;
type WorkflowInvoker<Contract extends AnyWorkflowContract> = Pick<
  WorkflowClient<Contract, WorkflowEnqueueError, WorkflowObservationError>,
  "enqueue" | "get"
>;
const unavailable = (operation: "Enqueue" | "Observe", message: string) =>
  new WorkflowTransportUnavailable({ operation, retryable: true, message });

const invalidWorkflowData = (message: string) => new WorkflowObservationInvalidData({ message });

const workflowObservationInitialPollInterval = Duration.millis(250);
const workflowObservationMaxPollInterval = Duration.seconds(2);
const workflowObservationTimeout = Duration.seconds(60);

const nextWorkflowObservationPollInterval = (current: Duration.Duration) =>
  Duration.min(Duration.times(current, 2), workflowObservationMaxPollInterval);

const observeWorkflowUntilTerminal = <Contract extends AnyWorkflowContract>(
  workflow: WorkflowInvoker<Contract>,
  reference: RunReference<Contract>,
  pollInterval: Duration.Duration = workflowObservationInitialPollInterval,
): Effect.Effect<Option.Option<WorkflowRun<Contract>>, WorkflowObservationError> =>
  workflow.get(reference).pipe(
    Stream.filter((run): run is Option.Some<WorkflowRun<Contract>> => Option.isSome(run)),
    Stream.map((run) => run.value),
    Stream.takeUntil((run) => run.result._tag !== "Pending"),
    Stream.runLast,
    Effect.flatMap((observed) => {
      const pollAgain = Effect.sleep(pollInterval).pipe(
        Effect.flatMap(() =>
          Effect.suspend(() =>
            observeWorkflowUntilTerminal(
              workflow,
              reference,
              nextWorkflowObservationPollInterval(pollInterval),
            ),
          ),
        ),
      );
      return Option.match(observed, {
        onNone: () => pollAgain,
        onSome: (run) =>
          run.result._tag === "Pending" ? pollAgain : Effect.succeed(Option.some(run)),
      });
    }),
  );

const sheetZeroAuthReconnectMaxAttempts = 3;
const sheetZeroAuthReconnectBaseDelayMs = 250;

const isZeroApiServerError = (reason: string) =>
  reason.includes("Fetch from API server returned non-OK status");

export const shouldReconnectSheetZeroAuth = (
  state: BrowserZero["connection"]["state"]["current"],
) =>
  Match.value(state).pipe(
    Match.when({ name: "needs-auth" }, () => true),
    Match.when({ name: "error" }, ({ reason }) => isZeroApiServerError(reason)),
    Match.orElse(() => false),
  );

type SheetZeroAuthReconnectOptions = {
  readonly reconnect: (forceRefresh: boolean) => Promise<void>;
  readonly isClosed: () => boolean;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly log?: (
    message: string,
    details: { readonly attempt: number; readonly error: unknown },
  ) => void;
};

export const runSheetZeroAuthReconnect = async ({
  reconnect,
  isClosed,
  sleep = (delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
  log = (message, details) => console.warn(message, details),
}: SheetZeroAuthReconnectOptions): Promise<boolean> => {
  for (let attempt = 1; attempt <= sheetZeroAuthReconnectMaxAttempts; attempt += 1) {
    if (isClosed()) return false;
    if (attempt > 1) {
      await sleep(sheetZeroAuthReconnectBaseDelayMs * 2 ** (attempt - 2));
    }
    if (isClosed()) return false;

    try {
      await reconnect(attempt === 1);
      return true;
    } catch (error) {
      log("Sheet Zero authentication reconnect attempt failed", { attempt, error });
    }
  }
  return false;
};

interface SheetWebZeroClient {
  readonly principalId: string;
  readonly endpoint: URL;
  readonly zero: BrowserZero;
  readonly sheet: SheetClient;
  readonly workflows: SheetWorkflowClients;
  readonly refreshAuth: (accessToken: string) => void;
  readonly close: () => void;
}

const makeSheetWebZeroClient = (options: {
  readonly principalId: string;
  readonly endpoint: URL;
  readonly workflowEndpoint: URL;
  readonly accessToken: string;
  readonly httpClient: HttpClient.HttpClient;
}): SheetWebZeroClient => {
  let currentAccessToken = options.accessToken;
  const zero = new Zero({
    cacheURL: options.endpoint.href.replace(/\/$/, ""),
    userID: options.principalId,
    auth: options.accessToken,
    schema,
    mutators,
    context: {
      principalId: options.principalId,
      visibilityKey: `account:${options.principalId}`,
    },
  });
  const zeroClient = Effect.runSync(
    BaseZeroClient.ZeroClient<SheetZeroSchema, undefined, WorkflowZeroContext>().make(zero),
  );
  const sheet = Effect.runSync(makeSheetClient(zeroClient));
  const allWorkflows = makeSheetWorkflowHttpClients(options.httpClient, {
    baseUrl: options.workflowEndpoint.href,
    transformRequest: (request) => HttpClientRequest.bearerToken(request, currentAccessToken),
  });
  let closed = false;
  let refreshing = false;

  const reconnect = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      await runSheetZeroAuthReconnect({
        isClosed: () => closed,
        reconnect: async (forceRefresh) => {
          const accessToken = await Effect.runPromise(
            forceRefresh ? refreshSheetWebOAuthAccessToken() : ensureSheetWebOAuthAccessToken(),
          );
          if (Option.isNone(accessToken)) {
            throw new Error("Sheet Zero authentication refresh returned no access token");
          }
          currentAccessToken = accessToken.value;
          await zero.connection.connect({ auth: accessToken.value });
          if (zero.connection.state.current.name !== "connected") {
            throw new Error("Sheet Zero remained unauthenticated after reconnect");
          }
        },
      });
    } finally {
      refreshing = false;
    }
  };

  const unsubscribe = zero.connection.state.subscribe((state) => {
    if (shouldReconnectSheetZeroAuth(state)) void reconnect().catch(() => undefined);
  });

  return {
    principalId: options.principalId,
    endpoint: options.endpoint,
    zero,
    sheet,
    workflows: allWorkflows,
    refreshAuth: (accessToken) => {
      if (closed || accessToken === currentAccessToken) return;
      currentAccessToken = accessToken;
      void zero.connection.connect({ auth: accessToken });
    },
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      void zero.close();
    },
  };
};

type CachedSheetWebZeroClient = {
  readonly client: SheetWebZeroClient;
  holders: number;
  cached: boolean;
};

type SheetWebZeroClientLease = {
  readonly client: SheetWebZeroClient;
  readonly release: () => void;
};

const clients = new Map<string, CachedSheetWebZeroClient>();

const clientKey = (principalId: string, endpoint: URL, workflowEndpoint: URL) =>
  `${principalId}:${endpoint.href}:${workflowEndpoint.href}`;

const closeWhenUnused = (entry: CachedSheetWebZeroClient) => {
  if (entry.cached || entry.holders > 0) return;
  entry.client.close();
};

const retireClient = (key: string, entry: CachedSheetWebZeroClient) => {
  if (clients.get(key) === entry) clients.delete(key);
  entry.cached = false;
  closeWhenUnused(entry);
};

const clearSheetZeroClients = () => {
  for (const [key, entry] of clients) retireClient(key, entry);
  clients.clear();
};

const leaseClient = (key: string, entry: CachedSheetWebZeroClient): SheetWebZeroClientLease => {
  entry.holders += 1;
  let released = false;
  return {
    client: entry.client,
    release: () => {
      if (released) return;
      released = true;
      entry.holders -= 1;
      if (entry.holders === 0) retireClient(key, entry);
    },
  };
};

const acquireSheetWebZeroClient = (options: {
  readonly principalId: string;
  readonly endpoint: URL;
  readonly workflowEndpoint: URL;
  readonly accessToken: string;
  readonly httpClient: HttpClient.HttpClient;
}): SheetWebZeroClientLease => {
  const key = clientKey(options.principalId, options.endpoint, options.workflowEndpoint);
  const existing = clients.get(key);
  if (Predicate.isNotUndefined(existing)) {
    existing.client.refreshAuth(options.accessToken);
    return leaseClient(key, existing);
  }

  for (const [existingKey, entry] of clients) {
    if (existingKey !== key) {
      retireClient(existingKey, entry);
    }
  }

  const entry: CachedSheetWebZeroClient = {
    client: makeSheetWebZeroClient(options),
    holders: 0,
    cached: true,
  };
  clients.set(key, entry);
  return leaseClient(key, entry);
};

const browserSheetZeroClient = createIsomorphicFn()
  .server(
    (
      _principalId: string,
      _endpoint: URL,
      _workflowEndpoint: URL,
      _accessToken: string,
      _httpClient: HttpClient.HttpClient,
    ) =>
      Effect.fail(
        new SheetWebZeroBrowserOnlyError({
          message: "Sheet Zero is available after browser hydration",
        }),
      ),
  )
  .client(
    (
      principalId: string,
      endpoint: URL,
      workflowEndpoint: URL,
      accessToken: string,
      httpClient: HttpClient.HttpClient,
    ) =>
      Effect.try({
        try: () =>
          acquireSheetWebZeroClient({
            principalId,
            endpoint,
            workflowEndpoint,
            accessToken,
            httpClient,
          }),
        catch: () =>
          new SheetWebZeroUnauthorized({ message: "Sheet Zero could not be initialized" }),
      }),
  );

export const sheetZeroClientAtom = runtimeAtom
  .atom(
    Effect.fnUntraced(function* (get) {
      const session = yield* get.result(sessionAtom);
      if (Option.isNone(session)) {
        clearSheetZeroClients();
        return yield* Effect.fail(
          new SheetWebZeroUnauthorized({
            message: "Sheet Zero requires an authenticated principal",
          }),
        );
      }

      const endpoint = yield* get.result(sheetZeroBaseUrlAtom);
      const accessToken = yield* ensureSheetWebOAuthAccessToken();
      if (Option.isNone(accessToken)) {
        clearSheetZeroClients();
        return yield* Effect.fail(
          new SheetWebZeroUnauthorized({ message: "Sheet Zero requires an OAuth access token" }),
        );
      }

      const authClient = yield* get.result(authClientAtom);
      const account = yield* getAccount(
        authClient,
        ["discord"],
        Predicate.isNotUndefined(session.value.token)
          ? { Authorization: `Bearer ${Redacted.value(session.value.token)}` }
          : undefined,
      ).pipe(
        Effect.tapError(() => Effect.sync(clearSheetZeroClients)),
        Effect.mapError(
          () => new SheetWebZeroUnauthorized({ message: "Sheet Zero requires a Discord account" }),
        ),
      );
      const principalId = account.accountId;

      const workflowEndpoint = yield* get.result(sheetWorkflowsBaseUrlAtom);
      const httpClient = yield* HttpClient.HttpClient;
      const lease = yield* browserSheetZeroClient(
        principalId,
        endpoint,
        workflowEndpoint,
        accessToken.value,
        httpClient,
      );
      yield* Effect.addFinalizer(() => Effect.sync(lease.release));
      return lease.client;
    }),
  )
  .pipe(Atom.setIdleTTL(Duration.minutes(5)));

export const runSheetWorkflow = <
  Contract extends AnyWorkflowContract,
  SuccessSchema extends Schema.Codec<unknown, unknown, never, never>,
>(
  workflow: WorkflowInvoker<Contract>,
  input: WorkflowContractInput<Contract>,
  successSchema: SuccessSchema,
) =>
  Effect.gen(function* () {
    const reference = yield* workflow.enqueue(input).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(30),
        orElse: () => Effect.fail(unavailable("Enqueue", "Sheet Zero workflow enqueue timed out")),
      }),
    );
    const terminal = yield* observeWorkflowUntilTerminal(workflow, reference).pipe(
      Effect.timeoutOrElse({
        duration: workflowObservationTimeout,
        orElse: () =>
          Effect.fail(unavailable("Observe", "Sheet Zero workflow observation timed out")),
      }),
    );

    if (Option.isNone(terminal)) {
      return yield* Effect.fail(
        invalidWorkflowData("Sheet Zero completed observation without a workflow run"),
      );
    }

    return yield* Match.value(terminal.value.result).pipe(
      Match.discriminatorsExhaustive("_tag")({
        Success: ({ value }) => Schema.decodeUnknownEffect(successSchema)(value),
        Failure: ({ failure }) =>
          Effect.fail(
            new SheetWebWorkflowFailure({
              workflow: reference.contractIdentity,
              message: "The workflow did not complete successfully",
              failure,
            }),
          ),
        Pending: () =>
          Effect.fail(invalidWorkflowData("Sheet Zero returned a pending terminal workflow run")),
      }),
    );
  });
