import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach } from "vitest";
import { auditSheetPackageBoundaries } from "./audit";
import type { BoundaryException, BoundaryPolicy } from "./types";

const temporaryRepositories: string[] = [];

const createRepository = () => {
  const repository = mkdtempSync(path.join(tmpdir(), "sheet-package-boundaries-"));
  temporaryRepositories.push(repository);
  mkdirSync(path.join(repository, "packages"));
  return repository;
};

const createPackage = (
  repository: string,
  name: string,
  manifest: Record<string, unknown> = {},
  sources: Readonly<Record<string, string>> = { "index.ts": "export const value = 1;" },
) => {
  const packageDirectory = path.join(repository, "packages", name);
  mkdirSync(path.join(packageDirectory, "src"), { recursive: true });
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({
      name,
      type: "module",
      exports: { ".": { development: "./src/index.ts", default: "./dist/index.mjs" } },
      ...manifest,
    }),
  );
  for (const [relativePath, source] of Object.entries(sources)) {
    const sourcePath = path.join(packageDirectory, "src", relativePath);
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, source);
  }
};

const policy = (exceptions: readonly BoundaryException[] = []): BoundaryPolicy => ({
  packages: {
    "sheet-contract": {
      role: "contract",
      allowedSheetDependencies: ["sheet-domain"],
      browserEntrypoints: ["."],
    },
    "sheet-domain": {
      role: "foundation",
      allowedSheetDependencies: [],
      browserEntrypoints: ["."],
    },
    "sheet-runtime": {
      role: "runtime",
      allowedSheetDependencies: ["sheet-contract", "sheet-domain"],
    },
  },
  deployableRuntimes: ["sheet-runtime"],
  gatewayCapabilities: ["sheet-contract", "sheet-zero-api"],
  legacyPackages: ["sheet-legacy"],
  exceptions,
});

const filesystemTest = (name: string, test: () => void) =>
  it.live(name, () => Effect.sync(test), 30_000);

afterEach(() => {
  for (const repository of temporaryRepositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe("sheet package boundary audit", () => {
  filesystemTest("accepts allowed DAG edges and explicit browser-safe exports", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-domain");
    createPackage(repository, "sheet-contract", {
      dependencies: { "sheet-domain": "workspace:*" },
    });
    createPackage(repository, "sheet-runtime", {
      dependencies: { "sheet-contract": "workspace:*", "sheet-domain": "workspace:*" },
    });

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([]);
  });

  filesystemTest("rejects deployable-runtime dependencies from contract packages", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-contract", {
      dependencies: { "sheet-runtime": "workspace:*" },
    });
    createPackage(repository, "sheet-runtime");

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "deployable-runtime-dependency",
        package: "sheet-contract",
        target: "sheet-runtime",
      }),
    ]);
  });

  filesystemTest("audits peer and optional sheet dependencies", () => {
    const peerRepository = createRepository();
    createPackage(peerRepository, "sheet-contract", {
      peerDependencies: { "sheet-runtime": "workspace:*" },
    });
    createPackage(peerRepository, "sheet-runtime");

    const optionalRepository = createRepository();
    createPackage(optionalRepository, "sheet-contract", {
      optionalDependencies: { "sheet-runtime": "workspace:*" },
    });
    createPackage(optionalRepository, "sheet-runtime");

    for (const repository of [peerRepository, optionalRepository]) {
      expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
        expect.objectContaining({
          code: "deployable-runtime-dependency",
          package: "sheet-contract",
          target: "sheet-runtime",
        }),
      ]);
    }
  });

  filesystemTest("rejects unapproved sheet edges and gateway-shaped combinations", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-contract", {
      dependencies: { "sheet-legacy": "workspace:*" },
    });
    createPackage(repository, "sheet-combined-gateway", {
      dependencies: {
        "sheet-contract": "workspace:*",
        "sheet-zero-api": "workspace:*",
      },
    });

    expect(
      auditSheetPackageBoundaries(repository, policy()).violations.map(
        (violation) => violation.code,
      ),
    ).toEqual(["forbidden-sheet-dependency", "gateway-capability-combination"]);
  });

  filesystemTest("uses explicit allowlists for governed capability combinations", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-contract");
    createPackage(repository, "sheet-zero-api");
    createPackage(repository, "sheet-runtime", {
      dependencies: {
        "sheet-contract": "workspace:*",
        "sheet-zero-api": "workspace:*",
      },
    });
    const governedPolicy = policy();
    const runtimeBoundary = governedPolicy.packages["sheet-runtime"];
    if (runtimeBoundary === undefined) throw new Error("Missing test runtime boundary");

    expect(
      auditSheetPackageBoundaries(repository, {
        ...governedPolicy,
        packages: {
          ...governedPolicy.packages,
          "sheet-runtime": {
            ...runtimeBoundary,
            allowedSheetDependencies: ["sheet-contract", "sheet-zero-api"],
          },
        },
      }).violations,
    ).toEqual([]);
  });

  filesystemTest("allows planned policy packages before their directories land", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-contract");
    const expansionPolicy = policy();

    expect(
      auditSheetPackageBoundaries(repository, {
        ...expansionPolicy,
        packages: {
          ...expansionPolicy.packages,
          "sheet-planned": {
            role: "foundation",
            allowedSheetDependencies: [],
          },
        },
      }).violations,
    ).toEqual([]);
  });

  filesystemTest("recognizes scoped targets without matching unknown third parties", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-contract", {
      dependencies: {
        "@scope/sheet-runtime": "workspace:*",
        "sheet-third-party": "1.0.0",
      },
    });
    const scopedPolicy = policy();

    expect(
      auditSheetPackageBoundaries(repository, {
        ...scopedPolicy,
        deployableRuntimes: [...scopedPolicy.deployableRuntimes, "@scope/sheet-runtime"],
      }).violations,
    ).toEqual([
      expect.objectContaining({
        code: "deployable-runtime-dependency",
        package: "sheet-contract",
        target: "@scope/sheet-runtime",
      }),
    ]);
  });

  filesystemTest("audits discovered scoped sheet workspaces", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-contract", {
      dependencies: { "@scope/sheet-runtime": "workspace:*" },
    });
    const scopedDirectory = path.join(repository, "packages", "scoped-runtime");
    mkdirSync(path.join(scopedDirectory, "src"), { recursive: true });
    writeFileSync(
      path.join(scopedDirectory, "package.json"),
      JSON.stringify({
        name: "@scope/sheet-runtime",
        type: "module",
        exports: { ".": "./src/index.ts" },
      }),
    );
    writeFileSync(path.join(scopedDirectory, "src", "index.ts"), "export const value = true;");

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "forbidden-sheet-dependency",
        package: "sheet-contract",
        target: "@scope/sheet-runtime",
      }),
    ]);
  });

  filesystemTest("rejects wildcard package exports", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-contract", {
      exports: {
        ".": { development: "./src/index.ts", default: "./dist/index.mjs" },
        "./*": "./dist/*.mjs",
      },
    });

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "wildcard-export",
        package: "sheet-contract",
        target: "./*",
      }),
    ]);
  });

  filesystemTest("rejects wildcards in non-default export conditions", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-contract", {
      exports: {
        ".": {
          default: "./dist/index.mjs",
          types: "./dist/*.d.ts",
        },
      },
    });

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "wildcard-export",
        package: "sheet-contract",
        target: ".",
      }),
    ]);
  });

  filesystemTest("rejects transitive server exports from browser entrypoints", () => {
    const repository = createRepository();
    createPackage(
      repository,
      "sheet-contract",
      {},
      {
        "index.ts": 'export * from "./public";',
        "public.ts": 'export { secret } from "./server/secret";',
        "server/secret.ts": 'export const secret = "server-only";',
      },
    );

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "browser-server-export",
        package: "sheet-contract",
        target: "./server/secret",
      }),
    ]);
  });

  filesystemTest("rejects convenience re-exports of another package's concepts", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-domain");
    createPackage(
      repository,
      "sheet-contract",
      {},
      {
        "index.ts": 'export { value } from "sheet-domain";',
      },
    );

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "cross-package-reexport",
        package: "sheet-contract",
        target: "sheet-domain",
      }),
    ]);
  });

  filesystemTest("rejects type-only concept and server re-exports", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-domain", {}, { "index.ts": "export type Value = string;" });
    createPackage(
      repository,
      "sheet-contract",
      {},
      {
        "index.ts": [
          'export type { Value } from "sheet-domain";',
          'export type { Secret } from "./server/secret";',
        ].join("\n"),
        "server/secret.ts": "export type Secret = string;",
      },
    );

    expect(
      auditSheetPackageBoundaries(repository, policy()).violations.map(({ code, target }) => ({
        code,
        target,
      })),
    ).toEqual([
      { code: "browser-server-export", target: "./server/secret" },
      { code: "cross-package-reexport", target: "sheet-domain" },
    ]);
  });

  filesystemTest("follows imported bindings that entrypoints export separately", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-domain");
    createPackage(
      repository,
      "sheet-contract",
      {},
      {
        "index.ts": [
          'import { value } from "sheet-domain";',
          'import { secret } from "./server/secret";',
          "export { secret, value };",
        ].join("\n"),
        "server/secret.ts": 'export const secret = "server-only";',
      },
    );

    expect(
      auditSheetPackageBoundaries(repository, policy()).violations.map(({ code, target }) => ({
        code,
        target,
      })),
    ).toEqual([
      { code: "browser-server-export", target: "./server/secret" },
      { code: "cross-package-reexport", target: "sheet-domain" },
    ]);
  });

  filesystemTest("requires exact legacy exceptions and reports them when they become stale", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-legacy");
    const exception = {
      code: "legacy-package-present",
      package: "sheet-legacy",
      reason: "Callers still use it.",
      removeWhen: "All callers migrate.",
    } as const;

    const activeAudit = auditSheetPackageBoundaries(repository, policy([exception]));
    expect(activeAudit.violations).toEqual([]);
    expect(activeAudit.suppressed).toEqual([
      expect.objectContaining({ code: "legacy-package-present", package: "sheet-legacy" }),
    ]);

    rmSync(path.join(repository, "packages", "sheet-legacy"), { recursive: true, force: true });
    expect(auditSheetPackageBoundaries(repository, policy([exception])).violations).toEqual([
      expect.objectContaining({ code: "stale-exception", package: "sheet-legacy" }),
    ]);
  });

  filesystemTest("rejects duplicate exceptions", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-legacy");
    const exception = {
      code: "legacy-package-present",
      package: "sheet-legacy",
      reason: "Callers still use it.",
      removeWhen: "All callers migrate.",
    } as const;

    expect(
      auditSheetPackageBoundaries(
        repository,
        policy([exception, exception, exception]),
      ).violations.map(({ code }) => code),
    ).toEqual(["duplicate-exception"]);
  });

  filesystemTest("reports duplicate exception metadata and staleness only once", () => {
    const repository = createRepository();
    const exception = {
      code: "legacy-package-present",
      package: "sheet-legacy",
      reason: "",
      removeWhen: "All callers migrate.",
    } as const;

    expect(
      auditSheetPackageBoundaries(
        repository,
        policy([exception, exception, exception]),
      ).violations.map(({ code }) => code),
    ).toEqual(["duplicate-exception", "invalid-exception", "stale-exception"]);
  });

  filesystemTest("does not let invalid exceptions suppress active violations", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-legacy");
    const exception = {
      code: "legacy-package-present",
      package: "sheet-legacy",
      reason: "",
      removeWhen: "All callers migrate.",
    } as const;

    const audit = auditSheetPackageBoundaries(repository, policy([exception]));
    expect(audit.suppressed).toEqual([]);
    expect(audit.violations.map(({ code }) => code)).toEqual([
      "invalid-exception",
      "legacy-package-present",
    ]);
  });

  filesystemTest("selects browser conditions before default export targets", () => {
    const repository = createRepository();
    createPackage(
      repository,
      "sheet-contract",
      {
        exports: {
          ".": {
            browser: "./src/browser.ts",
            default: "./dist/index.mjs",
          },
        },
      },
      {
        "browser.ts": 'export { secret } from "./server/secret";',
        "index.ts": "export const safe = true;",
        "server/secret.ts": 'export const secret = "server-only";',
      },
    );

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "browser-server-export",
        package: "sheet-contract",
        target: "./server/secret",
      }),
    ]);
  });

  filesystemTest("reports browser entrypoints missing from the export map", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-contract", {
      exports: { "./safe": "./src/index.ts" },
    });

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "browser-entry-unresolved",
        package: "sheet-contract",
        target: ".",
      }),
    ]);
  });

  filesystemTest("reports browser entrypoints whose source file is missing", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-contract", {
      exports: { ".": "./src/missing.ts" },
    });

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "browser-entry-unresolved",
        package: "sheet-contract",
        target: ".",
      }),
    ]);
  });

  filesystemTest("does not resolve browser entrypoints through server-only conditions", () => {
    const repository = createRepository();
    createPackage(
      repository,
      "sheet-contract",
      { exports: { ".": { node: "./src/server.ts" } } },
      { "server.ts": "export const secret = true;" },
    );

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "browser-entry-unresolved",
        package: "sheet-contract",
        target: ".",
      }),
    ]);
  });

  filesystemTest("does not resolve browser entrypoints through unknown conditions", () => {
    const repository = createRepository();
    createPackage(
      repository,
      "sheet-contract",
      { exports: { ".": { custom: "./src/custom.ts" } } },
      { "custom.ts": "export const value = true;" },
    );

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "browser-entry-unresolved",
        package: "sheet-contract",
        target: ".",
      }),
    ]);
  });

  filesystemTest("audits source modules when neighboring dist files exist", () => {
    const repository = createRepository();
    createPackage(
      repository,
      "sheet-contract",
      { exports: { ".": { default: "./dist/index.mjs" } } },
      {
        "index.ts": 'export { secret } from "./server/secret";',
        "server/secret.ts": 'export const secret = "server-only";',
      },
    );
    const distDirectory = path.join(repository, "packages", "sheet-contract", "dist");
    mkdirSync(distDirectory);
    writeFileSync(path.join(distDirectory, "index.mjs"), "export const safe = true;");

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "browser-server-export",
        package: "sheet-contract",
        target: "./server/secret",
      }),
    ]);
  });

  filesystemTest("maps nested build-format targets back to source modules", () => {
    const repository = createRepository();
    createPackage(
      repository,
      "sheet-contract",
      { exports: { ".": { default: "./dist/esm/index.js" } } },
      {
        "index.ts": 'export { secret } from "./server/secret";',
        "server/secret.ts": 'export const secret = "server-only";',
      },
    );

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "browser-server-export",
        package: "sheet-contract",
        target: "./server/secret",
      }),
    ]);
  });

  filesystemTest("resolves directory exports to their index module", () => {
    const repository = createRepository();
    createPackage(
      repository,
      "sheet-contract",
      {},
      {
        "index.ts": 'export * from "./server";',
        "server/index.ts": 'export const secret = "server-only";',
      },
    );

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "browser-server-export",
        package: "sheet-contract",
        target: "./server",
      }),
    ]);
  });

  filesystemTest("recognizes server tokens in camel-case module names", () => {
    const repository = createRepository();
    createPackage(
      repository,
      "sheet-contract",
      {},
      {
        "index.ts": 'export * from "./sheetServer";',
        "sheetServer.ts": 'export const secret = "server-only";',
      },
    );

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "browser-server-export",
        package: "sheet-contract",
        target: "./sheetServer",
      }),
    ]);
  });

  filesystemTest("reports relative re-exports outside the audited source roots", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-contract", {}, { "index.ts": 'export * from "../outside";' });
    writeFileSync(
      path.join(repository, "packages", "sheet-contract", "outside.ts"),
      "export const value = true;",
    );

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "source-analysis-unresolved",
        package: "sheet-contract",
        target: ".",
        path: "packages/sheet-contract/outside.ts",
      }),
    ]);
  });

  filesystemTest("rejects relative cross-package re-exports from non-browser runtimes", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-domain");
    createPackage(
      repository,
      "sheet-runtime",
      { dependencies: { "sheet-domain": "workspace:*" } },
      { "index.ts": 'export * from "../../sheet-domain/src/index";' },
    );

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([
      expect.objectContaining({
        code: "cross-package-reexport",
        package: "sheet-runtime",
        target: "sheet-domain",
      }),
    ]);
  });

  filesystemTest("normalizes string and condition-object root exports", () => {
    const stringRepository = createRepository();
    createPackage(stringRepository, "sheet-contract", { exports: "./src/index.ts" });
    expect(auditSheetPackageBoundaries(stringRepository, policy()).violations).toEqual([]);

    const conditionsRepository = createRepository();
    createPackage(conditionsRepository, "sheet-contract", {
      exports: {
        development: "./src/index.ts",
        default: "./dist/index.mjs",
      },
    });
    expect(auditSheetPackageBoundaries(conditionsRepository, policy()).violations).toEqual([]);
  });

  filesystemTest("accepts null and array package export targets", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-contract", {
      exports: {
        ".": [null, "./src/index.ts"],
        "./private": null,
      },
    });

    expect(auditSheetPackageBoundaries(repository, policy()).violations).toEqual([]);
  });

  filesystemTest("reports invalid manifests with their file path", () => {
    const repository = createRepository();
    const packageDirectory = path.join(repository, "packages", "invalid");
    mkdirSync(packageDirectory);
    const manifestPath = path.join(packageDirectory, "package.json");
    writeFileSync(manifestPath, JSON.stringify({ version: "1.0.0" }));

    expect(() => auditSheetPackageBoundaries(repository, policy())).toThrow(
      `Invalid package manifest at ${manifestPath}`,
    );
  });

  filesystemTest("rejects malformed audited source files", () => {
    const repository = createRepository();
    createPackage(repository, "sheet-contract", {}, { "index.ts": "export const = ;" });

    expect(() => auditSheetPackageBoundaries(repository, policy())).toThrow(
      "Unable to parse audited sources",
    );
  });

  filesystemTest(
    "resolves imports in exported expressions without confusing shadowed names",
    () => {
      const repository = createRepository();
      createPackage(repository, "sheet-array");
      createPackage(repository, "sheet-domain");
      createPackage(repository, "sheet-namespace");
      createPackage(repository, "sheet-satisfies");
      createPackage(repository, "sheet-zero-api");
      createPackage(
        repository,
        "sheet-contract",
        {},
        {
          "index.ts": [
            'import { value as arrayValue } from "sheet-array";',
            'import { value } from "sheet-domain";',
            'import * as namespace from "sheet-namespace";',
            'import { value as satisfiesValue } from "sheet-satisfies";',
            'import { zeroValue } from "sheet-zero-api";',
            "export default value;",
            "export const alias = { zeroValue };",
            "export const arrayAlias = [...arrayValue];",
            "export const namespaceAlias = namespace.value;",
            "export const satisfiesAlias = satisfiesValue satisfies unknown;",
            'export const local = ((value: string) => value)("local");',
          ].join("\n"),
        },
      );

      expect(
        auditSheetPackageBoundaries(repository, policy()).violations.map(({ code, target }) => ({
          code,
          target,
        })),
      ).toEqual([
        { code: "cross-package-reexport", target: "sheet-array" },
        { code: "cross-package-reexport", target: "sheet-domain" },
        { code: "cross-package-reexport", target: "sheet-namespace" },
        { code: "cross-package-reexport", target: "sheet-satisfies" },
        { code: "cross-package-reexport", target: "sheet-zero-api" },
      ]);
    },
  );
});
