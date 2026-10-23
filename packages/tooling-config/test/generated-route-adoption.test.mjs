import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite-plus";
import { describe, expect, it } from "vitest";
import {
  createGeneratedRouteAdoptionPlugin,
  decorateGeneratedRouteTree,
} from "../src/generated-route-adoption.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const routeProof = JSON.parse(
  readFileSync(new URL("./fixtures/route28-base-bijection.json", import.meta.url), "utf8"),
);
const noUnsafeDirective =
  "/* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */";
const startVitePluginUrl = pathToFileURL(
  path.join(root, "packages/sheet-web/node_modules/@tanstack/react-start/dist/esm/plugin/vite.js"),
);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const disableCount = (source) => source.split(noUnsafeDirective).length - 1;
const acceptedBaseFromDecorated = (source) => {
  let result = Buffer.from(source);
  const spans = routeProof.previousRepresentation.directiveSpans.flatMap(({ directives }) =>
    ["disable", "enable"].map((kind) => ({
      kind,
      start:
        directives[kind].start -
        routeProof.previousRepresentation.baseReconstruction.leadingSpaceBytes,
      end: directives[kind].end,
    })),
  );
  spans.sort((left, right) => right.start - left.start);
  for (const { kind, start, end } of spans) {
    expect(result.subarray(start, end).toString()).toBe(
      ` /* oxlint-${kind} ${routeProof.rule} -- inherited master site */`,
    );
    result = Buffer.concat([result.subarray(0, start), result.subarray(end)]);
  }
  return result;
};

describe("TanStack Start generator plugin composition", () => {
  it("runs caller generator plugins alongside Start's route and client-tree plugins", async () => {
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "tiara-route-generator-api-"));
    const sourceRoot = path.join(temporaryRoot, "src");
    const routesRoot = path.join(sourceRoot, "routes");
    const generatedRouteTree = path.join(sourceRoot, "routeTree.gen.ts");
    const originalManifest = globalThis.TSS_ROUTES_MANIFEST;
    const calls = { initialized: 0, changed: 0, routePaths: [] };
    let generator;
    let server;

    mkdirSync(routesRoot, { recursive: true });
    writeFileSync(
      path.join(temporaryRoot, "package.json"),
      JSON.stringify({ name: "route-generator-api-fixture", private: true, type: "module" }),
    );
    symlinkSync(
      path.join(root, "packages/sheet-web/node_modules"),
      path.join(temporaryRoot, "node_modules"),
    );
    writeFileSync(
      path.join(routesRoot, "__root.tsx"),
      "import { createRootRoute } from '@tanstack/react-router';\nexport const Route = createRootRoute({ component: () => null });\n",
    );
    writeFileSync(
      path.join(routesRoot, "index.tsx"),
      "import { createFileRoute } from '@tanstack/react-router';\nexport const Route = createFileRoute('/')({ component: () => null });\n",
    );
    writeFileSync(
      path.join(sourceRoot, "router.tsx"),
      "import { createRouter } from '@tanstack/react-router';\nimport { routeTree } from './routeTree.gen';\nexport const getRouter = () => createRouter({ routeTree });\n",
    );

    const callerPlugin = {
      name: "route-adoption-api-probe",
      init(options) {
        calls.initialized += 1;
        generator = options.generator;
      },
      onRouteTreeChanged({ routeNodes }) {
        calls.changed += 1;
        calls.routePaths = routeNodes.map(({ routePath }) => routePath);
      },
    };
    const callerPlugins = Object.freeze([callerPlugin]);

    try {
      const { tanstackStart } = await import(startVitePluginUrl.href);
      server = await createServer({
        appType: "custom",
        configFile: false,
        logLevel: "silent",
        root: temporaryRoot,
        plugins: tanstackStart({
          srcDirectory: "src",
          router: {
            tmpDir: path.join(temporaryRoot, ".tanstack", "tmp"),
            plugins: callerPlugins,
          },
        }),
        server: { middlewareMode: true },
      });

      const generated = readFileSync(generatedRouteTree, "utf8");
      const transformedClientTree = await server.transformRequest(generatedRouteTree);

      expect(calls.initialized).toBe(1);
      expect(calls.changed).toBe(1);
      expect(generator.config.generatedRouteTree).toBe(generatedRouteTree);
      expect(calls.routePaths).toContain("/");
      expect(generated).toContain("const IndexRoute = IndexRouteImport.update({");
      expect(globalThis.TSS_ROUTES_MANIFEST).toHaveProperty("/");
      expect(transformedClientTree?.code).toContain("routeTree");
      expect(callerPlugins).toEqual([callerPlugin]);
    } finally {
      await server?.close();
      if (originalManifest === undefined) delete globalThis.TSS_ROUTES_MANIFEST;
      else globalThis.TSS_ROUTES_MANIFEST = originalManifest;
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("binds only the 28 accepted assertion identities and is idempotent", () => {
    const baseSource = Buffer.from(
      routeProof.baseReconstruction.baseContentBase64,
      "base64",
    ).toString("utf8");
    expect(sha256(baseSource)).toBe(routeProof.base.contentSha256);

    const decorated = decorateGeneratedRouteTree(baseSource);
    expect(sha256(decorated)).toBe(routeProof.previousRepresentation.decoratedRoute.contentSha256);
    expect(disableCount(decorated)).toBe(28);
    expect(acceptedBaseFromDecorated(decorated).toString("utf8")).toBe(baseSource);
    expect(decorateGeneratedRouteTree(decorated)).toBe(decorated);

    const changedRoute = baseSource.replace("path: '/ready'", "path: '/ready-renamed'");
    const changedOutput = decorateGeneratedRouteTree(changedRoute);
    const readyStart = changedOutput.indexOf("const ReadyRoute =");
    const liveStart = changedOutput.indexOf("const LiveRoute =", readyStart);
    expect(disableCount(changedOutput)).toBe(27);
    expect(changedOutput.slice(readyStart, liveStart)).not.toContain(noUnsafeDirective);

    const addedRoute = [
      "const AddedRoute = AddedRouteImport.update({",
      "  id: '/added',",
      "  path: '/added',",
      "  getParentRoute: () => rootRouteImport,",
      "} as any)",
      "",
    ].join("\n");
    const addedOutput = decorateGeneratedRouteTree(`${baseSource}\n${addedRoute}`);
    const addedStart = addedOutput.indexOf("const AddedRoute =");
    expect(disableCount(addedOutput)).toBe(28);
    expect(addedOutput.slice(addedStart)).toContain("} as any)");
    expect(addedOutput.slice(addedStart)).not.toContain(noUnsafeDirective);
  });

  it("keeps directive-shaped route strings while decorating the actual assertions", () => {
    const baseSource = Buffer.from(
      routeProof.baseReconstruction.baseContentBase64,
      "base64",
    ).toString("utf8");
    const enableDirective =
      "/* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */";
    const literal = `const markerCanary = ${JSON.stringify(`${noUnsafeDirective} ${enableDirective}`)};`;
    const decorated = decorateGeneratedRouteTree(`${baseSource}\n${literal}\n`);

    expect(decorated).toContain(literal);
    expect(disableCount(decorated)).toBe(29);
    expect(decorateGeneratedRouteTree(decorated)).toBe(decorated);

    const loneLiteral = `const loneMarkerCanary = ${JSON.stringify(noUnsafeDirective)};`;
    const loneMarkerOutput = decorateGeneratedRouteTree(`${baseSource}\n${loneLiteral}\n`);
    expect(loneMarkerOutput).toContain(loneLiteral);
    expect(disableCount(loneMarkerOutput)).toBe(29);
    expect(decorateGeneratedRouteTree(loneMarkerOutput)).toBe(loneMarkerOutput);
  });

  it("retains inherited pairs through configured route additions and generated-file watch events", async () => {
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "tiara-route-adoption-dev-"));
    const sourceRoot = path.join(temporaryRoot, "src");
    const routesRoot = path.join(sourceRoot, "routes");
    const generatedRouteTree = path.join(sourceRoot, "routeTree.gen.ts");
    const originalManifest = globalThis.TSS_ROUTES_MANIFEST;
    const calls = { initialized: 0, changed: 0 };
    let generator;
    let server;

    mkdirSync(sourceRoot, { recursive: true });
    cpSync(path.join(root, "packages/sheet-web/src/routes"), routesRoot, { recursive: true });
    writeFileSync(
      path.join(temporaryRoot, "package.json"),
      JSON.stringify({ name: "route-adoption-dev-fixture", private: true, type: "module" }),
    );
    symlinkSync(
      path.join(root, "packages/sheet-web/node_modules"),
      path.join(temporaryRoot, "node_modules"),
    );
    writeFileSync(
      path.join(sourceRoot, "router.tsx"),
      "import { createRouter } from '@tanstack/react-router';\nimport { routeTree } from './routeTree.gen';\nexport const getRouter = () => createRouter({ routeTree });\n",
    );

    const probePlugin = {
      name: "route-adoption-dev-probe",
      init(options) {
        calls.initialized += 1;
        generator = options.generator;
      },
      onRouteTreeChanged() {
        calls.changed += 1;
      },
    };

    try {
      const { tanstackStart } = await import(startVitePluginUrl.href);
      server = await createServer({
        appType: "custom",
        configFile: false,
        logLevel: "silent",
        root: temporaryRoot,
        // The generator/watch assertions do not need dependency pre-bundling.
        optimizeDeps: { noDiscovery: true, include: [] },
        plugins: tanstackStart({
          srcDirectory: "src",
          router: {
            tmpDir: path.join(temporaryRoot, ".tanstack", "tmp"),
            plugins: [
              probePlugin,
              createGeneratedRouteAdoptionPlugin({
                generatedRouteTreePath: generatedRouteTree,
              }),
            ],
          },
        }),
        server: { middlewareMode: true },
      });

      const initial = readFileSync(generatedRouteTree, "utf8");
      expect(sha256(initial)).toBe(routeProof.decoratedRoute.contentSha256);
      expect(disableCount(initial)).toBe(28);
      expect(globalThis.TSS_ROUTES_MANIFEST).toHaveProperty("/ready");
      expect((await server.transformRequest(generatedRouteTree))?.code).toContain("routeTree");
      server.watcher.unwatch([routesRoot, generatedRouteTree]);

      const addedRoutePath = path.join(routesRoot, "about.tsx");
      writeFileSync(
        addedRoutePath,
        "import { createFileRoute } from '@tanstack/react-router';\nexport const Route = createFileRoute('/about')({ component: () => null });\n",
      );
      await server.environments.client.pluginContainer.watchChange(addedRoutePath, {
        event: "create",
      });

      const regenerated = readFileSync(generatedRouteTree, "utf8");
      const addedStart = regenerated.indexOf("const AboutRoute =");
      const nextDeclaration = regenerated.indexOf("\nconst ", addedStart + 1);
      expect(calls.initialized).toBe(1);
      expect(calls.changed).toBe(2);
      expect(regenerated).toContain("id: '/about'");
      expect(disableCount(regenerated)).toBe(28);
      expect(regenerated.slice(addedStart, nextDeclaration)).toContain("as any");
      expect(regenerated.slice(addedStart, nextDeclaration)).not.toContain(noUnsafeDirective);
      expect(globalThis.TSS_ROUTES_MANIFEST).toHaveProperty("/about");

      await server.environments.client.pluginContainer.watchChange(generatedRouteTree, {
        event: "update",
      });
      expect(readFileSync(generatedRouteTree, "utf8")).toBe(regenerated);
      expect(calls.changed).toBe(2);
      await generator.run({ type: "rerun" });
      expect(readFileSync(generatedRouteTree, "utf8")).toBe(regenerated);
      expect(calls.changed).toBe(2);
    } finally {
      await server?.close();
      if (originalManifest === undefined) delete globalThis.TSS_ROUTES_MANIFEST;
      else globalThis.TSS_ROUTES_MANIFEST = originalManifest;
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
