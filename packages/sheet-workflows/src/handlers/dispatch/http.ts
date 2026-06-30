import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { SheetWorkflowsInternalApi } from "sheet-ingress-api/sheet-workflows-internal";
import { DispatchWorkflows } from "@/workflows/dispatchWorkflows";

export const dispatchLayer = HttpApiBuilder.group(
  SheetWorkflowsInternalApi as never,
  "dispatchWorkflows" as never,
  (handlers) => {
    let current = handlers as any;

    for (const workflow of DispatchWorkflows) {
      current = current
        .handle(
          workflow.name,
          Effect.fnUntraced(function* ({ payload }: { readonly payload: never }) {
            return yield* workflow.execute(payload);
          }) as never,
        )
        .handle(
          `${workflow.name}Discard`,
          Effect.fnUntraced(function* ({ payload }: { readonly payload: never }) {
            return yield* workflow.execute(payload, { discard: true });
          }) as never,
        )
        .handle(
          `${workflow.name}Resume`,
          Effect.fnUntraced(function* ({
            payload,
          }: {
            readonly payload: { readonly executionId: string };
          }) {
            return yield* workflow.resume(payload.executionId);
          }) as never,
        );
    }

    return current;
  },
);
