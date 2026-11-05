import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { it } from "@effect/vitest";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import { makePreviewSessionController } from "./preview-sessions";
import {
  makePreviewSharedWorkflowAdmission,
  previewSharedWorkflowTarget,
  runPreviewSharedWorkflowHttpRequest,
  type PreviewSharedWorkflowGroup,
} from "./preview-shared-workflow";
import { makePreviewWorkflowApiWorkflowRequestRunner } from "./preview-workflow-api-host";

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const testGroup = (sessionId: string, generation: number): PreviewSharedWorkflowGroup => ({
  sessionId,
  generation,
  groupId: "workflow-execution",
  endpoint: "https://workflow-api.dev.tiara-stack.moe",
  databaseEndpointIdentity: digest("e"),
  stateIdentity: "tiara-stack-dev-workflows",
  deployedManifestDigest: digest("a"),
  schemaArtifactDigest: digest("d"),
  apiArtifactDigest: digest("b"),
  workflowContractCatalogDigest: digest("c"),
});
const invocationId = "123e4567-e89b-42d3-a456-426614174000";
const oauthClientId = "preview-workflows-client";
const sessionApiEndpoint = "https://session-api.dev.tiara-stack.moe";
const workflowIdentity = "notifications.loadSupportedClients";
const wireVersion = "1";

it("binds the workflow group target to its exact API and database endpoint identities", () => {
  const group = testGroup("123e4567-e89b-42d3-a456-426614174001", 1);
  const target = previewSharedWorkflowTarget(group, workflowIdentity, wireVersion);

  expect(
    previewSharedWorkflowTarget(
      { ...group, endpoint: "https://other-workflow-api.dev.tiara-stack.moe" },
      workflowIdentity,
      wireVersion,
    ),
  ).not.toBe(target);
  expect(
    previewSharedWorkflowTarget(
      { ...group, databaseEndpointIdentity: digest("f") },
      workflowIdentity,
      wireVersion,
    ),
  ).not.toBe(target);
});

const configure = <A, E>(
  run: (now: { value: number }) => Effect.Effect<A, E, SqlClient.SqlClient>,
) => {
  const now = { value: 1_000_000 };
  return run(now).pipe(
    Effect.provide(
      Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
    ),
  );
};

const admitProducer = (now: { value: number }) =>
  Effect.gen(function* () {
    const controller = yield* makePreviewSessionController(() => now.value);
    const targetGroup = testGroup("123e4567-e89b-42d3-a456-426614174001", 1);
    const target = previewSharedWorkflowTarget(targetGroup, workflowIdentity, wireVersion);
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: {
        "sheet-workflows-api": digest("b"),
        "shared-execution-mode": "producer-only",
        "schema-artifact": digest("d"),
      },
      requestedRevision: "revision-a",
      groups: ["workflow-execution"],
      endpoints: [targetGroup.endpoint],
      targets: [target],
    });
    const group = testGroup(created.session.id, created.session.generation);
    const reservation = yield* controller.authorizeCredentialIssue(
      group.sessionId,
      group.generation,
      "sheet-workflows-api",
    );
    yield* controller.registerCredentialIdentity({
      id: group.sessionId,
      generation: group.generation,
      role: "sheet-workflows-api",
      reservationId: reservation.reservationId,
      credentialName: "workload-identity",
      serviceAccount: "tiara-stack-dev/preview-api",
      oauthClientId,
      credentialFile: "/private/session/api/token",
    });
    yield* controller.authorizeWorkEndpoint(
      group.sessionId,
      group.generation,
      created.supervisorIdentity,
      sessionApiEndpoint,
    );
    yield* controller.activate(
      group.sessionId,
      group.generation,
      created.supervisorIdentity,
      "revision-a",
    );
    return { controller, group, target, ownerIdentity: created.ownerIdentity };
  });

it.effect(
  "uses one immutable execution group and original invocation for enqueue and observation",
  () =>
    configure(() =>
      Effect.gen(function* () {
        const { controller, group, target } = yield* admitProducer({ value: 1_000_000 });
        const boundary = makePreviewSharedWorkflowAdmission();
        const operations: Array<{ endpoint: string; invocationId: string; phase: string }> = [];
        const enqueue = yield* boundary.run({
          controller,
          group,
          request: {
            operation: "enqueue",
            workflowIdentity,
            wireVersion,
            oauthClientId,
            invocationId,
            continuationId: null,
            endpoint: sessionApiEndpoint,
            target,
          },
          timeoutMs: 100,
          operation: Effect.sync(() => {
            operations.push({ endpoint: group.endpoint, invocationId, phase: "accepted" });
            return "accepted" as const;
          }),
        });
        const observation = yield* boundary.run({
          controller,
          group: enqueue.group,
          request: {
            operation: "observe",
            workflowIdentity,
            wireVersion,
            oauthClientId,
            invocationId,
            continuationId: null,
            endpoint: sessionApiEndpoint,
            target,
          },
          timeoutMs: 100,
          operation: Effect.sync(() => {
            operations.push({ endpoint: enqueue.group.endpoint, invocationId, phase: "terminal" });
            return "succeeded" as const;
          }),
        });

        expect(enqueue.value).toBe("accepted");
        expect(observation.value).toBe("succeeded");
        expect(operations).toEqual([
          { endpoint: group.endpoint, invocationId, phase: "accepted" },
          { endpoint: group.endpoint, invocationId, phase: "terminal" },
        ]);
        expect((yield* controller.status(group.sessionId)).unsettled).toBe(0);
      }),
    ),
);

it.effect(
  "binds catalogued HTTP enqueue and get routes to the same invocation and execution target",
  () =>
    configure(() =>
      Effect.gen(function* () {
        const { controller, group } = yield* admitProducer({ value: 1_000_000 });
        const calls: Array<{ method: string; path: string; endpoint: string }> = [];
        const enqueuePath = "/workflows/notifications.loadSupportedClients/v/1/enqueue";
        const getPath = `/workflows/notifications.loadSupportedClients/v/1/runs/${invocationId}/events`;
        const enqueue = yield* runPreviewSharedWorkflowHttpRequest({
          controller,
          group,
          oauthClientId,
          endpoint: sessionApiEndpoint,
          method: "POST",
          path: enqueuePath,
          body: new TextEncoder().encode(
            JSON.stringify({ invocationId, input: { platform: "discord" } }),
          ),
          timeoutMs: 100,
          forward: Effect.sync(() => {
            calls.push({ method: "POST", path: enqueuePath, endpoint: sessionApiEndpoint });
            return { status: 202, body: "accepted" };
          }),
        });
        const observation = yield* runPreviewSharedWorkflowHttpRequest({
          controller,
          group: enqueue.group,
          oauthClientId,
          endpoint: sessionApiEndpoint,
          method: "GET",
          path: getPath,
          timeoutMs: 100,
          forward: Effect.sync(() => {
            calls.push({ method: "GET", path: getPath, endpoint: sessionApiEndpoint });
            return { status: 200, body: "terminal" };
          }),
        });

        expect(enqueue.value).toEqual({ status: 202, body: "accepted" });
        expect(observation.value).toEqual({ status: 200, body: "terminal" });
        expect(calls).toEqual([
          { method: "POST", path: enqueuePath, endpoint: sessionApiEndpoint },
          { method: "GET", path: getPath, endpoint: sessionApiEndpoint },
        ]);
        expect((yield* controller.status(group.sessionId)).unsettled).toBe(0);
      }),
    ),
);

it.effect("rejects URL-normalized route paths before workflow admission or forwarding", () =>
  configure(() =>
    Effect.gen(function* () {
      const { controller, group } = yield* admitProducer({ value: 1_000_000 });
      const normalizedPath = "/workflows/notifications.loadSupportedClients/v/1/./enqueue";
      let forwarded = false;
      const result = yield* Effect.exit(
        runPreviewSharedWorkflowHttpRequest({
          controller,
          group,
          oauthClientId,
          endpoint: sessionApiEndpoint,
          method: "POST",
          path: normalizedPath,
          body: new TextEncoder().encode(
            JSON.stringify({ invocationId, input: { platform: "discord" } }),
          ),
          timeoutMs: 100,
          forward: Effect.sync(() => {
            forwarded = true;
            return { status: 202 };
          }),
        }),
      );

      expect(Exit.isFailure(result)).toBe(true);
      expect(forwarded).toBe(false);
      expect((yield* controller.status(group.sessionId)).unsettled).toBe(0);
    }),
  ),
);

it.effect(
  "the published API request callback fences and tracks the same enqueue and observation",
  () =>
    configure(() =>
      Effect.gen(function* () {
        const { controller, group } = yield* admitProducer({ value: 1_000_000 });
        const endpoint = { value: undefined as string | undefined };
        const admit = makePreviewWorkflowApiWorkflowRequestRunner({
          controller,
          group,
          oauthClientId,
          endpoint: () => endpoint.value,
        });
        const enqueuePath = "/workflows/notifications.loadSupportedClients/v/1/enqueue";
        const getPath = `/workflows/notifications.loadSupportedClients/v/1/runs/${invocationId}/events`;
        const body = new TextEncoder().encode(
          JSON.stringify({ invocationId, input: { platform: "discord" } }),
        );
        const accepted = new Set<string>();
        let dispatchedBeforePublication = false;

        const beforePublication = yield* Effect.exit(
          admit({
            method: "POST",
            path: enqueuePath,
            body,
            forward: Effect.sync(() => {
              dispatchedBeforePublication = true;
            }),
          }),
        );
        expect(Exit.isFailure(beforePublication)).toBe(true);
        expect(dispatchedBeforePublication).toBe(false);

        endpoint.value = sessionApiEndpoint;
        const enqueue = yield* admit({
          method: "POST",
          path: enqueuePath,
          body,
          forward: Effect.sync(() => {
            accepted.add(invocationId);
            return { status: 202, invocationId };
          }),
        });
        const observation = yield* admit({
          method: "GET",
          path: getPath,
          forward: Effect.sync(() => ({
            status: accepted.has(invocationId) ? 200 : 404,
            invocationId,
          })),
        });

        expect(enqueue.value).toEqual({ status: 202, invocationId });
        expect(observation.value).toEqual({ status: 200, invocationId });
        expect(enqueue.group).toEqual(group);
        expect(observation.group).toEqual(group);
        expect(enqueue.continuationId).not.toBe(observation.continuationId);
        expect((yield* controller.status(group.sessionId)).unsettled).toBe(0);
      }),
    ),
);

it.live("returns an ambiguous timeout with the same invocation instead of retrying", () =>
  configure(() =>
    Effect.gen(function* () {
      const { controller, group, target } = yield* admitProducer({ value: 1_000_000 });
      const deferred = yield* Deferred.make<void>();
      const result = yield* Effect.exit(
        makePreviewSharedWorkflowAdmission().run({
          controller,
          group,
          request: {
            operation: "enqueue",
            workflowIdentity,
            wireVersion,
            oauthClientId,
            invocationId,
            continuationId: null,
            endpoint: sessionApiEndpoint,
            target,
          },
          timeoutMs: 20,
          operation: Deferred.await(deferred),
        }),
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const failure = result.cause.reasons.find(Cause.isFailReason);
        expect(failure?.error).toMatchObject({
          reason: "transport-timeout",
          invocationId,
          outcome: "unknown",
        });
      }
      expect((yield* controller.status(group.sessionId)).unsettled).toBe(0);
    }),
  ),
);

it.effect("fences a late API request without cancelling accepted shared work", () =>
  configure(() =>
    Effect.gen(function* () {
      const { controller, group, target, ownerIdentity } = yield* admitProducer({
        value: 1_000_000,
      });
      const accepted = yield* Deferred.make<void>();
      const finishResponse = yield* Deferred.make<void>();
      const request = makePreviewSharedWorkflowAdmission().run({
        controller,
        group,
        request: {
          operation: "enqueue",
          workflowIdentity,
          wireVersion,
          oauthClientId,
          invocationId,
          continuationId: null,
          endpoint: sessionApiEndpoint,
          target,
        },
        timeoutMs: 5_000,
        operation: Deferred.succeed(accepted, undefined).pipe(
          Effect.andThen(Deferred.await(finishResponse)),
        ),
      });
      const fiber = yield* Effect.forkChild(request);
      yield* Deferred.await(accepted);
      yield* controller.stop(group.sessionId, ownerIdentity);
      const result = yield* Effect.exit(Fiber.join(fiber));

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const failure = result.cause.reasons.find(Cause.isFailReason);
        expect(failure?.error).toMatchObject({
          reason: "session-fenced",
          invocationId,
          outcome: "unknown",
        });
      }
      expect((yield* controller.status(group.sessionId)).unsettled).toBe(0);
      yield* Deferred.succeed(finishResponse, undefined);
    }),
  ),
);

it.effect("rejects expired sessions before dispatching a browser request", () =>
  configure(({ value }) =>
    Effect.gen(function* () {
      const now = { value };
      const { controller, group, target } = yield* admitProducer(now);
      now.value += 121_000;
      let dispatched = false;
      const result = yield* Effect.exit(
        makePreviewSharedWorkflowAdmission().run({
          controller,
          group,
          request: {
            operation: "enqueue",
            workflowIdentity,
            wireVersion,
            oauthClientId,
            invocationId,
            continuationId: null,
            endpoint: sessionApiEndpoint,
            target,
          },
          timeoutMs: 100,
          operation: Effect.sync(() => {
            dispatched = true;
          }),
        }),
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const failure = result.cause.reasons.find(Cause.isFailReason);
        expect(failure?.error).toMatchObject({
          reason: "admission-denied",
          invocationId,
          outcome: "not-sent",
        });
      }
      expect(dispatched).toBe(false);
    }),
  ),
);
