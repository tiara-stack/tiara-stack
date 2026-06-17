import { describe, expect, it } from "vitest";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { workflowRequesterActorScopes } from "./sheetWorkflows";

describe("workflowRequesterActorScopes", () => {
  it("requests service workflow scopes for service requests", () => {
    expect(workflowRequesterActorScopes(DISCORD_SERVICE_USER_ID_SENTINEL)).toEqual([
      "service",
      "workflow.dispatch",
    ]);
  });

  it("requests a service token-exchange actor for Discord user requests", () => {
    expect(workflowRequesterActorScopes("394295776655966219")).toEqual([
      "service",
      "token.exchange",
      "workflow.dispatch",
    ]);
  });
});
