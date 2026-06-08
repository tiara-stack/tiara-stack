import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { readKubernetesTokenFile } from "./sheetApisRpcTokens";

describe("SheetApisRpcTokens", () => {
  it("reads the current Kubernetes token file contents on each call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sheet-ingress-token-"));
    const tokenPath = join(dir, "sheet-apis-token");

    try {
      await writeFile(tokenPath, "first-token\n", "utf-8");

      const firstToken = await Effect.runPromise(
        readKubernetesTokenFile(tokenPath, "sheet-apis").pipe(Effect.provide(NodeFileSystem.layer)),
      );

      await writeFile(tokenPath, "rotated-token\n", "utf-8");

      const rotatedToken = await Effect.runPromise(
        readKubernetesTokenFile(tokenPath, "sheet-apis").pipe(Effect.provide(NodeFileSystem.layer)),
      );

      expect(firstToken).toBe("first-token");
      expect(rotatedToken).toBe("rotated-token");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
