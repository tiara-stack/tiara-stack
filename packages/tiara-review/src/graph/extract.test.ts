import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { extractDependencyGraph } from "./extract";

describe("dependency graph extraction", () => {
  it("records edges to declarations discovered by another tsconfig", () => {
    const repo = mkdtempSync(join(tmpdir(), "tiara-review-extract."));
    try {
      mkdirSync(join(repo, "packages/a/src"), { recursive: true });
      mkdirSync(join(repo, "packages/b/src"), { recursive: true });
      const compilerOptions = {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
      };
      writeFileSync(
        join(repo, "packages/a/tsconfig.json"),
        JSON.stringify({ compilerOptions, include: ["src/**/*.ts"] }),
      );
      writeFileSync(
        join(repo, "packages/b/tsconfig.json"),
        JSON.stringify({ compilerOptions, include: ["src/**/*.ts"] }),
      );
      writeFileSync(
        join(repo, "packages/a/src/a.ts"),
        `export function makeThing() {
  return "thing";
}
`,
      );
      writeFileSync(
        join(repo, "packages/b/src/b.ts"),
        `import { makeThing } from "../../a/src/a";

export function useThing() {
  return makeThing();
}
`,
      );

      const graph = extractDependencyGraph(repo);
      const makeThing = graph.symbols.find(
        (symbol) => symbol.path === "packages/a/src/a.ts" && symbol.name === "makeThing",
      );
      const useThing = graph.symbols.find(
        (symbol) => symbol.path === "packages/b/src/b.ts" && symbol.name === "useThing",
      );

      expect(makeThing).toBeDefined();
      expect(useThing).toBeDefined();
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          fromSymbolKey: useThing!.symbolKey,
          toSymbolKey: makeThing!.symbolKey,
          kind: "call",
        }),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
