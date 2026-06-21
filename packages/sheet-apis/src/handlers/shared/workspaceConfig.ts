import { Effect, Option } from "effect";
import { WorkspaceConfigService } from "@/services";
import { SheetConfigError } from "sheet-ingress-api/schemas/sheetConfig";

export const getSheetIdFromWorkspaceId = Effect.fn("handlers.getSheetIdFromWorkspaceId")(function* (
  workspaceId: string,
  workspaceConfigService: typeof WorkspaceConfigService.Service,
) {
  const workspaceConfig = yield* workspaceConfigService.getWorkspaceConfig(workspaceId);

  if (Option.isNone(workspaceConfig)) {
    return yield* Effect.fail(
      new SheetConfigError({
        message: `Workspace config not found for workspaceId: ${workspaceId}`,
      }),
    );
  }

  if (Option.isNone(workspaceConfig.value.sheetId)) {
    return yield* Effect.fail(
      new SheetConfigError({ message: `sheetId not found for workspaceId: ${workspaceId}` }),
    );
  }

  return workspaceConfig.value.sheetId.value;
});
