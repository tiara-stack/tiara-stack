import { Predicate, Schema } from "effect";
import { RolloutGateDecision, type RolloutGateExecutionPath } from "sheet-workflow-contracts";

export type RolloutGateDecisionValue = Schema.Schema.Type<typeof RolloutGateDecision>;

export interface RolloutGateStoredControl {
  readonly revision: number;
  readonly executionPath: RolloutGateExecutionPath;
  readonly reason: string;
}

export const selectRolloutGateDecision = ({
  gateKey,
  row,
  fallbackReason,
}: {
  readonly gateKey: string;
  readonly row?: RolloutGateStoredControl | undefined;
  readonly fallbackReason?: "control-unavailable" | "unconfigured" | undefined;
}): RolloutGateDecisionValue => {
  const storedReason = row?.reason.trim();
  const matched = Predicate.isNotUndefined(row);

  return {
    gateKey,
    revision: row?.revision ?? 0,
    matched,
    executionPath: row?.executionPath ?? "legacy",
    reason:
      Predicate.isNotUndefined(storedReason) && storedReason.length > 0
        ? storedReason
        : matched
          ? "reason-missing"
          : (fallbackReason ?? "unconfigured"),
  };
};
