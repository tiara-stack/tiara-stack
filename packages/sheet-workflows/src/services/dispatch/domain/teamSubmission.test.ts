import { describe, expect, it } from "vitest";
import { boundTeamListFields } from "./teamSubmission";

const field = (name: string, value: string) => ({ name, value });

describe("boundTeamListFields", () => {
  it("preserves the exact field limit and summarizes one-over-limit fields", () => {
    const exact = Array.from({ length: 25 }, (_, index) => field(`Team ${index}`, "ready"));
    const overflow = [...exact, field("Team 25", "ready")];

    expect(boundTeamListFields(exact, "Teams")).toEqual(exact);
    expect(boundTeamListFields(overflow, "Teams")).toEqual([
      ...exact.slice(0, 24),
      { name: "More teams", value: "2 additional teams were omitted." },
    ]);
  });

  it("preserves the exact character limit and summarizes character-only overflow", () => {
    const fields = Array.from({ length: 5 }, () => field("", "x".repeat(1_024)));

    expect(boundTeamListFields(fields, "x".repeat(880))).toEqual(fields);
    expect(boundTeamListFields(fields, "x".repeat(881))).toEqual([
      ...fields.slice(0, 4),
      { name: "More teams", value: "1 additional team was omitted." },
    ]);
  });

  it("truncates field names and values at their Discord limits", () => {
    const [bounded] = boundTeamListFields([field("n".repeat(257), "v".repeat(1_025))], "Teams");

    expect(bounded?.name).toHaveLength(256);
    expect(bounded?.name.endsWith("…")).toBe(true);
    expect(bounded?.value).toHaveLength(1_024);
    expect(bounded?.value.endsWith("…")).toBe(true);
  });
});
