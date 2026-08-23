import { getMutator, getQuery, Zero } from "@rocicorp/zero";
import { createIsomorphicFn } from "@tanstack/react-start";
import { Duration, Effect, Match, Option, Predicate, Schema, Stream } from "effect";
import { Atom } from "effect/unstable/reactivity";
import {
  makeWorkflowZeroGroup,
  type WorkflowZeroGroupOptions,
  ZeroMaterializedWorkflowRunRow,
} from "effect-zero-workflow/contract/zero";
import {
  WorkflowObservationInvalidData,
  WorkflowTransportUnavailable,
  WorkflowEnqueueRequest,
  workflowContractZeroGroupIdentifier,
  type WorkflowEnqueueError,
  type WorkflowObservationError,
} from "effect-zero-workflow/contract/transport";
import {
  type AnyWorkflowContract,
  type InvocationId,
  type WorkflowClient,
  type WorkflowContractInput,
  type WorkflowRun,
  WorkflowRunListFilter,
  makeRunReferenceSchema,
} from "effect-zero-workflow/contract";
import * as ZeroApi from "typhoon-zero/zeroApi";
import * as ZeroApiRegistry from "typhoon-zero/zeroApi/zeroApiRegistry";
import { ZeroClient as BaseZeroClient } from "typhoon-zero/client";
import {
  makeSheetClient,
  mutators,
  schema,
  type Schema as SheetZeroSchema,
  type SheetClient,
  zql,
} from "sheet-zero-api";
import { makeSheetWorkflowZeroClients } from "sheet-zero-api/workflows";
import { SheetWorkflowContracts } from "sheet-workflow-contracts";
import { ReadonlyJSONValue } from "typhoon-zero/schema";
import { sessionAtom } from "#/lib/auth";
import { sheetZeroBaseUrlAtom } from "#/lib/configAtoms";
import { ensureSheetWebOAuthAccessToken } from "#/lib/oauth";

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
type ZeroExecutor = BaseZeroClient.ZeroClient<SheetZeroSchema, undefined, WorkflowZeroContext>;
type MaterializedWorkflowRunRow = Schema.Schema.Type<typeof ZeroMaterializedWorkflowRunRow>;
type SheetWorkflowExecutor = Parameters<typeof makeSheetWorkflowZeroClients<never>>[0];
type SheetWorkflowClients = ReturnType<typeof makeSheetWorkflowZeroClients<never>>;
type WorkflowInvoker<Contract extends AnyWorkflowContract> = Pick<
  WorkflowClient<Contract, WorkflowEnqueueError, WorkflowObservationError>,
  "enqueue" | "get"
>;

const workflowRunOptionSchema = Schema.OptionFromNullishOr(ZeroMaterializedWorkflowRunRow);
const workflowRunListSchema = Schema.Array(ZeroMaterializedWorkflowRunRow);
type WorkflowQuery = ReturnType<
  WorkflowZeroGroupOptions<SheetZeroSchema, WorkflowZeroContext>["get"]
>;

// The runtime counterpart to SheetWebWorkflowClients. Types are erased at
// runtime, so keep the selected contract objects as the single source for the
// workflows mounted in the browser Zero API.
const browserWorkflowContracts = [
  SheetWorkflowContracts.discord.loadProfile,
  SheetWorkflowContracts.discord.loadWorkspaceChannels,
  SheetWorkflowContracts.discord.loadWorkspaceRoles,
  SheetWorkflowContracts.authorization.loadWorkspaceCapabilities,
  SheetWorkflowContracts.schedules.loadWorkspace,
  SheetWorkflowContracts.notifications.loadSupportedClients,
  SheetWorkflowContracts.conversations.setLockdown,
] as const;

const workflowZeroGroupOptions: WorkflowZeroGroupOptions<SheetZeroSchema, WorkflowZeroContext> = {
  enqueue: async () => undefined,
  get: ({ invocationId, context }) =>
    zql.workflowRun
      .where("runId", "=", invocationId)
      .where("visibilityKey", "=", context.visibilityKey)
      .one() as WorkflowQuery,
  list: ({ context }) =>
    zql.workflowRun.where("visibilityKey", "=", context.visibilityKey) as WorkflowQuery,
};

const workflowZeroGroups = browserWorkflowContracts.map((contract) =>
  makeWorkflowZeroGroup(contract, workflowZeroGroupOptions),
);

const [firstWorkflowZeroGroup, ...remainingWorkflowZeroGroups] = workflowZeroGroups;
if (Predicate.isUndefined(firstWorkflowZeroGroup)) {
  throw new Error("Sheet web workflow Zero API requires at least one mounted workflow contract");
}

const workflowZeroApi = remainingWorkflowZeroGroups.reduce(
  (api, group) => api.add(group),
  ZeroApi.make("sheet-workflows").add(firstWorkflowZeroGroup),
);

const workflowQueries = ZeroApiRegistry.toQueries<typeof workflowZeroApi, SheetZeroSchema>(
  workflowZeroApi,
  {
    visibilities: ["public"],
  },
);

const workflowMutators = ZeroApiRegistry.toMutators<typeof workflowZeroApi, SheetZeroSchema>(
  workflowZeroApi,
  {
    visibilities: ["public"],
  },
);

const workflowQueryFor = (contract: AnyWorkflowContract, endpoint: "get" | "list") =>
  getQuery(workflowQueries, `${workflowContractZeroGroupIdentifier(contract)}.${endpoint}`);

const workflowMutatorFor = (contract: AnyWorkflowContract, endpoint: "enqueue") =>
  getMutator(workflowMutators, `${workflowContractZeroGroupIdentifier(contract)}.${endpoint}`);

const unavailable = (operation: "Enqueue" | "Observe", message: string) =>
  new WorkflowTransportUnavailable({ operation, retryable: true, message });

const invalidWorkflowData = (message: string) => new WorkflowObservationInvalidData({ message });

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
  readonly reconnect: () => Promise<void>;
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
      await reconnect();
      return true;
    } catch (error) {
      log("Sheet Zero authentication reconnect attempt failed", { attempt, error });
    }
  }
  return false;
};

const decodeWorkflowRow = (
  value: unknown,
): Effect.Effect<Option.Option<MaterializedWorkflowRunRow>, WorkflowObservationInvalidData> =>
  Schema.decodeUnknownEffect(workflowRunOptionSchema)(value).pipe(
    Effect.mapError(() => invalidWorkflowData("Sheet Zero returned an invalid workflow run")),
  );

const decodeWorkflowRows = (
  value: unknown,
): Effect.Effect<ReadonlyArray<MaterializedWorkflowRunRow>, WorkflowObservationInvalidData> =>
  Schema.decodeUnknownEffect(workflowRunListSchema)(value).pipe(
    Effect.mapError(() => invalidWorkflowData("Sheet Zero returned invalid workflow runs")),
  );

const makeWorkflowExecutor = (zeroClient: ZeroExecutor): SheetWorkflowExecutor => {
  const executor: SheetWorkflowExecutor = {
    enqueue: <Contract extends AnyWorkflowContract>(
      contract: Contract,
      request: { readonly invocationId: InvocationId; readonly input: unknown },
    ) => {
      const procedure = workflowMutatorFor(contract, "enqueue");
      if (Predicate.isUndefined(procedure)) {
        return Effect.fail(unavailable("Enqueue", `Workflow ${contract.identity} is not mounted`));
      }

      return Effect.try({
        try: () =>
          procedure(
            Schema.decodeUnknownSync(ReadonlyJSONValue)(
              Schema.encodeSync(WorkflowEnqueueRequest(contract))(request),
            ),
          ),
        catch: () => unavailable("Enqueue", `Workflow ${contract.identity} could not be encoded`),
      }).pipe(
        Effect.flatMap((mutation) => zeroClient.mutate(mutation)),
        Effect.flatMap(({ server }) => server()),
        Effect.mapError(() => unavailable("Enqueue", "Sheet Zero rejected the workflow enqueue")),
      );
    },
    get: <Contract extends AnyWorkflowContract>(contract: Contract, invocationId: InvocationId) => {
      const procedure = workflowQueryFor(contract, "get");
      if (Predicate.isUndefined(procedure)) {
        return Stream.fail(unavailable("Observe", `Workflow ${contract.identity} is not mounted`));
      }

      return Stream.unwrap(
        Effect.try({
          try: () =>
            procedure(
              Schema.encodeSync(makeRunReferenceSchema(contract))({
                invocationId,
                contractIdentity: contract.identity,
                wireVersion: contract.wireVersion,
              }),
            ),
          catch: () =>
            invalidWorkflowData(`Workflow ${contract.identity} query could not be encoded`),
        }).pipe(
          Effect.map((query) =>
            zeroClient.stream(query).pipe(
              Stream.mapEffect(decodeWorkflowRow),
              Stream.mapError((error) =>
                Predicate.isTagged("WorkflowObservationInvalidData")(error)
                  ? error
                  : unavailable("Observe", "Sheet Zero workflow observation failed"),
              ),
            ),
          ),
        ),
      );
    },
    list: <Contract extends AnyWorkflowContract>(
      contract: Contract,
      filter: WorkflowRunListFilter,
    ) => {
      const procedure = workflowQueryFor(contract, "list");
      if (Predicate.isUndefined(procedure)) {
        return Stream.fail(unavailable("Observe", `Workflow ${contract.identity} is not mounted`));
      }

      return Stream.unwrap(
        Effect.try({
          try: () => procedure(Schema.encodeSync(WorkflowRunListFilter)(filter)),
          catch: () =>
            invalidWorkflowData(`Workflow ${contract.identity} query could not be encoded`),
        }).pipe(
          Effect.map((query) =>
            zeroClient.stream(query).pipe(
              Stream.mapEffect(decodeWorkflowRows),
              Stream.mapError((error) =>
                Predicate.isTagged("WorkflowObservationInvalidData")(error)
                  ? error
                  : unavailable("Observe", "Sheet Zero workflow observation failed"),
              ),
            ),
          ),
        ),
      );
    },
  };

  return executor;
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
  readonly accessToken: string;
}): SheetWebZeroClient => {
  const combinedMutators = {
    ...mutators,
    ...workflowMutators,
  };
  const zero = new Zero({
    cacheURL: options.endpoint.href.replace(/\/$/, ""),
    userID: options.principalId,
    auth: options.accessToken,
    schema,
    mutators: combinedMutators,
    context: {
      principalId: options.principalId,
      visibilityKey: `account:${options.principalId}`,
    },
  });
  const zeroClient = Effect.runSync(
    BaseZeroClient.ZeroClient<SheetZeroSchema, undefined, WorkflowZeroContext>().make(zero),
  );
  const sheet = Effect.runSync(makeSheetClient(zeroClient));
  const allWorkflows = makeSheetWorkflowZeroClients(makeWorkflowExecutor(zeroClient));
  let closed = false;
  let refreshing = false;
  let currentAccessToken = options.accessToken;

  const reconnect = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      await runSheetZeroAuthReconnect({
        isClosed: () => closed,
        reconnect: async () => {
          const accessToken = await Effect.runPromise(ensureSheetWebOAuthAccessToken());
          if (Option.isNone(accessToken)) {
            throw new Error("Sheet Zero authentication refresh returned no access token");
          }
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

const clients = new Map<string, SheetWebZeroClient>();

const clientKey = (principalId: string, endpoint: URL) => `${principalId}:${endpoint.href}`;

const clearSheetZeroClients = () => {
  for (const client of clients.values()) client.close();
  clients.clear();
};

const acquireSheetWebZeroClient = (options: {
  readonly principalId: string;
  readonly endpoint: URL;
  readonly accessToken: string;
}) => {
  const key = clientKey(options.principalId, options.endpoint);
  const existing = clients.get(key);
  if (Predicate.isNotUndefined(existing)) {
    existing.refreshAuth(options.accessToken);
    return existing;
  }

  for (const [existingKey, client] of clients) {
    if (existingKey !== key) {
      client.close();
      clients.delete(existingKey);
    }
  }

  const client = makeSheetWebZeroClient(options);
  clients.set(key, client);
  return client;
};

const browserSheetZeroClient = createIsomorphicFn()
  .server((_principalId: string, _endpoint: URL, _accessToken: string) =>
    Effect.fail(
      new SheetWebZeroBrowserOnlyError({
        message: "Sheet Zero is available after browser hydration",
      }),
    ),
  )
  .client((principalId: string, endpoint: URL, accessToken: string) =>
    Effect.try({
      try: () => acquireSheetWebZeroClient({ principalId, endpoint, accessToken }),
      catch: () => new SheetWebZeroUnauthorized({ message: "Sheet Zero could not be initialized" }),
    }),
  );

export const sheetZeroClientAtom = Atom.make(
  Effect.fnUntraced(function* (get) {
    const session = yield* get.result(sessionAtom);
    if (Option.isNone(session)) {
      clearSheetZeroClients();
      return yield* Effect.fail(
        new SheetWebZeroUnauthorized({ message: "Sheet Zero requires an authenticated principal" }),
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

    const user = session.value.user;
    const principalId =
      Predicate.hasProperty(user, "id") && Predicate.isString(user.id) ? user.id : undefined;
    if (Predicate.isUndefined(principalId)) {
      return yield* Effect.fail(
        new SheetWebZeroUnauthorized({ message: "The authenticated session has no principal ID" }),
      );
    }

    return yield* browserSheetZeroClient(principalId, endpoint, accessToken.value);
  }),
);

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
    const terminal = yield* workflow.get(reference).pipe(
      Stream.filter((run): run is Option.Some<WorkflowRun<Contract>> => Option.isSome(run)),
      Stream.map((run) => run.value),
      Stream.takeUntil((run) => run.result._tag !== "Pending"),
      Stream.runLast,
      Effect.timeoutOrElse({
        duration: Duration.seconds(30),
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
