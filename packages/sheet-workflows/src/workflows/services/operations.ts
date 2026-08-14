import { Clock, DateTime, Duration, Effect, Layer, Option, Predicate } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { mapDeliveryFailure } from "../shared/interactive";
import { ServiceReadinessSnapshot, serviceStatusTargetNames } from "./schema";
import { ServiceStatusWorkflowOperations, ServiceStatusWorkflowOperationsError } from "./service";

export const serviceReadinessTargets = serviceStatusTargetNames.map((service) => ({
  service,
  url: `http://${service}-service/ready`,
}));

export const serviceReadinessAttemptTimeout = Duration.seconds(2);
export const serviceReadinessConcurrency = 4;
const maximumPrivateDetailLength = 512;
type ServiceReadinessDisposition = (typeof ServiceReadinessSnapshot.Type)["services"][number];

const boundPrivateDetail = (detail: string): string =>
  detail.length <= maximumPrivateDetailLength
    ? detail
    : `${detail.slice(0, maximumPrivateDetailLength - 3)}...`;

const safeStringify = (value: unknown): string => {
  try {
    const seen = new Set<object>();
    return (
      JSON.stringify(value, (_key, nestedValue) => {
        if (Predicate.isBigInt(nestedValue)) return nestedValue.toString();
        if (Predicate.isObject(nestedValue)) {
          if (seen.has(nestedValue)) return "[Circular]";
          seen.add(nestedValue);
        }
        return nestedValue;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
};

const formatPrivateError = (error: unknown): string =>
  boundPrivateDetail(
    Predicate.isError(error)
      ? error.message
      : Predicate.isString(error)
        ? error
        : safeStringify(error),
  );

const probeTarget = (
  httpClient: HttpClient.HttpClient,
  target: (typeof serviceReadinessTargets)[number],
  checkedAt: DateTime.Utc,
): Effect.Effect<ServiceReadinessDisposition> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const response = yield* httpClient.get(target.url).pipe(
      Effect.timeoutOption(serviceReadinessAttemptTimeout),
      Effect.map(Option.getOrUndefined),
      Effect.mapError((error) => ({ _tag: "RequestError" as const, error })),
    );
    const latencyMs = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt);
    if (Predicate.isUndefined(response)) {
      return {
        ...target,
        status: "down" as const,
        httpStatus: null,
        latencyMs,
        checkedAt,
        error: "timeout",
      };
    }
    const ok = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.option,
      Effect.map(Option.isSome),
    );
    yield* response.arrayBuffer.pipe(Effect.ignore);
    return {
      ...target,
      status: ok ? ("ok" as const) : ("down" as const),
      httpStatus: response.status,
      latencyMs,
      checkedAt,
      error: ok ? null : `HTTP ${response.status}`,
    };
  }).pipe(
    Effect.catch(({ error }) =>
      Effect.succeed({
        ...target,
        status: "down" as const,
        httpStatus: null,
        latencyMs: null,
        checkedAt,
        error: formatPrivateError(error),
      }),
    ),
  );

const operationError = (operation: string, cause: unknown) =>
  new ServiceStatusWorkflowOperationsError({ operation, cause });

export const serviceStatusWorkflowOperationsLayer = Layer.effect(
  ServiceStatusWorkflowOperations,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const delivery = yield* SheetBotDeliveryClient;

    const collectReadiness: ServiceStatusWorkflowOperations["Service"]["collectReadiness"] = () =>
      Effect.gen(function* () {
        const checkedAt = yield* DateTime.now;
        const services = yield* Effect.forEach(
          serviceReadinessTargets,
          (target) => probeTarget(httpClient, target, checkedAt),
          { concurrency: serviceReadinessConcurrency },
        );
        return {
          overallStatus: services.every(({ status }) => status === "ok")
            ? ("ok" as const)
            : ("degraded" as const),
          checkedAt,
          services,
        };
      }).pipe(Effect.mapError((cause) => operationError("services.deliverStatus.collect", cause)));

    const respond: ServiceStatusWorkflowOperations["Service"]["respond"] = (
      input,
      message,
      deliveryKey,
      policy,
    ) =>
      delivery
        .get()
        .delivery.respond({
          payload: { responseReference: input.responseReference, deliveryKey, message },
        })
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError(
            mapDeliveryFailure(
              policy,
              "services.deliverStatus.deliver-service-status",
              "response",
              false,
              "The service-status response was rejected",
              operationError,
            ),
          ),
        );

    return { collectReadiness, respond };
  }),
);
