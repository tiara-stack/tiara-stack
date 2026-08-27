import type { BoundaryPolicy } from "./types";

const packages = {
  "sheet-domain": {
    role: "foundation",
    allowedSheetDependencies: [],
    browserEntrypoints: ["."],
  },
  "sheet-auth": {
    role: "foundation",
    allowedSheetDependencies: [],
    browserEntrypoints: ["./client", "./identity"],
  },
  "sheet-bot-api": {
    role: "contract",
    allowedSheetDependencies: ["sheet-auth", "sheet-domain"],
    browserEntrypoints: ["."],
  },
  "sheet-workflow-contracts": {
    role: "contract",
    allowedSheetDependencies: ["sheet-auth", "sheet-bot-api", "sheet-domain"],
    browserEntrypoints: ["."],
  },
  "sheet-workflow-http-client": {
    role: "client",
    allowedSheetDependencies: ["sheet-auth", "sheet-workflow-contracts"],
    browserEntrypoints: [".", "./apps-script", "./routes"],
  },
  "sheet-zero-api": {
    role: "client",
    allowedSheetDependencies: ["sheet-domain", "sheet-workflow-contracts"],
    browserEntrypoints: [".", "./client", "./rows", "./schema", "./workflows"],
  },
  "sheet-db-schema": {
    role: "implementation",
    allowedSheetDependencies: ["sheet-domain"],
  },
  "sheet-zero-server": {
    role: "implementation",
    allowedSheetDependencies: [
      "sheet-auth",
      "sheet-db-schema",
      "sheet-domain",
      "sheet-workflow-contracts",
      "sheet-zero-api",
    ],
  },
  "sheet-message-content": {
    role: "foundation",
    allowedSheetDependencies: ["sheet-bot-api", "sheet-domain"],
    browserEntrypoints: ["."],
  },
  "sheet-workflows": {
    role: "runtime",
    allowedSheetDependencies: [
      "sheet-auth",
      "sheet-bot-api",
      "sheet-domain",
      "sheet-message-content",
      "sheet-workflow-contracts",
      "sheet-zero-server",
    ],
  },
  "sheet-db-server": {
    role: "runtime",
    allowedSheetDependencies: [
      "sheet-auth",
      "sheet-db-schema",
      "sheet-zero-api",
      "sheet-zero-server",
    ],
  },
  "sheet-bot": {
    role: "runtime",
    allowedSheetDependencies: [
      "sheet-auth",
      "sheet-bot-api",
      "sheet-domain",
      "sheet-workflow-contracts",
      "sheet-workflow-http-client",
      "sheet-zero-api",
    ],
  },
  "sheet-web": {
    role: "runtime",
    allowedSheetDependencies: [
      "sheet-auth",
      "sheet-bot-api",
      "sheet-domain",
      "sheet-workflow-contracts",
      "sheet-zero-api",
    ],
  },
  "sheet-formulas": {
    role: "runtime",
    allowedSheetDependencies: [
      "sheet-domain",
      "sheet-workflow-contracts",
      "sheet-workflow-http-client",
    ],
  },
} as const satisfies BoundaryPolicy["packages"];

export const sheetPackageBoundaryPolicy = {
  packages,
  deployableRuntimes: [
    "sheet-apis",
    "sheet-bot",
    "sheet-db-server",
    "sheet-formulas",
    "sheet-ingress-server",
    "sheet-web",
    "sheet-workflows",
  ],
  gatewayCapabilities: [
    "sheet-bot-api",
    "sheet-workflow-contracts",
    "sheet-workflow-http-client",
    "sheet-zero-api",
  ],
  legacyPackages: ["sheet-apis", "sheet-ingress-api", "sheet-ingress-server"],
  exceptions: [
    {
      code: "legacy-package-present",
      package: "sheet-apis",
      reason: "The sheet API runtime remains live during expansion and caller migration.",
      removeWhen: "Delete the legacy sheet API runtime at the Deletion Gate.",
    },
    {
      code: "legacy-package-present",
      package: "sheet-ingress-api",
      reason: "Existing callers still compile against the combined ingress contract package.",
      removeWhen:
        "Delete the decomposed ingress contracts after every caller uses capability APIs.",
    },
    {
      code: "legacy-package-present",
      package: "sheet-ingress-server",
      reason:
        "The production ingress remains the legacy Rollout Gate until target paths prove parity.",
      removeWhen: "Delete the ingress runtime after the Deletion Gate and Legacy Quarantine.",
    },
    {
      code: "gateway-capability-combination",
      package: "sheet-ingress-api",
      target: "sheet-bot-api,sheet-workflow-contracts",
      reason:
        "The legacy combined contract package temporarily re-exports moved workflow values while callers migrate.",
      removeWhen: "Delete sheet-ingress-api after every caller uses capability-owned contracts.",
    },
    {
      code: "forbidden-sheet-dependency",
      package: "sheet-db-schema",
      target: "sheet-zero-api",
      reason:
        "The persistence package temporarily depends on the extracted API for legacy compatibility shims and contract tests.",
      removeWhen:
        "Remove when all consumers import sheet-zero-api directly and the legacy /zero exports are deleted.",
    },
    {
      code: "cross-package-reexport",
      package: "sheet-db-schema",
      target: "sheet-zero-api",
      path: "packages/sheet-db-schema/src/zero/index.ts",
      reason: "The legacy /zero entrypoint preserves browser API imports during caller migration.",
      removeWhen:
        "Remove when all consumers import sheet-zero-api directly and the legacy /zero exports are deleted.",
    },
    {
      code: "cross-package-reexport",
      package: "sheet-db-schema",
      target: "sheet-zero-api/server",
      path: "packages/sheet-db-schema/src/zero/index.ts",
      reason:
        "The legacy /zero entrypoint preserves trusted registry and service-client imports during caller migration.",
      removeWhen:
        "Remove when all consumers import sheet-zero-api directly and the legacy /zero exports are deleted.",
    },
    {
      code: "cross-package-reexport",
      package: "sheet-db-schema",
      target: "effect-zero-workflow",
      path: "packages/sheet-db-schema/src/zero/index.ts",
      reason:
        "The legacy /zero entrypoint preserves generic workflow request and error type exports during caller migration.",
      removeWhen:
        "Remove when all consumers import sheet-zero-api directly and the legacy /zero exports are deleted.",
    },
    {
      code: "cross-package-reexport",
      package: "sheet-db-schema",
      target: "sheet-zero-api/server",
      path: "packages/sheet-db-schema/src/zero/internal.ts",
      reason:
        "The legacy /zero/internal entrypoint preserves service and internal reference imports during caller migration.",
      removeWhen:
        "Remove when all consumers import sheet-zero-api directly and the legacy /zero exports are deleted.",
    },
    {
      code: "wildcard-export",
      package: "sheet-db-server",
      target: "./*",
      reason: "The deployable runtime retains legacy deep configuration exports.",
      removeWhen: "Replace the wildcard with explicit server-only entrypoints.",
    },
  ],
} as const satisfies BoundaryPolicy;
