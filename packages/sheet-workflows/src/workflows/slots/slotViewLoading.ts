import { Effect, Option, Predicate } from "effect";
import {
  interactiveConfigurationMissing,
  interactiveExternalOperationRejected,
  interactiveResourceNotFound,
} from "../shared/interactive";
import { providerCauseKind } from "../shared/providerFailure";
import type { SlotListProvider, SlotListProviderError } from "./slotListProvider";

const rejectSlotListProvider = (operation: string) => (error: SlotListProviderError) =>
  Effect.logWarning("The schedule provider rejected the slot view read").pipe(
    Effect.annotateLogs({
      providerOperation: error.operation,
      providerCauseKind: providerCauseKind(error.cause),
    }),
    Effect.andThen(
      Effect.fail(
        interactiveExternalOperationRejected(
          operation,
          "ProviderRejected",
          "The schedule provider rejected the slot view read",
        ),
      ),
    ),
  );

export const loadSlotViewForWorkspace = <ResolveError, OperationsError>(options: {
  readonly workspaceId: string;
  readonly day: number;
  readonly resolveWorkspace: Effect.Effect<
    Option.Option<{ readonly sheetId: string | null }>,
    ResolveError
  >;
  readonly provider: SlotListProvider["Service"];
  readonly resolveOperation: string;
  readonly loadOperation: string;
  readonly operationError: (operation: string, cause: unknown) => OperationsError;
}) =>
  options.resolveWorkspace.pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) => options.operationError(options.resolveOperation, cause)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(interactiveResourceNotFound("workspace", options.workspaceId)),
        onSome: ({ sheetId }) =>
          Predicate.isNull(sheetId)
            ? Effect.fail(interactiveConfigurationMissing("workspace.sheetId"))
            : options.provider
                .load(sheetId, options.day)
                .pipe(Effect.catch(rejectSlotListProvider(options.loadOperation))),
      }),
    ),
  );
