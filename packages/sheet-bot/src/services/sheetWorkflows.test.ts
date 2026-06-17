import { describe, expect, it } from "vitest";
import { Redacted } from "effect";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { workflowRequesterActorScopes, workflowSubjectTokenOptions } from "./sheetWorkflows";

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

describe("workflowSubjectTokenOptions", () => {
  it("lets sheet-auth choose the subject token audience", () => {
    const kubernetesServiceAccountToken = Redacted.make("kubernetes-token");

    const options = workflowSubjectTokenOptions(
      "394295776655966219",
      kubernetesServiceAccountToken,
    );

    expect(options).toEqual({
      subject: "discord:394295776655966219",
      expiresIn: 60,
      kubernetesServiceAccountToken,
    });
    expect(options).not.toHaveProperty("audience");
  });
});
