import { describe, expect, it } from "@effect/vitest";
import { Cause, DateTime, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { WorkflowInvocationUnauthorized } from "effect-zero-workflow/contract/transport";
import {
  BotDependencyUnavailable,
  BotRequestRejected,
  BotResponseExpired,
  DeliveryKey,
  ResponseReference,
  type SheetBotHttpClient,
} from "sheet-bot-api";
import { InteractiveDeclaredFailure, ServicesDeliverStatus } from "sheet-workflow-contracts";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { normalizePayloadText } from "@/services/testHelpers";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import {
  workflowTestContext as context,
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import {
  executeCollectServiceReadinessAction,
  executeDeliverServiceStatusAction,
  makeServicesDeliverStatusDefinition,
  makeServicesDeliverStatusMessage,
  makeServicesDeliverStatusWorkflowBody,
} from "./definition";
import { makeServiceStatusDeliveryKey } from "./keys";
import {
  serviceReadinessAttemptTimeout,
  serviceReadinessConcurrency,
  serviceReadinessTargets,
  serviceStatusWorkflowOperationsLayer,
} from "./operations";
import { ServiceReadinessSnapshot, serviceStatusTargetNames } from "./schema";
import { ServiceSheetWorkflowRegistrations } from "./registry";
import { ServiceStatusWorkflowOperations } from "./service";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
const input = Schema.decodeUnknownSync(ServicesDeliverStatus.input)({ responseReference });
const deliveryKey = makeServiceStatusDeliveryKey(invocationId);
const receipt = {
  deliveryKey,
  operation: "respond" as const,
  target: { _tag: "Response" as const, responseReference },
};
const checkedAt = DateTime.makeUnsafe("2026-08-14T06:00:00.000Z");
const snapshot = Schema.decodeUnknownSync(ServiceReadinessSnapshot)({
  overallStatus: "degraded",
  checkedAt: checkedAt.epochMilliseconds,
  services: serviceReadinessTargets.map((target, index) => ({
    ...target,
    status: index === 1 ? "down" : "ok",
    httpStatus: index === 1 ? 503 : 200,
    latencyMs: index + 1,
    checkedAt: checkedAt.epochMilliseconds,
    error: index === 1 ? "HTTP 503" : null,
  })),
});

const response = (request: Parameters<HttpClient.HttpClient["execute"]>[0], status: number) =>
  HttpClientResponse.fromWeb(request, new Response(null, { status }));

const makeBot = (
  respond: (request: {
    readonly payload: {
      readonly deliveryKey: typeof DeliveryKey.Type;
      readonly responseReference: typeof ResponseReference.Type;
      readonly message: unknown;
    };
  }) => Effect.Effect<unknown, unknown>,
): SheetBotHttpClient => ({ delivery: { respond } }) as unknown as SheetBotHttpClient;

const makeOperations = (
  execute: (
    request: Parameters<HttpClient.HttpClient["execute"]>[0],
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, any>,
  respond: Parameters<typeof makeBot>[0] = () => Effect.die("unexpected delivery"),
) =>
  ServiceStatusWorkflowOperations.pipe(
    Effect.provide(serviceStatusWorkflowOperationsLayer),
    Effect.provideService(HttpClient.HttpClient, HttpClient.make(execute)),
    Effect.provideService(SheetBotDeliveryClient, { get: () => makeBot(respond) }),
  );

const definition = makeServicesDeliverStatusDefinition();
const registration = ServiceSheetWorkflowRegistrations[0]!;

describe("service-status delivery Workflow Definition slice", () => {
  it("registers one pinned v1 graph and the exact surviving Production Cell roster", () => {
    expect(definition.contract).toBe(ServicesDeliverStatus);
    expect(definition.workflow.name).toBe(workflowContractKey(ServicesDeliverStatus));
    expect(definition.actions.map(({ workflow, version }) => [workflow.name, version])).toEqual([
      ["services.deliverStatus.collect-service-readiness", "1"],
      ["services.deliverStatus.deliver-service-status", "1"],
    ]);
    expect(definition.contract.declaredFailure).toBe(InteractiveDeclaredFailure);
    expect(ServiceSheetWorkflowRegistrations).toHaveLength(1);
    expect(registration.definitionVersion).toBe("1");
    expect(ServicesDeliverStatus.authorizationPolicy).toMatchObject({
      version: "1",
      principalKinds: ["user"],
      requiredCapabilities: ["application.owner"],
      resource: "system",
    });
    expect(serviceStatusTargetNames).toEqual([
      "sheet-auth",
      "sheet-bot",
      "sheet-workflows",
      "sheet-db-server",
      "sheet-web",
    ]);
    expect(serviceReadinessTargets.map(({ url }) => url)).toEqual(
      serviceStatusTargetNames.map((service) => `http://${service}-service/ready`),
    );
    expect(Duration.toMillis(serviceReadinessAttemptTimeout)).toBe(2_000);
    expect(serviceReadinessConcurrency).toBe(4);
  });

  it.effect("returns the exact public result while durably carrying one ordered snapshot", () =>
    Effect.gen(function* () {
      const deliveredSnapshots: Array<unknown> = [];
      const body = makeServicesDeliverStatusWorkflowBody({
        collect: () => Effect.succeed(snapshot),
        deliver: (execution) => {
          deliveredSnapshots.push(execution.snapshot);
          return Effect.succeed(receipt);
        },
      });
      expect(yield* body({ invocationId, principal, input })).toEqual({
        overallStatus: "degraded",
        okCount: 4,
        downCount: 1,
        services: [
          { service: "sheet-auth", status: "ok" },
          { service: "sheet-bot", status: "down" },
          { service: "sheet-workflows", status: "ok" },
          { service: "sheet-db-server", status: "ok" },
          { service: "sheet-web", status: "ok" },
        ],
        deliveryReceipts: [receipt],
      });
      expect(deliveredSnapshots).toEqual([snapshot]);
    }),
  );

  it("preserves exact legacy rendering with no mentions", () => {
    expect(normalizePayloadText(makeServicesDeliverStatusMessage(snapshot))).toEqual({
      embeds: [
        {
          title: "Service Status",
          description: "Some services are not ready.\nChecked at <t:1786687200:F>",
          color: 0xfee75c,
          fields: [
            { name: "sheet-auth", value: "OK - 200 - 1ms", inline: true },
            { name: "sheet-bot", value: "DOWN - 503 - 2ms", inline: true },
            { name: "sheet-workflows", value: "OK - 200 - 3ms", inline: true },
            { name: "sheet-db-server", value: "OK - 200 - 4ms", inline: true },
            { name: "sheet-web", value: "OK - 200 - 5ms", inline: true },
          ],
        },
      ],
      allowedMentions: "none",
    });
  });

  it("preserves all-ready, timeout, and request-failure rendering", () => {
    const allReady = {
      ...snapshot,
      overallStatus: "ok" as const,
      services: snapshot.services.map((service) => ({
        ...service,
        status: "ok" as const,
        httpStatus: 200,
        error: null,
      })),
    };
    expect(normalizePayloadText(makeServicesDeliverStatusMessage(allReady))).toMatchObject({
      embeds: [
        { description: "All services are ready.\nChecked at <t:1786687200:F>", color: 0x57f287 },
      ],
      allowedMentions: "none",
    });
    expect(
      normalizePayloadText(
        makeServicesDeliverStatusMessage({
          ...snapshot,
          services: [
            { ...snapshot.services[0]!, status: "down", httpStatus: null, error: "timeout" },
            {
              ...snapshot.services[1]!,
              status: "down",
              httpStatus: null,
              latencyMs: null,
              error: "connection refused",
            },
          ],
        }),
      ),
    ).toMatchObject({
      embeds: [
        {
          fields: [{ value: "DOWN - timeout" }, { value: "DOWN - request failed" }],
        },
      ],
    });
  });

  it.effect("uses stable Action Keys and a delivery key independent of snapshot details", () =>
    Effect.gen(function* () {
      const message = makeServicesDeliverStatusMessage(snapshot);
      const collectPayload = { invocationId, principal, input };
      const deliveryPayload = { ...collectPayload, snapshot, message };
      const ids = [
        yield* definition.actions[0]!.workflow.executionId(collectPayload),
        yield* definition.actions[1]!.workflow.executionId(deliveryPayload),
      ];
      const replayIds = [
        yield* definition.actions[0]!.workflow.executionId(deliveryPayload),
        yield* definition.actions[1]!.workflow.executionId({
          ...deliveryPayload,
          message: { content: "changed provider outcome" },
        }),
      ];
      expect(replayIds).toEqual(ids);
      expect(new Set(ids).size).toBe(2);
      expect(deliveryKey).toBe(`services.deliverStatus:1:${invocationId}:deliver-service-status`);
    }),
  );

  it.effect("reauthorizes before readiness collection and before delivery", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      let authorized = true;
      const authorization: ReadOnlyWorkflowAuthorization["Service"] = {
        authorize: () => {
          calls.push("authorize");
          return authorized
            ? Effect.void
            : Effect.fail(new WorkflowInvocationUnauthorized({ message: "owner changed" }));
        },
        authorizeSlotOpen: () => Effect.die("unused"),
        authorizeCheckinRespond: () => Effect.die("unused"),
        authorizeRoomOrdersNavigate: () => Effect.die("unused"),
        authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
        authorizeRoomOrdersSend: () => Effect.die("unused"),
        workspaceCapabilities: () => Effect.die("unused"),
      };
      const operations: ServiceStatusWorkflowOperations["Service"] = {
        collectReadiness: () => {
          calls.push("collect");
          return Effect.succeed(snapshot);
        },
        respond: () => {
          calls.push("deliver");
          return Effect.succeed(receipt);
        },
      };
      const services = Layer.mergeAll(
        Layer.succeed(ReadOnlyWorkflowAuthorization, authorization),
        Layer.succeed(ServiceStatusWorkflowOperations, operations),
      );
      yield* executeCollectServiceReadinessAction({ invocationId, principal, input }).pipe(
        Effect.provide(services),
      );
      yield* executeDeliverServiceStatusAction({
        invocationId,
        principal,
        input,
        snapshot,
        message: makeServicesDeliverStatusMessage(snapshot),
      }).pipe(Effect.provide(services));
      expect(calls).toEqual(["authorize", "collect", "authorize", "deliver"]);
      authorized = false;
      expect(
        yield* Effect.flip(
          executeDeliverServiceStatusAction({
            invocationId,
            principal,
            input,
            snapshot,
            message: makeServicesDeliverStatusMessage(snapshot),
          }).pipe(Effect.provide(services)),
        ),
      ).toEqual({
        _tag: "AuthorizationRevoked",
        policy: ServicesDeliverStatus.authorizationPolicy.policy,
      });
      expect(calls).toEqual(["authorize", "collect", "authorize", "deliver", "authorize"]);
    }),
  );

  it.effect("enforces invocation-owner isolation at enqueue and observation", () =>
    Effect.gen(function* () {
      const authorization: ReadOnlyWorkflowAuthorization["Service"] = {
        authorize: () => Effect.void,
        authorizeSlotOpen: () => Effect.die("unused"),
        authorizeCheckinRespond: () => Effect.die("unused"),
        authorizeRoomOrdersNavigate: () => Effect.die("unused"),
        authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
        authorizeRoomOrdersSend: () => Effect.die("unused"),
        workspaceCapabilities: () => Effect.die("unused"),
      };
      yield* registration
        .authorize(context, input)
        .pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization));
      const exit = yield* Effect.exit(
        registration
          .authorizeObservation({ ...context, ownerKey: "user:forged" })
          .pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "WorkflowInvocationUnauthorized",
        });
      }
    }),
  );

  it.live(
    "collects 2xx, non-2xx, and transport failures in stable order with concurrency four",
    () =>
      Effect.gen(function* () {
        let active = 0;
        let maximumActive = 0;
        const operations = yield* makeOperations((request) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              active += 1;
              maximumActive = Math.max(maximumActive, active);
            }),
            () =>
              Effect.sleep("20 millis").pipe(
                Effect.andThen(
                  request.url.includes("sheet-bot-service")
                    ? Effect.succeed(response(request, 503))
                    : request.url.includes("sheet-web-service")
                      ? Effect.fail(new Error("connection refused"))
                      : Effect.succeed(response(request, 204)),
                ),
              ),
            () => Effect.sync(() => void (active -= 1)),
          ),
        );
        const result = yield* operations.collectReadiness();
        expect(maximumActive).toBeLessThanOrEqual(serviceReadinessConcurrency);
        expect(maximumActive).toBeGreaterThan(1);
        expect(result.overallStatus).toBe("degraded");
        expect(result.services.map(({ service }) => service)).toEqual(serviceStatusTargetNames);
        expect(result.services.map(({ status }) => status)).toEqual([
          "ok",
          "down",
          "ok",
          "ok",
          "down",
        ]);
        expect(result.services[1]).toMatchObject({ httpStatus: 503, error: "HTTP 503" });
        expect(result.services[4]).toMatchObject({
          httpStatus: null,
          latencyMs: null,
          error: "connection refused",
        });
        expect(
          new Set(result.services.map(({ checkedAt: instant }) => instant.epochMilliseconds)).size,
        ).toBe(1);
      }),
  );

  it.live("turns every timeout into a successful all-down degraded snapshot", () =>
    Effect.gen(function* () {
      const operations = yield* makeOperations(() => Effect.never);
      const result = yield* operations.collectReadiness();
      expect(result).toMatchObject({ overallStatus: "degraded" });
      expect(result.services).toHaveLength(5);
      expect(
        result.services.every(
          ({ error, httpStatus, status }) =>
            status === "down" && error === "timeout" && httpStatus === null,
        ),
      ).toBe(true);
    }),
  );

  it.effect("bounds private transport-failure detail before durably recording it", () =>
    Effect.gen(function* () {
      const operations = yield* makeOperations((request) =>
        request.url.includes("sheet-web-service")
          ? Effect.fail(new Error("x".repeat(900)))
          : Effect.succeed(response(request, 200)),
      );
      const result = yield* operations.collectReadiness();
      const detail = result.services[4]?.error;
      expect(detail).toHaveLength(512);
      expect(detail?.endsWith("...")).toBe(true);
    }),
  );

  it.effect(
    "reconciles ambiguity by Delivery Key and materializes definite rejection or expiry",
    () =>
      Effect.gen(function* () {
        const keys: Array<typeof DeliveryKey.Type> = [];
        let attempt = 0;
        const operations = yield* makeOperations(
          () => Effect.die("unused"),
          ({ payload }) => {
            keys.push(payload.deliveryKey);
            attempt += 1;
            return attempt === 1
              ? Effect.fail(new BotDependencyUnavailable({ message: "ambiguous" }))
              : Effect.succeed(receipt);
          },
        );
        const message = makeServicesDeliverStatusMessage(snapshot);
        expect(
          yield* Effect.flip(
            operations.respond(
              input,
              message,
              deliveryKey,
              ServicesDeliverStatus.authorizationPolicy.policy,
            ),
          ),
        ).toMatchObject({
          _tag: "ServiceStatusWorkflowOperationsError",
          cause: { _tag: "BotDependencyUnavailable" },
        });
        expect(
          yield* operations.respond(
            input,
            message,
            deliveryKey,
            ServicesDeliverStatus.authorizationPolicy.policy,
          ),
        ).toEqual(receipt);
        expect(keys).toEqual([deliveryKey, deliveryKey]);

        for (const { error, message: expectedMessage } of [
          {
            error: new BotRequestRejected({ message: "private rejection" }),
            message: "The service-status response was rejected",
          },
          {
            error: new BotResponseExpired({ message: "private expiry" }),
            message: "The response is no longer available",
          },
        ]) {
          const rejecting = yield* makeOperations(
            () => Effect.die("unused"),
            () => Effect.fail(error),
          );
          expect(
            yield* Effect.flip(
              rejecting.respond(
                input,
                message,
                deliveryKey,
                ServicesDeliverStatus.authorizationPolicy.policy,
              ),
            ),
          ).toEqual({
            _tag: "DeliveryRejected",
            operation: "services.deliverStatus.deliver-service-status",
            message: expectedMessage,
            recoveryRequired: false,
          });
        }
      }),
  );
});
