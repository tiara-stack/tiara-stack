import { Context, Deferred, Effect, Exit, Layer, Option, Schema } from "effect";
import { createHash } from "node:crypto";
import {
  WorkflowEnqueueRequest,
  workflowContractRoutes,
} from "effect-zero-workflow/contract/transport";
import { SheetWorkflowContractCatalog } from "sheet-workflow-contracts";
import type { PreviewSessionControllerApi } from "./preview-sessions";

const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));
const InvocationId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);

/** The immutable shared workflow group selected when a producer preview is admitted. */
export const PreviewSharedWorkflowGroupSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/i)),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  groupId: Schema.Literal("workflow-execution"),
  endpoint: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  databaseEndpointIdentity: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  stateIdentity: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)),
  deployedManifestDigest: Sha256,
  schemaArtifactDigest: Sha256,
  apiArtifactDigest: Sha256,
  workflowContractCatalogDigest: Sha256,
});
export type PreviewSharedWorkflowGroup = typeof PreviewSharedWorkflowGroupSchema.Type;

export const PreviewSharedWorkflowRequestSchema = Schema.Struct({
  operation: Schema.Literals(["enqueue", "observe"]),
  workflowIdentity: Schema.String.check(Schema.isPattern(/^[a-z][A-Za-z0-9._-]{0,127}$/)),
  wireVersion: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)),
  oauthClientId: Schema.NonEmptyString,
  invocationId: InvocationId,
  continuationId: Schema.NullOr(Schema.NonEmptyString),
  endpoint: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  target: Schema.String.check(Schema.isPattern(/^workflow-execution:[A-Za-z0-9._:-]{1,512}$/)),
});
export type PreviewSharedWorkflowRequest = typeof PreviewSharedWorkflowRequestSchema.Type;

export class PreviewSharedWorkflowError extends Schema.TaggedErrorClass<PreviewSharedWorkflowError>()(
  "PreviewSharedWorkflowError",
  {
    reason: Schema.Literals([
      "invalid-group",
      "invalid-request",
      "route-not-ready",
      "admission-denied",
      "session-fenced",
      "transport-timeout",
      "transport-failed",
      "admission-settlement-failed",
    ]),
    invocationId: Schema.optionalKey(Schema.String),
    endpoint: Schema.optionalKey(Schema.String),
    outcome: Schema.Literals(["not-sent", "unknown", "observed"]),
  },
) {}

export const previewSharedWorkflowGroupTarget = (group: {
  readonly endpoint: string;
  readonly databaseEndpointIdentity: string;
  readonly stateIdentity: string;
  readonly deployedManifestDigest: string;
  readonly schemaArtifactDigest: string;
  readonly apiArtifactDigest: string;
  readonly workflowContractCatalogDigest: string;
}) => {
  const endpointIdentity = createHash("sha256").update(group.endpoint).digest("hex").slice(0, 16);
  return `workflow-execution:${group.stateIdentity}:${endpointIdentity}:${group.databaseEndpointIdentity.slice(7, 23)}:${group.deployedManifestDigest.slice(7, 23)}:${group.schemaArtifactDigest.slice(7, 23)}:${group.apiArtifactDigest.slice(7, 23)}:${group.workflowContractCatalogDigest.slice(7, 23)}`;
};

export const previewSharedWorkflowTarget = (
  group: Parameters<typeof previewSharedWorkflowGroupTarget>[0],
  workflowIdentity: string,
  wireVersion: string,
) => `${previewSharedWorkflowGroupTarget(group)}:${workflowIdentity}:${wireVersion}`;

export const previewSharedWorkflowContractTargets = (
  group: Parameters<typeof previewSharedWorkflowGroupTarget>[0],
) =>
  SheetWorkflowContractCatalog.map((contract) =>
    previewSharedWorkflowTarget(group, contract.identity, contract.wireVersion),
  );

const invalidWorkflowHttpRequest = (endpoint: string) =>
  new PreviewSharedWorkflowError({
    reason: "invalid-request",
    endpoint,
    outcome: "not-sent",
  });

/** Parses a single catalogued enqueue/get route before handing it to the session admission. */
export const runPreviewSharedWorkflowHttpRequest = <A, E, R>(input: {
  readonly controller: PreviewSessionControllerApi;
  readonly group: PreviewSharedWorkflowGroup;
  readonly oauthClientId: string;
  readonly endpoint: string;
  readonly method: string;
  readonly path: string;
  readonly body?: Uint8Array;
  readonly timeoutMs: number;
  readonly forward: Effect.Effect<A, E, R>;
}) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => {
        const url = new URL(input.path, input.endpoint);
        if (
          url.origin !== input.endpoint ||
          url.search.length > 0 ||
          url.hash.length > 0 ||
          url.pathname !== input.path
        )
          throw new Error("workflow route has an unapproved origin or query");
        return `${url.pathname}`;
      },
      catch: () => invalidWorkflowHttpRequest(input.endpoint),
    });
    const route = SheetWorkflowContractCatalog.find((candidate) => {
      const routes = workflowContractRoutes(candidate);
      return (
        (input.method === "POST" && routes.enqueue === parsed) ||
        (input.method === "GET" &&
          routes.get.includes(":invocationId") &&
          parsed.startsWith(routes.get.slice(0, routes.get.indexOf(":invocationId"))) &&
          parsed.endsWith(
            routes.get.slice(routes.get.indexOf(":invocationId") + ":invocationId".length),
          ))
      );
    });
    if (route === undefined) return yield* Effect.fail(invalidWorkflowHttpRequest(input.endpoint));
    const routes = workflowContractRoutes(route);
    const routePrefix = routes.get.slice(0, routes.get.indexOf(":invocationId"));
    const invocationId =
      input.method === "GET"
        ? yield* Schema.decodeUnknownEffect(InvocationId)(
            parsed.slice(routePrefix.length, parsed.length - "/events".length),
          ).pipe(Effect.mapError(() => invalidWorkflowHttpRequest(input.endpoint)))
        : yield* Effect.gen(function* () {
            if (input.body === undefined || input.body.byteLength > 1024 * 1024)
              return yield* Effect.fail(invalidWorkflowHttpRequest(input.endpoint));
            const request = yield* Effect.try({
              try: () => JSON.parse(new TextDecoder().decode(input.body)) as unknown,
              catch: () => invalidWorkflowHttpRequest(input.endpoint),
            });
            const decoded = yield* Schema.decodeUnknownEffect(WorkflowEnqueueRequest(route))(
              request,
            ).pipe(Effect.mapError(() => invalidWorkflowHttpRequest(input.endpoint)));
            return decoded.invocationId;
          });
    const target = previewSharedWorkflowTarget(input.group, route.identity, route.wireVersion);
    return yield* makePreviewSharedWorkflowAdmission().run({
      controller: input.controller,
      group: input.group,
      request: {
        operation: input.method === "POST" ? "enqueue" : "observe",
        workflowIdentity: route.identity,
        wireVersion: route.wireVersion,
        oauthClientId: input.oauthClientId,
        invocationId,
        continuationId: null,
        endpoint: input.endpoint,
        target,
      },
      timeoutMs: input.timeoutMs,
      operation: input.forward,
    });
  });

export interface PreviewSharedWorkflowAdmissionInput<A, E, R> {
  readonly controller: PreviewSessionControllerApi;
  readonly group: PreviewSharedWorkflowGroup;
  readonly request: PreviewSharedWorkflowRequest;
  readonly timeoutMs: number;
  readonly operation: Effect.Effect<A, E, R>;
}

export interface PreviewSharedWorkflowAdmissionApi {
  /** Executes exactly one request under a durable session admission. It never retries. */
  readonly run: <A, E, R>(
    input: PreviewSharedWorkflowAdmissionInput<A, E, R>,
  ) => Effect.Effect<
    {
      readonly value: A;
      readonly continuationId: string;
      readonly group: PreviewSharedWorkflowGroup;
    },
    E | PreviewSharedWorkflowError,
    R
  >;
}

/** Request shape the published API route must pass through its session admission callback. */
export interface PreviewSharedWorkflowHttpRequestInput<A, E, R> {
  readonly method: string;
  readonly path: string;
  readonly body?: Uint8Array;
  readonly forward: Effect.Effect<A, E, R>;
}

/** The mandatory route callback for catalogued enqueue and invocation-observation requests. */
export type PreviewSharedWorkflowHttpRequestRunner = <A, E, R>(
  input: PreviewSharedWorkflowHttpRequestInput<A, E, R>,
) => Effect.Effect<
  {
    readonly value: A;
    readonly continuationId: string;
    readonly group: PreviewSharedWorkflowGroup;
  },
  E | PreviewSharedWorkflowError,
  R
>;

export class PreviewSharedWorkflowAdmission extends Context.Service<
  PreviewSharedWorkflowAdmission,
  PreviewSharedWorkflowAdmissionApi
>()("developer-launcher/PreviewSharedWorkflowAdmission") {}

const decodeInput = <A>(
  schema: Schema.Decoder<A>,
  input: unknown,
  reason: "invalid-group" | "invalid-request",
) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => new PreviewSharedWorkflowError({ reason, outcome: "not-sent" })),
  );

const workflowAdmissionError = (
  reason: PreviewSharedWorkflowError["reason"],
  request: PreviewSharedWorkflowRequest,
  outcome: PreviewSharedWorkflowError["outcome"],
) =>
  new PreviewSharedWorkflowError({
    reason,
    invocationId: request.invocationId,
    endpoint: request.endpoint,
    outcome,
  });

const validateWorkflowAdmission = (
  groupInput: PreviewSharedWorkflowGroup,
  requestInput: PreviewSharedWorkflowRequest,
  timeoutMs: number,
) =>
  Effect.gen(function* () {
    const group = yield* decodeInput(PreviewSharedWorkflowGroupSchema, groupInput, "invalid-group");
    const request = yield* decodeInput(
      PreviewSharedWorkflowRequestSchema,
      requestInput,
      "invalid-request",
    );
    const knownContract = SheetWorkflowContractCatalog.some(
      (contract) =>
        contract.identity === request.workflowIdentity &&
        contract.wireVersion === request.wireVersion,
    );
    const targetMatches =
      request.target ===
      previewSharedWorkflowTarget(group, request.workflowIdentity, request.wireVersion);
    const enqueueIsNewInvocation =
      request.operation !== "enqueue" || request.continuationId === null;
    if (
      !knownContract ||
      !targetMatches ||
      !enqueueIsNewInvocation ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0
    )
      return yield* Effect.fail(workflowAdmissionError("invalid-request", request, "not-sent"));
    return { group, request };
  });

const findExistingWorkflowContinuation = (
  controller: PreviewSessionControllerApi,
  group: PreviewSharedWorkflowGroup,
  request: PreviewSharedWorkflowRequest,
) => {
  if (request.operation !== "observe" || request.continuationId !== null)
    return Effect.succeed(request.continuationId);
  return controller
    .findWorkloadAdmission({
      sessionId: group.sessionId,
      generation: group.generation,
      role: "sheet-workflows-api",
      oauthClientId: request.oauthClientId,
      groupId: group.groupId,
      invocationId: request.invocationId,
      endpoint: request.endpoint,
      target: request.target,
    })
    .pipe(
      Effect.map((found) => found.admissionId),
      Effect.mapError(() => workflowAdmissionError("admission-denied", request, "not-sent")),
    );
};

const admitWorkflowRequest = (
  controller: PreviewSessionControllerApi,
  group: PreviewSharedWorkflowGroup,
  request: PreviewSharedWorkflowRequest,
  continuationId: string | null,
) =>
  controller
    .admitWorkload({
      sessionId: group.sessionId,
      generation: group.generation,
      role: "sheet-workflows-api",
      oauthClientId: request.oauthClientId,
      groupId: group.groupId,
      invocationId: request.invocationId,
      continuationId,
      endpoint: request.endpoint,
      target: request.target,
    })
    .pipe(Effect.mapError(() => workflowAdmissionError("admission-denied", request, "not-sent")));

const runWorkflowRequestWithFence = <A, E, R>(
  controller: PreviewSessionControllerApi,
  group: PreviewSharedWorkflowGroup,
  request: PreviewSharedWorkflowRequest,
  timeoutMs: number,
  operation: Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fence = yield* Deferred.make<void>();
      yield* controller.watchFences(group.sessionId, Deferred.succeed(fence, undefined));
      const timedOperation = Effect.timeoutOption(operation, timeoutMs).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(workflowAdmissionError("transport-timeout", request, "unknown")),
            onSome: Effect.succeed,
          }),
        ),
      );
      const fenced = Deferred.await(fence).pipe(
        Effect.andThen(Effect.fail(workflowAdmissionError("session-fenced", request, "unknown"))),
      );
      return yield* Effect.raceFirst(timedOperation, fenced);
    }),
  );

const settleWorkflowRequest = <A, E>(
  controller: PreviewSessionControllerApi,
  admission: import("./preview-sessions").PreviewWorkloadAdmission,
  group: PreviewSharedWorkflowGroup,
  request: PreviewSharedWorkflowRequest,
  operationExit: Exit.Exit<A, E>,
) =>
  Effect.gen(function* () {
    const settled = yield* Effect.exit(controller.settleWorkload(admission));
    if (Exit.isFailure(settled))
      return yield* Effect.fail(
        workflowAdmissionError("admission-settlement-failed", request, "unknown"),
      );
    if (Exit.isFailure(operationExit)) return yield* Effect.failCause(operationExit.cause);
    return { value: operationExit.value, continuationId: admission.admissionId, group };
  });

export const makePreviewSharedWorkflowAdmission = (): PreviewSharedWorkflowAdmissionApi => ({
  run: <A, E, R>(input: PreviewSharedWorkflowAdmissionInput<A, E, R>) => {
    const { controller, group: groupInput, request: requestInput, timeoutMs, operation } = input;
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const validated = yield* validateWorkflowAdmission(groupInput, requestInput, timeoutMs);
        const { group, request } = validated;
        const continuationId = yield* findExistingWorkflowContinuation(controller, group, request);
        const admission = yield* admitWorkflowRequest(controller, group, request, continuationId);
        const operationExit = yield* Effect.exit(
          restore(runWorkflowRequestWithFence(controller, group, request, timeoutMs, operation)),
        );
        return yield* settleWorkflowRequest(controller, admission, group, request, operationExit);
      }),
    );
  },
});

export const PreviewSharedWorkflowAdmissionLive = Layer.succeed(
  PreviewSharedWorkflowAdmission,
  makePreviewSharedWorkflowAdmission(),
);
