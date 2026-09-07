import { Cause, Duration, Effect, Exit, Fiber, Option, Predicate, Schema, Stream } from "effect";
import { Context, Layer } from "effect";
import { describe, expect, it, layer } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  InvocationId,
  defineWorkflowContract,
  type RunReference,
  type WorkflowClient,
  type WorkflowResult,
  type WorkflowRun,
} from "effect-zero-workflow/contract";
import type {
  WorkflowEnqueueError,
  WorkflowObservationError,
} from "effect-zero-workflow/contract/transport";
import { vi } from "vitest";
import {
  makeSheetWebOAuthHttpClient,
  runSheetWorkflow,
  runSheetZeroAuthReconnect,
  shouldReconnectSheetZeroAuth,
} from "./sheetZero";

const successSchema = Schema.Struct({ value: Schema.String });
type ConnectionState = Parameters<typeof shouldReconnectSheetZeroAuth>[0];

const testWorkflowContract = defineWorkflowContract({
  identity: "test.workflow",
  wireVersion: "1",
  input: Schema.Struct({}),
  success: Schema.Struct({ value: Schema.Unknown }),
  declaredFailure: Schema.Struct({ reason: Schema.String }),
  authorizationPolicy: { policy: "test" },
});

type TestWorkflow = WorkflowClient<
  typeof testWorkflowContract,
  WorkflowEnqueueError,
  WorkflowObservationError
>;
type TestRun = WorkflowRun<typeof testWorkflowContract>;

const workflowReference: RunReference<typeof testWorkflowContract> = {
  invocationId: Schema.decodeUnknownSync(InvocationId)("123e4567-e89b-42d3-a456-426614174000"),
  contractIdentity: testWorkflowContract.identity,
  wireVersion: testWorkflowContract.wireVersion,
};

const makeRun = (result: WorkflowResult<typeof testWorkflowContract>): TestRun => ({
  reference: workflowReference,
  result,
  submittedAt: new Date(0),
  updatedAt: new Date(0),
});

const pendingRun = makeRun({ _tag: "Pending", phase: "Running" });

const streamOf = (...runs: ReadonlyArray<Option.Option<TestRun>>) => Stream.fromIterable(runs);

const makeWorkflow = (
  ...runs: ReadonlyArray<Option.Option<TestRun>>
): Pick<TestWorkflow, "enqueue" | "get"> => ({
  enqueue: () => Effect.succeed(workflowReference),
  get: () => streamOf(...runs),
});

const makeWorkflowSequence = (
  ...observations: ReadonlyArray<ReadonlyArray<Option.Option<TestRun>>>
): Pick<TestWorkflow, "enqueue" | "get"> => {
  let nextObservation = 0;
  return {
    enqueue: () => Effect.succeed(workflowReference),
    get: () => {
      const observation = observations[Math.min(nextObservation++, observations.length - 1)] ?? [];
      return streamOf(...observation);
    },
  };
};

const neverWorkflow: Pick<TestWorkflow, "enqueue" | "get"> = {
  enqueue: () => Effect.succeed(workflowReference),
  get: () => Stream.never,
};

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const makeOAuthRetryTestClient = (bodyKind: "stream" | "empty") => {
  const statuses = [401, 202];
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  let unauthorizedBodyWasDrained = false;
  let unauthorizedBodyPullCount = 0;
  const bodyDrainStateAtRequest: Array<boolean> = [];
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      bodyDrainStateAtRequest.push(unauthorizedBodyWasDrained);
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          statuses[0] === 401 && bodyKind === "stream"
            ? new ReadableStream({
                pull(controller) {
                  unauthorizedBodyPullCount += 1;
                  controller.enqueue(new Uint8Array([1]));
                  if (unauthorizedBodyPullCount > 1) {
                    unauthorizedBodyWasDrained = true;
                    controller.close();
                  }
                },
              })
            : null,
          { status: statuses.shift() ?? 500 },
        ),
      );
    }),
  );
  let accessToken = "expired-token";
  const refreshAccessToken = vi.fn(async () => {
    accessToken = "fresh-token";
    return accessToken;
  });

  return {
    bodyDrainStateAtRequest,
    client: makeSheetWebOAuthHttpClient({
      httpClient,
      getAccessToken: () => accessToken,
      refreshAccessToken,
    }),
    refreshAccessToken,
    requests,
  };
};

const expectOAuthRetrySucceeded = (
  refreshAccessToken: unknown,
  requests: ReadonlyArray<HttpClientRequest.HttpClientRequest>,
) => {
  expect(refreshAccessToken).toHaveBeenCalledOnce();
  expect(requests.map((request) => request.headers.authorization)).toEqual([
    "Bearer expired-token",
    "Bearer fresh-token",
  ]);
};

type OAuthRetryTestClient = ReturnType<typeof makeOAuthRetryTestClient>;

class OAuthRetryFixture extends Context.Service<OAuthRetryFixture, OAuthRetryTestClient>()(
  "SheetWebOAuthRetryFixture",
) {}

const streamOAuthRetryLayer = layer(
  Layer.sync(OAuthRetryFixture, () => makeOAuthRetryTestClient("stream")),
);
const emptyOAuthRetryLayer = layer(
  Layer.sync(OAuthRetryFixture, () => makeOAuthRetryTestClient("empty")),
);

describe("sheet Zero workflow observation", () => {
  streamOAuthRetryLayer("OAuth retry with a response body", (layerIt) => {
    layerIt.effect("refreshes an expired OAuth token and retries the workflow request once", () =>
      Effect.gen(function* () {
        const { bodyDrainStateAtRequest, client, refreshAccessToken, requests } =
          yield* OAuthRetryFixture;

        const response = yield* client.execute(HttpClientRequest.get("https://example.test"));

        expect(response.status).toBe(202);
        expectOAuthRetrySucceeded(refreshAccessToken, requests);
        expect(bodyDrainStateAtRequest).toEqual([false, true]);
      }),
    );
  });

  it.effect("preserves an unauthorized response body when OAuth refresh fails", () =>
    Effect.gen(function* () {
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("unauthorized", { status: 401 })),
        ),
      );
      const refreshAccessToken = vi.fn(async (): Promise<string> => {
        throw new Error("refresh failed");
      });
      const client = makeSheetWebOAuthHttpClient({
        httpClient,
        getAccessToken: () => "expired-token",
        refreshAccessToken,
      });

      const response = yield* client.execute(HttpClientRequest.get("https://example.test"));

      expect(response.status).toBe(401);
      expect(yield* response.text).toBe("unauthorized");
      expect(refreshAccessToken).toHaveBeenCalledOnce();
    }),
  );

  emptyOAuthRetryLayer("OAuth retry with an empty response body", (layerIt) => {
    layerIt.effect("retries after refreshing from a bodyless unauthorized response", () =>
      Effect.gen(function* () {
        const { client, refreshAccessToken, requests } = yield* OAuthRetryFixture;

        const response = yield* client.execute(HttpClientRequest.get("https://example.test"));

        expect(response.status).toBe(202);
        expectOAuthRetrySucceeded(refreshAccessToken, requests);
      }),
    );
  });

  it.effect("enqueues once and returns the first terminal success", () =>
    Effect.gen(function* () {
      const workflow = makeWorkflow(
        Option.none(),
        Option.some(pendingRun),
        Option.some(
          makeRun({ _tag: "Success", value: { value: "done" }, completedAt: new Date(0) }),
        ),
      );
      const enqueue = vi.fn(workflow.enqueue);
      const get = vi.fn(workflow.get);

      const result = yield* runSheetWorkflow({ enqueue, get }, {}, successSchema);

      expect(result).toEqual({ value: "done" });
      expect(enqueue).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledOnce();
    }),
  );

  it.effect("fails when a terminal success payload does not satisfy its schema", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runSheetWorkflow(
          makeWorkflow(
            Option.some(pendingRun),
            Option.some(
              makeRun({ _tag: "Success", value: { value: 42 }, completedAt: new Date(0) }),
            ),
          ),
          {},
          successSchema,
        ),
      );

      expect(Schema.isSchemaError(failureOf(exit))).toBe(true);
    }),
  );

  it.effect("surfaces a terminal workflow failure without synthesizing success", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runSheetWorkflow(
          makeWorkflow(
            Option.some(
              makeRun({
                _tag: "Failure",
                failure: { _tag: "Declared", error: { reason: "rejected" } },
                completedAt: new Date(0),
              }),
            ),
          ),
          {},
          successSchema,
        ),
      );

      const failure = failureOf(exit);
      expect(Predicate.isTagged("SheetWebWorkflowFailure")(failure)).toBe(true);
    }),
  );

  it.effect("polls a pending snapshot observation until it reaches a terminal state", () =>
    Effect.gen(function* () {
      const fiber = yield* runSheetWorkflow(
        makeWorkflowSequence(
          [Option.none(), Option.some(pendingRun)],
          [
            Option.some(
              makeRun({ _tag: "Success", value: { value: "done" }, completedAt: new Date(0) }),
            ),
          ],
        ),
        {},
        successSchema,
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.millis(250));
      const result = yield* Fiber.join(fiber);

      expect(result).toEqual({ value: "done" });
    }),
  );

  it.effect("retries an empty observation until a workflow run is available", () =>
    Effect.gen(function* () {
      const fiber = yield* runSheetWorkflow(
        makeWorkflowSequence(
          [Option.none()],
          [
            Option.some(
              makeRun({ _tag: "Success", value: { value: "done" }, completedAt: new Date(0) }),
            ),
          ],
        ),
        {},
        successSchema,
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.millis(250));
      expect(yield* Fiber.join(fiber)).toEqual({ value: "done" });
    }),
  );

  it.effect("fails when workflow observation times out", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.exit(runSheetWorkflow(neverWorkflow, {}, successSchema)).pipe(
        Effect.forkChild,
      );

      yield* TestClock.adjust(Duration.seconds(60));
      const exit = yield* Fiber.join(fiber);
      const failure = failureOf(exit);
      expect(Predicate.isTagged("WorkflowTransportUnavailable")(failure)).toBe(true);
      expect((failure as { message: string }).message).toContain("timed out");
    }),
  );

  it.effect("classifies reconnect-worthy connection states", () =>
    Effect.gen(function* () {
      const apiServerError = {
        name: "error" as const,
        reason: "Fetch from API server returned non-OK status 500",
      } satisfies ConnectionState;
      const unrelatedError = {
        name: "error" as const,
        reason: "Zero cache crashed",
      } satisfies ConnectionState;
      const connected = { name: "connected" as const } satisfies ConnectionState;
      const reconnect = vi.fn(async () => {
        throw new Error("authentication rejected");
      });
      const delays: Array<number> = [];
      const log = vi.fn();
      const needsAuth = {
        name: "needs-auth" as const,
        reason: { type: "query" as const, status: 401 as const },
      } satisfies ConnectionState;

      expect(shouldReconnectSheetZeroAuth(needsAuth)).toBe(true);
      expect(shouldReconnectSheetZeroAuth(apiServerError)).toBe(true);
      expect(shouldReconnectSheetZeroAuth(unrelatedError)).toBe(false);
      expect(shouldReconnectSheetZeroAuth(connected)).toBe(false);

      const succeeded = yield* Effect.promise(() =>
        runSheetZeroAuthReconnect({
          reconnect,
          isClosed: () => false,
          sleep: async (delayMs) => {
            delays.push(delayMs);
          },
          log,
        }),
      );

      expect(succeeded).toBe(false);
      expect(reconnect).toHaveBeenCalledTimes(3);
      expect(reconnect).toHaveBeenNthCalledWith(1, true);
      expect(reconnect).toHaveBeenNthCalledWith(2, false);
      expect(reconnect).toHaveBeenNthCalledWith(3, false);
      expect(delays).toEqual([250, 500]);
      expect(log).toHaveBeenCalledTimes(3);
    }),
  );

  it.effect("does not reconnect after the client is closed", () =>
    Effect.gen(function* () {
      const reconnect = vi.fn(async () => undefined);
      const sleep = vi.fn(async (_delayMs: number) => undefined);

      const succeeded = yield* Effect.promise(() =>
        runSheetZeroAuthReconnect({
          reconnect,
          isClosed: () => true,
          sleep,
        }),
      );

      expect(succeeded).toBe(false);
      expect(reconnect).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    }),
  );
});
