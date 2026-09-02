import { Effect, Option } from "effect";
import type { WorkspaceId } from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import {
  missingConfigurationKey,
  resolveAuthoritativeSheetConfigurationForWorkspace,
} from "@/services/authoritativeSheetConfiguration";
import { interactiveConfigurationMissing } from "./interactive";

type WorkspaceConfiguration = Effect.Success<
  ReturnType<TrustedSheetPersistence["Service"]["workspaces"]["getWorkspaceConfigByWorkspaceId"]>
>;

/** Resolves the authoritative source for a previously loaded workspace operation. */
export const resolveAuthoritativeConfigurationForOperation = <E>(
  persistence: TrustedSheetPersistence["Service"],
  workspaceId: WorkspaceId,
  workspace: WorkspaceConfiguration,
  operation: string,
  operationError: (operation: string, cause: unknown) => E,
) =>
  resolveAuthoritativeSheetConfigurationForWorkspace(persistence, workspaceId, workspace).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) => operationError(operation, cause)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            interactiveConfigurationMissing(
              missingConfigurationKey(persistence, Option.getOrUndefined(workspace)?.sheetId),
            ),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
