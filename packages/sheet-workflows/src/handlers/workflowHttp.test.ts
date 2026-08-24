import { describe, expect, it } from "@effect/vitest";
import { sheetWorkflowHttpEnqueueContracts } from "./workflowHttp";

describe("sheet workflow HTTP enqueue boundary", () => {
  it("exposes the gateway workflow contracts", () => {
    expect(sheetWorkflowHttpEnqueueContracts.map(({ identity }) => identity)).toEqual([
      "services.deliverStatus",
      "schedules.deliverUserSchedule",
      "calculations.recalculateSheet",
      "workspaces.deliverWelcome",
      "teamSubmissions.process",
      "teamSubmissions.decide",
      "announcements.deliverUpdate",
    ]);
  });
});
