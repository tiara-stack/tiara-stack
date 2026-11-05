import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import path from "node:path";
import { expect } from "vitest";
import { PreviewGatewayError, type PreviewGatewayAdapters } from "./preview-gateway";
import {
  loadPreviewGatewayAdapters,
  loadPreviewGatewayAdaptersFromTrustedDirectory,
} from "./preview-gateway-runtime";
import type { PreviewWorkflowApiAuthorityPayload } from "./preview-workflow-api-authority";
import { previewWorkflowApiDatabaseEndpointIdentity } from "./preview-workflow-api-supervisor";

const makeAuthority = (): PreviewWorkflowApiAuthorityPayload => {
  const endpoint = "postgres://workflow.dev.tiara-stack.moe/tiara";
  const databaseEndpointIdentity = previewWorkflowApiDatabaseEndpointIdentity(endpoint);
  if (databaseEndpointIdentity === undefined) throw new Error("test target is invalid");
  return {
    schemaVersion: 1,
    issuedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_060_000,
    gatewayDomain: "dev.example.test",
    workflowExecution: {
      workflowApiEndpoint: "https://workflow-api.dev.tiara-stack.moe",
      databaseEndpoint: endpoint,
      databaseEndpointIdentity,
      stateIdentity: "workflow-state-dev",
      deployedManifestDigest: `sha256:${"a".repeat(64)}`,
      schemaArtifactDigest: `sha256:${"b".repeat(64)}`,
      workflowContractCatalogDigest: `sha256:${"c".repeat(64)}`,
      authIssuer: "https://auth.dev.tiara-stack.moe",
      credentialEnvironmentBindings: [],
    },
    runtimeArtifactAttestations: { schemaVersion: 1, packages: {} },
  };
};

const unavailable = () => Effect.fail(new PreviewGatewayError({ reason: "unavailable" }));
const gatewayAdapters: PreviewGatewayAdapters = {
  checkSetup: Effect.succeed({
    domain: "dev.example.test",
    observedAt: 1_800_000_000_000,
    wildcardDns: true,
    wildcardCertificate: true,
    independentGatewayAuthentication: true,
    applicationIdentityMediation: true,
    browserDependencyMediation: true,
    singleControllerFenceDelivery: true,
  }),
  authenticate: () => unavailable(),
  connect: () => unavailable(),
  connectChannel: () => unavailable(),
  recoverChannel: () => unavailable(),
};

type TrustedPathMetadata = { readonly uid: number; readonly mode: number };

const filesystemRootAncestors = (pathAtRoot: string) => {
  const ancestors: string[] = [];
  let current = path.dirname(pathAtRoot);
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) return ancestors;
    current = parent;
  }
};

const withTrustedDirectoryMetadata = (
  fileSystem: FileSystem.FileSystem,
  trustedRoot: string,
  modulePath: string,
  metadataOverrides: ReadonlyMap<string, TrustedPathMetadata> = new Map(),
  canonicalPathOverrides: ReadonlyMap<string, string> = new Map(),
): FileSystem.FileSystem => {
  const metadata = new Map<string, TrustedPathMetadata>(
    filesystemRootAncestors(trustedRoot).map((ancestor) => [ancestor, { uid: 0, mode: 0o755 }]),
  );
  metadata.set(trustedRoot, { uid: 0, mode: 0o755 });
  metadata.set(modulePath, { uid: 0, mode: 0o600 });
  for (const [metadataPath, override] of metadataOverrides) metadata.set(metadataPath, override);

  return {
    ...fileSystem,
    realPath: (filePath) => {
      const canonicalPath = canonicalPathOverrides.get(filePath);
      if (canonicalPath !== undefined) return Effect.succeed(canonicalPath);
      return fileSystem.realPath(filePath);
    },
    stat: (filePath) =>
      fileSystem.stat(filePath).pipe(
        Effect.map((info) => {
          const override = metadata.get(filePath);
          if (override === undefined) return info;
          return { ...info, uid: Option.some(override.uid), mode: override.mode };
        }),
      ),
  };
};

it.live("loads only an external typed gateway adapter bound to the signed gateway domain", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const external = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "preview-gateway-adapter-",
    });
    const externalAliasParent = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "preview-gateway-adapter-alias-",
    });
    const externalAlias = `${externalAliasParent}/external`;
    yield* fileSystem.symlink(external, externalAlias);
    const canonicalExternal = yield* fileSystem.realPath(externalAlias);
    const modulePath = `${canonicalExternal}/runtime.mjs`;
    yield* fileSystem.writeFileString(modulePath, "// host-installed adapter marker\n", {
      mode: 0o600,
    });
    const authority = makeAuthority();
    const runtime = {
      adapters: gatewayAdapters,
      https: {
        host: "127.0.0.1",
        port: 0,
        certificate: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
        privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
      },
    };
    const loadedExit = yield* Effect.exit(
      loadPreviewGatewayAdaptersFromTrustedDirectory(
        {
          checkout: process.cwd(),
          environment: { TIARA_PREVIEW_GATEWAY_ADAPTER_MODULE: modulePath },
          authority,
          importModule: () => Effect.succeed({ makePreviewGatewayRuntime: () => runtime }),
        },
        canonicalExternal,
      ),
    );
    expect(loadedExit._tag, JSON.stringify(loadedExit)).toBe("Success");
    if (loadedExit._tag === "Success") {
      expect(Option.isSome(loadedExit.value)).toBe(true);
      if (Option.isSome(loadedExit.value)) {
        expect(loadedExit.value.value.domain).toBe(authority.gatewayDomain);
        expect(loadedExit.value.value.adapters).toBe(gatewayAdapters);
        expect(loadedExit.value.value.https.port).toBe(0);
      }
    }

    const fixedPortRejected = yield* Effect.exit(
      loadPreviewGatewayAdaptersFromTrustedDirectory(
        {
          checkout: process.cwd(),
          environment: { TIARA_PREVIEW_GATEWAY_ADAPTER_MODULE: modulePath },
          authority,
          importModule: () =>
            Effect.succeed({
              makePreviewGatewayRuntime: () => ({
                ...runtime,
                https: { ...runtime.https, port: 45_443 },
              }),
            }),
        },
        canonicalExternal,
      ),
    );
    expect(fixedPortRejected._tag).toBe("Failure");

    const checkout = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "preview-gateway-checkout-",
    });
    const checkoutModule = `${checkout}/runtime.mjs`;
    yield* fileSystem.writeFileString(checkoutModule, "// mutable checkout module\n", {
      mode: 0o600,
    });
    const rejected = yield* Effect.exit(
      loadPreviewGatewayAdaptersFromTrustedDirectory(
        {
          checkout,
          environment: { TIARA_PREVIEW_GATEWAY_ADAPTER_MODULE: checkoutModule },
          authority,
          importModule: () => Effect.succeed({ makePreviewGatewayRuntime: () => runtime }),
        },
        checkout,
      ),
    );
    expect(rejected._tag).toBe("Failure");
    const absent = yield* Effect.exit(
      loadPreviewGatewayAdaptersFromTrustedDirectory(
        {
          checkout,
          environment: {},
          authority,
          importModule: () => Effect.die("must not load an unconfigured adapter"),
        },
        external,
      ),
    );
    expect(absent._tag).toBe("Failure");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("requires a canonical trusted adapter root and protected ancestors before import", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const checkout = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "preview-gateway-ancestor-checkout-",
    });
    const trustedRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "preview-gateway-ancestor-root-",
    });
    const modulePath = `${trustedRoot}/runtime.mjs`;
    yield* fileSystem.writeFileString(modulePath, "// host-installed adapter marker\n", {
      mode: 0o600,
    });
    const canonicalTrustedRoot = yield* fileSystem.realPath(trustedRoot);
    const unsafeAncestor = path.dirname(canonicalTrustedRoot);
    const authority = makeAuthority();
    const runtime = {
      adapters: gatewayAdapters,
      https: {
        host: "127.0.0.1",
        port: 0,
        certificate: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
        privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
      },
    };
    const withTrustedMetadata = (
      metadataOverrides: ReadonlyMap<string, TrustedPathMetadata> = new Map(),
      canonicalPathOverrides: ReadonlyMap<string, string> = new Map(),
    ) =>
      withTrustedDirectoryMetadata(
        fileSystem,
        canonicalTrustedRoot,
        modulePath,
        metadataOverrides,
        canonicalPathOverrides,
      );
    const load = (
      trustedRootPath: string,
      testFileSystem: FileSystem.FileSystem,
      onImport: () => void,
    ) =>
      loadPreviewGatewayAdaptersFromTrustedDirectory(
        {
          checkout,
          environment: { TIARA_PREVIEW_GATEWAY_ADAPTER_MODULE: modulePath },
          authority,
          importModule: () => {
            onImport();
            return Effect.succeed({ makePreviewGatewayRuntime: () => runtime });
          },
        },
        trustedRootPath,
        0,
      ).pipe(Effect.provideService(FileSystem.FileSystem, testFileSystem));
    let safeImportCalled = false;
    const safeResult = yield* Effect.exit(
      load(canonicalTrustedRoot, withTrustedMetadata(), () => (safeImportCalled = true)),
    );
    expect(safeResult._tag).toBe("Success");
    expect(safeImportCalled).toBe(true);

    let unsafeImportCalled = false;
    const unsafeResult = yield* Effect.exit(
      load(
        canonicalTrustedRoot,
        withTrustedMetadata(
          new Map<string, TrustedPathMetadata>([[unsafeAncestor, { uid: 0, mode: 0o775 }]]),
        ),
        () => (unsafeImportCalled = true),
      ),
    );
    expect(unsafeResult._tag).toBe("Failure");
    expect(unsafeImportCalled).toBe(false);

    let unownedImportCalled = false;
    const unownedResult = yield* Effect.exit(
      load(
        canonicalTrustedRoot,
        withTrustedMetadata(
          new Map<string, TrustedPathMetadata>([[unsafeAncestor, { uid: 1000, mode: 0o755 }]]),
        ),
        () => (unownedImportCalled = true),
      ),
    );
    expect(unownedResult._tag).toBe("Failure");
    expect(unownedImportCalled).toBe(false);

    let nonCanonicalImportCalled = false;
    const nonCanonicalResult = yield* Effect.exit(
      load(
        canonicalTrustedRoot,
        withTrustedMetadata(new Map(), new Map([[unsafeAncestor, canonicalTrustedRoot]])),
        () => (nonCanonicalImportCalled = true),
      ),
    );
    expect(nonCanonicalResult._tag).toBe("Failure");
    expect(nonCanonicalImportCalled).toBe(false);

    const trustedRootAlias = `${checkout}/trusted-root-alias`;
    yield* fileSystem.symlink(trustedRoot, trustedRootAlias);
    let symlinkedRootImportCalled = false;
    const symlinkedRootResult = yield* Effect.exit(
      load(trustedRootAlias, withTrustedMetadata(), () => (symlinkedRootImportCalled = true)),
    );
    expect(symlinkedRootResult._tag).toBe("Failure");
    expect(symlinkedRootImportCalled).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "retains only the safe typed loader reason when the production adapter is not configured",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const checkout = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "preview-gateway-unconfigured-checkout-",
      });
      const result = yield* loadPreviewGatewayAdapters({
        checkout,
        environment: {},
        authority: makeAuthority(),
      });

      expect(Option.isNone(result.runtime)).toBe(true);
      expect(result.unavailableReason).toEqual(
        Option.some("gateway-adapter-module-not-configured"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
