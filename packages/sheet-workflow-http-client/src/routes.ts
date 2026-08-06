import { workflowHttpRouteManifest } from "effect-zero-workflow/contract/http";
import { SheetWorkflowContractCatalog } from "sheet-workflow-contracts";

export const sheetWorkflowHttpRouteManifest = workflowHttpRouteManifest(
  SheetWorkflowContractCatalog,
);
