import { describe, expect, it } from "vitest";
import { makeKimiDependencyGraphTools } from "./kimi-tools";

describe("Kimi dependency graph tools", () => {
  it("registers all dependency graph external tools", () => {
    const tools = makeKimiDependencyGraphTools({
      dbPath: "/tmp/missing.sqlite",
      versionId: "version",
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "resolve_symbol",
      "symbol_dependencies",
      "symbol_dependents",
    ]);
    expect(tools.dispose).toBeInstanceOf(Function);
    expect(tools[0]?.parameters).toMatchObject({
      type: "object",
      properties: {
        name: {
          anyOf: expect.arrayContaining([expect.objectContaining({ type: "string" })]),
        },
      },
    });
  });

  it("returns JSON error output for invalid edge kind", async () => {
    const tool = makeKimiDependencyGraphTools({
      dbPath: "/tmp/missing.sqlite",
      versionId: "version",
    }).find((candidate) => candidate.name === "symbol_dependencies")!;

    const result = await tool.handler({
      symbolKey: "symbol",
      edgeKinds: ["invalid"],
    });

    expect(JSON.parse(result.output)).toHaveProperty("error");
  });

  it("returns JSON error output for invalid limit", async () => {
    const tool = makeKimiDependencyGraphTools({
      dbPath: "/tmp/missing.sqlite",
      versionId: "version",
    }).find((candidate) => candidate.name === "resolve_symbol")!;

    const result = await tool.handler({
      name: "run",
      limit: 0,
    });

    expect(JSON.parse(result.output)).toHaveProperty("error");
  });

  it("returns JSON error output for store failures", async () => {
    const tool = makeKimiDependencyGraphTools({
      dbPath: "/tmp/missing.sqlite",
      versionId: "version",
    }).find((candidate) => candidate.name === "resolve_symbol")!;

    const result = await tool.handler({ name: "run" });

    expect(JSON.parse(result.output)).toHaveProperty("error");
  });
});
