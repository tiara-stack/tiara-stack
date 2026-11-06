import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Schema } from "effect";
import { expect, it } from "@effect/vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const playwrightPackageModulePath = resolve(packageRoot, "src/services/playwrightPackage.ts");

const PlaywrightDependencyManifest = Schema.Struct({
  dependencies: Schema.Struct({ playwright: Schema.NonEmptyString }),
});

const pinnedPlaywrightVersion = () => {
  const manifestJson: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  return Schema.decodeUnknownSync(PlaywrightDependencyManifest)(manifestJson).dependencies
    .playwright;
};

const createRuntimeLayout = () => {
  const root = mkdtempSync(join(tmpdir(), "tia250-playwright-runtime-"));
  const distDirectory = join(root, "dist");
  const nodeModulesDirectory = join(root, "node_modules");
  mkdirSync(distDirectory, { recursive: true });
  mkdirSync(nodeModulesDirectory, { recursive: true });

  const referrerPath = join(distDirectory, "index.mjs");
  const playwrightModulePath = join(root, "playwrightPackage.ts");
  writeFileSync(referrerPath, "export {};\n");
  copyFileSync(playwrightPackageModulePath, playwrightModulePath);
  symlinkSync(
    resolve(packageRoot, "node_modules/effect"),
    join(nodeModulesDirectory, "effect"),
    "dir",
  );
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ type: "module" })}\n`);

  return {
    root,
    referrerUrl: pathToFileURL(referrerPath).href,
    playwrightManifestPath: join(root, "node_modules/playwright/package.json"),
    playwrightModuleUrl: pathToFileURL(playwrightModulePath).href,
  };
};

const runIsolatedNode = (root: string, source: string) => {
  const environment = { ...process.env, NODE_PATH: "" };
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", source],
    { cwd: root, encoding: "utf8", env: environment },
  );
};

const acquireRuntimeLayout = Effect.acquireRelease(Effect.sync(createRuntimeLayout), (layout) =>
  Effect.sync(() => rmSync(layout.root, { recursive: true, force: true })),
);

it.live("loads the pinned Node package after the temporary browser smoke package is removed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layout = yield* acquireRuntimeLayout;
      const version = pinnedPlaywrightVersion();

      mkdirSync(dirname(layout.playwrightManifestPath), { recursive: true });
      writeFileSync(
        layout.playwrightManifestPath,
        `${JSON.stringify({ name: "playwright", version })}\n`,
      );
      const temporarySmokePackage = join(
        layout.root,
        "tmp/browser-runtime/node_modules/playwright/package.json",
      );
      mkdirSync(dirname(temporarySmokePackage), { recursive: true });
      writeFileSync(temporarySmokePackage, `${JSON.stringify({ name: "playwright", version })}\n`);
      rmSync(join(layout.root, "tmp/browser-runtime"), { recursive: true, force: true });

      expect(existsSync(join(layout.root, "ms-playwright"))).toBe(false);

      const child = runIsolatedNode(
        layout.root,
        `import { Effect } from "effect";
import { playwrightPackageVersionFrom } from ${JSON.stringify(layout.playwrightModuleUrl)};
const version = Effect.runSync(playwrightPackageVersionFrom(${JSON.stringify(layout.referrerUrl)}));
console.log(JSON.stringify({ version }));`,
      );

      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      const resultJson: unknown = JSON.parse(child.stdout.trim());
      const result = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.NonEmptyString }))(
        resultJson,
      );
      expect(result.version).toBe(version);
    }),
  ),
);

it.live("keeps missing or malformed package metadata inside a typed Effect failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const invalidManifests: ReadonlyArray<{
        readonly name: string;
        readonly content?: string;
      }> = [
        { name: "missing" },
        { name: "malformed JSON", content: "{" },
        { name: "empty version", content: `${JSON.stringify({ version: "" })}\n` },
      ];

      for (const invalidManifest of invalidManifests) {
        const layout = yield* acquireRuntimeLayout;
        if (invalidManifest.content !== undefined) {
          mkdirSync(dirname(layout.playwrightManifestPath), { recursive: true });
          writeFileSync(layout.playwrightManifestPath, invalidManifest.content);
        }

        const child = runIsolatedNode(
          layout.root,
          `import { Cause, Effect, Exit, Option } from "effect";
import { playwrightPackageVersionFrom } from ${JSON.stringify(layout.playwrightModuleUrl)};
const exit = Effect.runSyncExit(playwrightPackageVersionFrom(${JSON.stringify(layout.referrerUrl)}));
if (Exit.isFailure(exit)) {
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  console.log(JSON.stringify({ outcome: "failure", tag: error?._tag ?? null }));
} else {
  console.log(JSON.stringify({ outcome: "unexpected-success", tag: null, version: exit.value }));
}`,
        );

        expect(child.error, invalidManifest.name).toBeUndefined();
        expect(child.status, invalidManifest.name).toBe(0);
        const resultJson: unknown = JSON.parse(child.stdout.trim());
        const result = Schema.decodeUnknownSync(
          Schema.Struct({ outcome: Schema.String, tag: Schema.NullOr(Schema.String) }),
        )(resultJson);
        expect(result.outcome, invalidManifest.name).toBe("failure");
        expect(result.tag, invalidManifest.name).toBe("ConfigError");
      }
    }),
  ),
);

it.live("imports the package metadata boundary without an installed Playwright ancestor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layout = yield* acquireRuntimeLayout;
      const child = runIsolatedNode(
        layout.root,
        `await import(${JSON.stringify(layout.playwrightModuleUrl)});
console.log("package metadata boundary imported");`,
      );

      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout.trim()).toBe("package metadata boundary imported");
    }),
  ),
);
