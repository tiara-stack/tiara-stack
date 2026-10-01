import { Match } from "effect";

export type AutonomousTriggerName = "autoCheckin" | "autoRoleCleanup";

export type AutonomousTriggerSelection = "all" | "autoCheckin" | "autoRoleCleanup" | "none";

export const selectAutonomousTriggerSelection = (
  triggerNames: ReadonlyArray<AutonomousTriggerName>,
): AutonomousTriggerSelection => {
  const hasAutoCheckin = triggerNames.includes("autoCheckin");
  const hasAutoRoleCleanup = triggerNames.includes("autoRoleCleanup");

  return Match.value(hasAutoCheckin).pipe(
    Match.when(true, () =>
      Match.value(hasAutoRoleCleanup).pipe(
        Match.when(true, () => "all" as const),
        Match.when(false, () => "autoCheckin" as const),
        Match.exhaustive,
      ),
    ),
    Match.when(false, () =>
      Match.value(hasAutoRoleCleanup).pipe(
        Match.when(true, () => "autoRoleCleanup" as const),
        Match.when(false, () => "none" as const),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );
};
