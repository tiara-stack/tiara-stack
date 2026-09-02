import { Effect, Layer, Match, Option } from "effect";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { resolveAuthoritativeConfigurationForOperation } from "../shared/authoritativeConfiguration";
import {
  interactiveConfigurationMissing,
  interactiveExternalOperationRejected,
  interactiveResourceNotFound,
  mapDeliveryFailure,
} from "../shared/interactive";
import { providerCauseKind } from "../shared/providerFailure";
import { TeamWorkflowOperations, TeamWorkflowOperationsError } from "./service";
import { UserTeamsProvider, UserTeamsProviderError } from "./provider";

const operationError = (operation: string, cause: unknown) =>
  new TeamWorkflowOperationsError({ operation, cause });

const providerRejected = (error: UserTeamsProviderError) =>
  Effect.logWarning("The team provider rejected the user teams read").pipe(
    Effect.annotateLogs({
      providerOperation: error.operation,
      providerCauseKind: providerCauseKind(error.cause),
    }),
    Effect.andThen(
      Effect.fail(
        Match.value(error.operation).pipe(
          Match.when("read-configuration", () =>
            interactiveConfigurationMissing("workspace.teamConfiguration"),
          ),
          Match.orElse(() =>
            interactiveExternalOperationRejected(
              "teams.deliverList.loadUserTeams",
              "ProviderRejected",
              "The team provider rejected the user teams read",
            ),
          ),
        ),
      ),
    ),
  );

export const teamWorkflowOperationsLayer = Layer.effect(
  TeamWorkflowOperations,
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const provider = yield* UserTeamsProvider;
    const delivery = yield* SheetBotDeliveryClient;

    const loadUserTeams: TeamWorkflowOperations["Service"]["loadUserTeams"] = (input) =>
      Effect.gen(function* () {
        const workspace = yield* persistence.workspaces
          .getWorkspaceConfigByWorkspaceId({ workspaceId: input.workspaceId })
          .pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) => operationError("teams.deliverList.resolveWorkspace", cause)),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(interactiveResourceNotFound("workspace", input.workspaceId)),
                onSome: Effect.succeed,
              }),
            ),
          );
        const active = yield* resolveAuthoritativeConfigurationForOperation(
          persistence,
          input.workspaceId,
          Option.some(workspace),
          "teams.deliverList.resolveSource",
          operationError,
        );
        return yield* provider
          .load(active.spreadsheetId, active.configuration)
          .pipe(Effect.catch(providerRejected));
      });

    const respond: TeamWorkflowOperations["Service"]["respond"] = (
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
              "teams.deliverList.respond",
              "response",
              false,
              "The team-list response was rejected",
              operationError,
            ),
          ),
        );

    return { loadUserTeams, respond };
  }),
);
