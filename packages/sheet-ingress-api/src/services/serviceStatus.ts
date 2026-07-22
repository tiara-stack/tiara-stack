import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { Context, DateTime, Duration, Effect, Layer, Option, Predicate } from "effect";
import type { ServicesStatusResponse } from "../handlers/status/schema";

export const serviceStatusTargets = [
  { name: "sheet-apis", url: "http://sheet-apis-service/ready" },
  { name: "sheet-auth", url: "http://sheet-auth-service/ready" },
  { name: "sheet-bot", url: "http://sheet-bot-service/ready" },
  { name: "sheet-workflows", url: "http://sheet-workflows-service/ready" },
  { name: "sheet-db-server", url: "http://sheet-db-server-service/ready" },
  { name: "sheet-ingress-server", url: "http://sheet-ingress-server-service/ready" },
  { name: "sheet-web", url: "http://sheet-web-service/ready" },
] as const;

const safeStringify = (value: unknown) => {
  try {
    const seen = new Set<object>();
    return (
      JSON.stringify(value, (_key, nestedValue) => {
        if (Predicate.isBigInt(nestedValue)) {
          return nestedValue.toString();
        }
        if (Predicate.isObject(nestedValue)) {
          if (seen.has(nestedValue)) {
            return "[Circular]";
          }
          seen.add(nestedValue);
        }
        return nestedValue;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
};

const formatError = (error: unknown) =>
  Predicate.isError(error)
    ? error.message
    : Predicate.isString(error)
      ? error
      : safeStringify(error);

export class ServiceStatusService extends Context.Service<ServiceStatusService>()(
  "ServiceStatusService",
  {
    make: Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;

      const checkService = Effect.fn("ServiceStatusService.checkService")(function* (
        target: (typeof serviceStatusTargets)[number],
        checkedAt: ServicesStatusResponse["checkedAt"],
      ) {
        const startedAt = Date.now();
        const response = yield* httpClient.get(target.url).pipe(
          Effect.timeoutOption(Duration.seconds(2)),
          Effect.map(Option.getOrUndefined),
          Effect.mapError((error) => ({ _tag: "requestError" as const, error })),
        );
        const latencyMs = Date.now() - startedAt;

        if (response === undefined) {
          return {
            ...target,
            status: "down" as const,
            httpStatus: null,
            latencyMs,
            checkedAt,
            error: "timeout",
          };
        }

        const httpStatus = response.status;
        const ok = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.option,
          Effect.map(Option.isSome),
        );

        return {
          ...target,
          status: ok ? ("ok" as const) : ("down" as const),
          httpStatus,
          latencyMs,
          checkedAt,
          error: ok ? null : `HTTP ${httpStatus}`,
        };
      });

      return {
        getServicesStatus: Effect.fn("ServiceStatusService.getServicesStatus")(function* () {
          const checkedAt = yield* DateTime.now;
          const services = yield* Effect.forEach(
            serviceStatusTargets,
            (target) =>
              checkService(target, checkedAt).pipe(
                Effect.catch(({ error }) =>
                  Effect.succeed({
                    ...target,
                    status: "down" as const,
                    httpStatus: null,
                    latencyMs: null,
                    checkedAt,
                    error: formatError(error),
                  }),
                ),
              ),
            { concurrency: 4 },
          );

          return {
            overallStatus: services.every((service) => service.status === "ok")
              ? ("ok" as const)
              : ("degraded" as const),
            checkedAt,
            services,
          };
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(ServiceStatusService, this.make);
}
