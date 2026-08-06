import type { Schema as ZeroSchema } from "@rocicorp/zero";
import {
  makeWorkflowZeroGroup,
  type WorkflowZeroGroupOptions,
} from "effect-zero-workflow/contract/zero";
import { SheetWorkflowContractCatalog } from "sheet-workflow-contracts";
import type { ZeroApiGroup } from "typhoon-zero/zeroApi";

export const makeSheetWorkflowZeroGroups = <
  TSchema extends ZeroSchema,
  Context,
  WrappedTransaction = unknown,
>(
  options: WorkflowZeroGroupOptions<TSchema, Context, WrappedTransaction>,
): ReadonlyArray<ZeroApiGroup.Any> =>
  SheetWorkflowContractCatalog.map((contract) => makeWorkflowZeroGroup(contract, options));
