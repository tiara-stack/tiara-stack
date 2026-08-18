import { createHash } from "node:crypto";
import { InvocationId } from "effect-zero-workflow/contract";
import { CalculationsRecalculateSheet } from "sheet-workflow-contracts";
import { calculationSerializationVersion } from "./catalog";

export const calculationActionIdentities = Object.freeze({
  load: "load-calculation-source",
  write: "write-calculation-projection",
} as const);

export type CalculationActionIdentity =
  (typeof calculationActionIdentities)[keyof typeof calculationActionIdentities];

const calculationIdentityDigest = (spreadsheetId: string, canonicalSheetRef: string): string =>
  createHash("sha256")
    .update(JSON.stringify([spreadsheetId, canonicalSheetRef]))
    .digest("hex");

export const makeCalculationActionKey = (
  invocationId: typeof InvocationId.Type,
  actionIdentity: CalculationActionIdentity,
  spreadsheetId: string,
  canonicalSheetRef: string,
): string =>
  JSON.stringify([
    CalculationsRecalculateSheet.identity,
    invocationId,
    actionIdentity,
    calculationIdentityDigest(spreadsheetId, canonicalSheetRef),
  ]);

export const makeCalculationSerializationKey = (
  spreadsheetId: string,
  canonicalSheetRef: string,
): string => {
  const identity = JSON.stringify([
    calculationSerializationVersion,
    spreadsheetId,
    canonicalSheetRef,
  ]);
  const digest = createHash("sha256").update(identity).digest("hex");
  return JSON.stringify(["calculation-projection", digest]);
};
