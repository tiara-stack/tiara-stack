import {
  SheetConfigurationActivate,
  SheetConfigurationDiscardDraft,
  SheetConfigurationEditDraft,
  SheetConfigurationImportLegacy,
  SheetConfigurationRollback,
  SheetConfigurationSaveDraft,
  SheetConfigurationSaveRevision,
} from "sheet-workflow-contracts";

export const SheetConfigurationWorkflowContracts = Object.freeze([
  SheetConfigurationImportLegacy,
  SheetConfigurationSaveDraft,
  SheetConfigurationEditDraft,
  SheetConfigurationSaveRevision,
  SheetConfigurationActivate,
  SheetConfigurationRollback,
  SheetConfigurationDiscardDraft,
] as const);

export const sheetConfigurationWorkflowDefinitionVersion = "1";
