import type { GoogleSheets } from "../google/sheets";
import type { SheetConfigService } from "../sheetConfig";
import type { SheetZeroClient } from "../sheetZeroClient";
import type { WorkspaceConfigService } from "../workspaceConfig";

export type TeamSubmissionDependencies = {
  readonly googleSheets: typeof GoogleSheets.Service;
  readonly sheetConfigService: typeof SheetConfigService.Service;
  readonly workspaceConfigService: typeof WorkspaceConfigService.Service;
  readonly zero: typeof SheetZeroClient.Service;
};
