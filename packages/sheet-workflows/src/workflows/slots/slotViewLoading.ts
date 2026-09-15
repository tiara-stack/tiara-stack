import { Data, DateTime, Effect, Option, Predicate } from "effect";
import {
  normalizeScheduleTimeReference,
  scheduleTimeReferenceMetadataFrom,
  scheduleTimeReferenceFromMetadata,
  type ScheduleTimeReferenceMetadata,
  type WebSheetConfiguration,
} from "sheet-domain";
import type { WorkspaceId } from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import {
  missingConfigurationKey,
  resolveAuthoritativeSheetConfigurationForWorkspace,
} from "@/services/authoritativeSheetConfiguration";
import {
  interactiveConfigurationMissing,
  interactiveExternalOperationRejected,
  interactiveResourceNotFound,
} from "../shared/interactive";
import { providerCauseKind } from "../shared/providerFailure";
import type { SlotListProvider, SlotListProviderError } from "./slotListProvider";

class SlotWorkspaceResolutionError extends Data.TaggedError("SlotWorkspaceResolutionError")<{
  readonly cause: unknown;
}> {}

export { missingConfigurationKey };

const scheduleTimeReferenceMatchesEvent = (
  reference: ScheduleTimeReferenceMetadata,
  eventStartEpochMs: number,
): boolean =>
  DateTime.toEpochMillis(
    normalizeScheduleTimeReference(scheduleTimeReferenceFromMetadata(reference)).instant,
  ) === eventStartEpochMs;

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

export const resolveSlotWorkspace = (
  persistence: TrustedSheetPersistence["Service"],
  workspaceId: WorkspaceId,
  missingConfiguration: "workspace.sheetId" | "workspace.sheetConfiguration",
) =>
  persistence.workspaces.getWorkspaceConfigByWorkspaceId({ workspaceId }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none()),
        onSome: (workspace) =>
          resolveAuthoritativeSheetConfigurationForWorkspace(
            persistence,
            workspaceId,
            Option.some(workspace),
          ).pipe(
            Effect.map(
              Option.match({
                onNone: () => Option.some({ sheetId: null, missingConfiguration }),
                onSome: ({ spreadsheetId, configuration, scheduleTimeReference }) =>
                  Option.some({ sheetId: spreadsheetId, configuration, scheduleTimeReference }),
              }),
            ),
          ),
      }),
    ),
    Effect.mapError((cause) => new SlotWorkspaceResolutionError({ cause })),
  );

export const loadSlotViewForWorkspace = <ResolveError, OperationsError>(options: {
  readonly workspaceId: WorkspaceId;
  readonly day: number;
  readonly resolveWorkspace: Effect.Effect<
    Option.Option<{
      readonly sheetId: string | null;
      readonly configuration?: WebSheetConfiguration | null;
      readonly missingConfiguration?: "workspace.sheetId" | "workspace.sheetConfiguration";
      readonly scheduleTimeReference?: ScheduleTimeReferenceMetadata | null;
    }>,
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
        onSome: ({ sheetId, configuration, missingConfiguration, scheduleTimeReference }) =>
          Predicate.isNull(sheetId)
            ? Effect.fail(
                interactiveConfigurationMissing(missingConfiguration ?? "workspace.sheetId"),
              )
            : options.provider
                .load(sheetId, options.day, configuration ?? undefined)
                .pipe(
                  Effect.flatMap((view) => {
                    if (
                      scheduleTimeReference !== null &&
                      scheduleTimeReference !== undefined &&
                      scheduleTimeReferenceMatchesEvent(
                        scheduleTimeReference,
                        view.eventStartEpochMs,
                      )
                    ) {
                      return Effect.succeed({ ...view, scheduleTimeReference });
                    }
                    if (view.scheduleTimeReference !== undefined) return Effect.succeed(view);
                    const loadLegacy = options.provider.loadLegacyScheduleTimeReference;
                    return Predicate.isUndefined(loadLegacy)
                      ? Effect.fail(
                          interactiveConfigurationMissing("workspace.sheetScheduleConfiguration"),
                        )
                      : loadLegacy({
                          spreadsheetId: sheetId,
                          referenceInstantEpochMs: view.eventStartEpochMs,
                          ...(configuration === undefined ? {} : { configuration }),
                        }).pipe(
                          Effect.flatMap((reference) =>
                            Predicate.isUndefined(reference)
                              ? Effect.fail(
                                  interactiveConfigurationMissing(
                                    "workspace.sheetScheduleConfiguration",
                                  ),
                                )
                              : Effect.succeed({
                                  ...view,
                                  scheduleTimeReference:
                                    scheduleTimeReferenceMetadataFrom(reference),
                                }),
                          ),
                        );
                  }),
                )
                .pipe(
                  Effect.catchTag(
                    "SlotListProviderError",
                    rejectSlotListProvider(options.loadOperation),
                  ),
                ),
      }),
    ),
  );
