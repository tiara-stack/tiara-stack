import { Context, Effect, Layer } from "effect";
import { DispatchWorkflowOperations } from "sheet-ingress-api/internal";
import { SheetWorkflowsHttpClient } from "./sheetWorkflowsHttpClient";

type DispatchWorkflowOperation =
  (typeof DispatchWorkflowOperations)[keyof typeof DispatchWorkflowOperations];
type SheetWorkflowsHttpClientService = Context.Service.Shape<typeof SheetWorkflowsHttpClient>;
type DispatchWorkflowClient =
  SheetWorkflowsHttpClientService["dispatchWorkflows"][DispatchWorkflowOperation["discardRpcTag"]];
type DispatchWorkflowEffect = ReturnType<DispatchWorkflowClient>;
type DispatchWorkflowError =
  DispatchWorkflowEffect extends Effect.Effect<unknown, infer Error, unknown> ? Error : never;
type DispatchWorkflowRequirements =
  DispatchWorkflowEffect extends Effect.Effect<unknown, unknown, infer Requirements>
    ? Requirements
    : never;
type DispatchWorkflowForwarders = {
  readonly [Operation in DispatchWorkflowOperation as Operation["endpointName"]]: (
    args: Operation["workflow"]["payloadSchema"]["~type.make.in"],
  ) => Effect.Effect<
    {
      readonly runId: string;
      readonly operation: Operation["operation"];
      readonly status: "accepted";
    },
    DispatchWorkflowError,
    DispatchWorkflowRequirements
  >;
};

export class SheetWorkflowsForwardingClient extends Context.Service<SheetWorkflowsForwardingClient>()(
  "SheetWorkflowsForwardingClient",
  {
    make: Effect.gen(function* () {
      const httpClient = yield* SheetWorkflowsHttpClient;

      const accept =
        <const Operation extends DispatchWorkflowOperation, Error, Requirements>(
          operation: Operation,
          fn: (
            args: Operation["workflow"]["payloadSchema"]["~type.make.in"],
          ) => Effect.Effect<string, Error, Requirements>,
        ) =>
        (args: Operation["workflow"]["payloadSchema"]["~type.make.in"]) =>
          Effect.gen(function* () {
            const runId = yield* fn(args);
            return {
              runId,
              operation: operation.operation,
              status: "accepted" as const,
            };
          });

      const forward = <const Operation extends DispatchWorkflowOperation>(operation: Operation) =>
        accept(operation, (args) =>
          httpClient.dispatchWorkflows[operation.discardRpcTag]({
            payload: args,
          } as never),
        );

      const dispatch = Object.fromEntries(
        Object.values(DispatchWorkflowOperations).map(
          (operation) => [operation.endpointName, forward(operation)] as const,
        ),
      ) as DispatchWorkflowForwarders;

      return { dispatch };
    }),
  },
) {
  static layer = Layer.effect(SheetWorkflowsForwardingClient, this.make).pipe(
    Layer.provide(SheetWorkflowsHttpClient.layer),
  );
}
