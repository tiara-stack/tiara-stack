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
    "sheet-bot",
    "sheet-db-server",
    "sheet-formulas",
    "sheet-web",
    "sheet-workflows",
  ],
  gatewayCapabilities: [
    "sheet-bot-api",
    "sheet-workflow-contracts",
    "sheet-workflow-http-client",
    "sheet-zero-api",
  ],
  legacyPackages: [],
  exceptions: [
    {
      code: "forbidden-sheet-dependency",
      package: "sheet-db-schema",
      target: "sheet-zero-api",
      reason:
        "The persistence package depends on the extracted API for generated schema parity and test database contracts.",
      removeWhen:
        "Remove when schema generation and parity checks no longer require the generated API package.",
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
