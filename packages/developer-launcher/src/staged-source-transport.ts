import { NodeHttpClient } from "@effect/platform-node";
import { Cause, Context, Duration, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  RunnerRevisionStatusSchema,
  StagedRunnerSnapshotActivationRequestSchema,
  StagedRunnerSnapshotIdentitySchema,
  stagedSourceActivationTimeouts,
  type RunnerRevisionStatus,
  type StagedRunnerSnapshotIdentity,
  type StagedSourceSnapshot,
} from "sheet-workflow-contracts";

export class StagedRunnerSnapshotTransportError extends Schema.TaggedErrorClass<StagedRunnerSnapshotTransportError>()(
  "StagedRunnerSnapshotTransportError",
  { reason: Schema.String },
) {}

/** A caller must resolve and authorize this exact session-owned runner target. */
export type StagedRunnerSnapshotTarget = {
  readonly endpoint: string;
  readonly identity: StagedRunnerSnapshotIdentity;
  readonly authorizationToken: Redacted.Redacted<string>;
};

export interface StagedRunnerSnapshotTransportApi {
  readonly activate: (input: {
    readonly target: StagedRunnerSnapshotTarget;
    readonly snapshot: StagedSourceSnapshot;
  }) => Effect.Effect<RunnerRevisionStatus, StagedRunnerSnapshotTransportError>;
}

export class StagedRunnerSnapshotTransport extends Context.Service<
  StagedRunnerSnapshotTransport,
  StagedRunnerSnapshotTransportApi
>()("developer-launcher/StagedRunnerSnapshotTransport") {}

export const StagedRunnerSnapshotTransportLive = (options?: {
  readonly allowInsecureLoopbackForTests?: boolean;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly requestTimeout?: Duration.Input;
}) =>
  Layer.effect(
    StagedRunnerSnapshotTransport,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const activate: StagedRunnerSnapshotTransportApi["activate"] = ({ target, snapshot }) =>
        Effect.gen(function* () {
          const parsedEndpoint = yield* Effect.try({
            try: () => new URL(target.endpoint),
            catch: () =>
              new StagedRunnerSnapshotTransportError({ reason: "invalid-runner-endpoint" }),
          });
          const allowLoopbackHttp =
            options?.allowInsecureLoopbackForTests === true &&
            parsedEndpoint.protocol === "http:" &&
            ["localhost", "127.0.0.1", "::1"].includes(
              parsedEndpoint.hostname.replace(/^\[|\]$/g, ""),
            );
          if (parsedEndpoint.protocol !== "https:" && !allowLoopbackHttp)
            return yield* Effect.fail(
              new StagedRunnerSnapshotTransportError({ reason: "runner-endpoint-requires-tls" }),
            );
          const token = Redacted.value(target.authorizationToken);
          if (token.trim().length === 0)
            return yield* Effect.fail(
              new StagedRunnerSnapshotTransportError({ reason: "runner-authorization-required" }),
            );
          const identity = yield* Schema.decodeUnknownEffect(StagedRunnerSnapshotIdentitySchema)(
            target.identity,
          ).pipe(
            Effect.mapError(
              () => new StagedRunnerSnapshotTransportError({ reason: "invalid-runner-target" }),
            ),
          );
          const request = yield* HttpClientRequest.schemaBodyJson(
            StagedRunnerSnapshotActivationRequestSchema,
          )({ identity, snapshot })(
            HttpClientRequest.post(
              new URL("/_internal/runner-source/v1/activate", parsedEndpoint).toString(),
            ).pipe(HttpClientRequest.bearerToken(target.authorizationToken)),
          ).pipe(
            Effect.mapError(
              () =>
                new StagedRunnerSnapshotTransportError({
                  reason: "runner-request-encoding-failed",
                }),
            ),
          );
          const response = httpClient.execute(request).pipe(
            Effect.mapError(
              () => new StagedRunnerSnapshotTransportError({ reason: "runner-request-failed" }),
            ),
            Effect.flatMap((rawResponse) =>
              HttpClientResponse.filterStatusOk(rawResponse).pipe(
                Effect.mapError(
                  () => new StagedRunnerSnapshotTransportError({ reason: "runner-request-denied" }),
                ),
              ),
            ),
            Effect.flatMap((okResponse) =>
              HttpClientResponse.schemaBodyJson(RunnerRevisionStatusSchema)(okResponse).pipe(
                Effect.mapError(
                  () =>
                    new StagedRunnerSnapshotTransportError({ reason: "invalid-runner-response" }),
                ),
              ),
            ),
          );
          return yield* response.pipe(
            Effect.timeout(
              options?.requestTimeout ?? stagedSourceActivationTimeouts.transportRequest,
            ),
            Effect.mapError((error) =>
              Cause.isTimeoutError(error)
                ? new StagedRunnerSnapshotTransportError({ reason: "runner-request-failed" })
                : error,
            ),
          );
        });
      return { activate } satisfies StagedRunnerSnapshotTransportApi;
    }),
  ).pipe(Layer.provide(options?.httpClientLayer ?? NodeHttpClient.layerNodeHttp));
