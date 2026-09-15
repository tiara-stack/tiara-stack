import {
  SheetConfigurationActivate,
  SheetConfigurationDiscardDraft,
  SheetConfigurationEditDraft,
  SheetConfigurationImportLegacy,
  SheetConfigurationRollback,
  SheetConfigurationSaveDraft,
  SheetConfigurationSaveRevision,
  SheetConfigurationScheduleTimeReferenceApply,
  SheetConfigurationScheduleTimeReferencePreview,
} from "sheet-workflow-contracts";

export const SheetConfigurationWorkflowContracts = Object.freeze([
  SheetConfigurationImportLegacy,
  SheetConfigurationSaveDraft,
  SheetConfigurationEditDraft,
  SheetConfigurationSaveRevision,
  SheetConfigurationActivate,
  SheetConfigurationRollback,
  SheetConfigurationDiscardDraft,
  SheetConfigurationScheduleTimeReferencePreview,
  SheetConfigurationScheduleTimeReferenceApply,
] as const);

export const sheetConfigurationWorkflowDefinitionVersion = "1";
