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
    browserEntrypoints: ["./client"],
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
    browserEntrypoints: ["."],
  },
  "sheet-zero-api": {
    role: "client",
    allowedSheetDependencies: ["sheet-auth", "sheet-domain", "sheet-workflow-contracts"],
    browserEntrypoints: ["."],
  },
  "sheet-db-schema": {
    role: "implementation",
    allowedSheetDependencies: ["sheet-domain"],
  },
  "sheet-zero-server": {
    role: "implementation",
    allowedSheetDependencies: ["sheet-auth", "sheet-db-schema", "sheet-domain", "sheet-zero-api"],
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
      "sheet-workflow-http-client",
      "sheet-zero-api",
    ],
  },
  "sheet-web": {
    role: "runtime",
    allowedSheetDependencies: [
      "sheet-auth",
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
      code: "forbidden-sheet-dependency",
      package: "sheet-message-content",
      target: "sheet-ingress-api",
      reason: "Rendering values have not yet moved to sheet-domain and sheet-bot-api.",
      removeWhen: "Remove after the capability-owned rendering schemas exist.",
    },
    {
      code: "wildcard-export",
      package: "sheet-message-content",
      target: "./*",
      reason: "Consumers still use legacy deep rendering imports during expansion.",
      removeWhen: "Replace with the explicit rendering subpaths used by migrated callers.",
    },
    {
      code: "cross-package-reexport",
      package: "sheet-message-content",
      target: "sheet-ingress-api/schemas/client",
      path: "packages/sheet-message-content/src/text.ts",
      reason: "SheetTextPart is still owned by the legacy ingress schema tree.",
      removeWhen: "Move SheetTextPart to its selected capability owner and import it directly.",
    },
    {
      code: "forbidden-sheet-dependency",
      package: "sheet-workflows",
      target: "sheet-db-schema",
      reason: "The trusted persistence implementation has not yet moved behind sheet-zero-server.",
      removeWhen: "Switch the workflow runtime to the in-process sheet-zero-server boundary.",
    },
    {
      code: "forbidden-sheet-dependency",
      package: "sheet-workflows",
      target: "sheet-ingress-api",
      reason: "Workflow dispatch still uses gateway-era contracts during expansion.",
      removeWhen: "Publish and adopt the transport-neutral Workflow Contract catalog.",
    },
    {
      code: "cross-package-reexport",
      package: "sheet-workflows",
      target: "sheet-ingress-api/internal",
      path: "packages/sheet-workflows/src/middlewares/sheetAuthTokenAuthorization/live.ts",
      reason: "The runtime still exposes legacy forwarded-auth middleware.",
      removeWhen: "Replace forwarded identity with Effective Principal authentication adapters.",
    },
    {
      code: "cross-package-reexport",
      package: "sheet-db-schema",
      target: "effect-zero-workflow",
      path: "packages/sheet-db-schema/src/zero/api/runs.ts",
      reason: "The persistence package currently republishes generic workflow run concepts.",
      removeWhen:
        "Move declared workflow run values to sheet-workflow-contracts and import them directly.",
    },
    {
      code: "wildcard-export",
      package: "sheet-db-server",
      target: "./*",
      reason: "The deployable runtime retains legacy deep configuration exports.",
      removeWhen: "Replace the wildcard with explicit server-only entrypoints.",
    },
    {
      code: "forbidden-sheet-dependency",
      package: "sheet-bot",
      target: "sheet-db-schema",
      reason: "The bot currently obtains Zero contracts from the persistence package.",
      removeWhen: "Switch the bot to the service client exposed by sheet-zero-api.",
    },
    {
      code: "forbidden-sheet-dependency",
      package: "sheet-bot",
      target: "sheet-ingress-api",
      reason: "The bot still uses combined ingress and workflow contracts.",
      removeWhen: "Adopt sheet-bot-api and sheet-workflow-http-client.",
    },
    {
      code: "forbidden-sheet-dependency",
      package: "sheet-web",
      target: "sheet-ingress-api",
      reason: "The web application still uses the legacy combined client contracts.",
      removeWhen: "Move browser callers to sheet-zero-api and Workflow Contract types.",
    },
    {
      code: "forbidden-sheet-dependency",
      package: "sheet-web",
      target: "sheet-message-content",
      reason: "The current web application still imports legacy shared rendering helpers.",
      removeWhen: "Move the caller to capability-owned domain and bot response values.",
    },
    {
      code: "cross-package-reexport",
      package: "sheet-web",
      target: "sheet-ingress-api/schemas/userConfig",
      path: "packages/sheet-web/src/lib/userConfig.ts",
      reason:
        "The web helper currently republishes a schema owned by the combined ingress package.",
      removeWhen: "Import the capability-owned user configuration schema directly at callers.",
    },
    {
      code: "forbidden-sheet-dependency",
      package: "sheet-formulas",
      target: "sheet-ingress-api",
      reason: "Apps Script still enqueues work through the legacy ingress contract.",
      removeWhen: "Switch formulas to the enqueue surface of sheet-workflow-http-client.",
    },
  ],
} as const satisfies BoundaryPolicy;
