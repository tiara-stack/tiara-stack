import { it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Option, Schema } from "effect";
import { generateKeyPairSync, sign } from "node:crypto";
import { expect } from "vitest";
import { connectedPreviewConfigSchema } from "./connected-preview";
import { PreviewSessionSchema } from "./preview-sessions";
import {
  makePreviewWorkflowApiCredentialProvider,
  loadPreviewWorkflowApiTrustedAuthority,
  loadPreviewWorkflowApiTrustedAuthorityWithKey,
  PreviewWorkflowApiTrustedAuthority,
  verifyPreviewWorkflowApiAuthorityEnvelope,
  type PreviewWorkflowApiAuthorityPayload,
} from "./preview-workflow-api-authority";
import { previewWorkflowApiDatabaseEndpointIdentity } from "./preview-workflow-api-supervisor";
import { PreviewSharedWorkflowGroupSchema } from "./preview-shared-workflow";
import {
  previewGatewayRuntimeLayerForArguments,
  previewWorkflowApiAuthorityLayerForArguments,
} from "./cli";
import { parseCommand } from "./commands";
import { PreviewGatewayRuntime } from "./preview-gateway-runtime";

const postgresEndpoint = "postgres://workflow.dev.tiara-stack.moe/tiara";
const workflowApiEndpoint = "https://workflow-api.dev.tiara-stack.moe";
const sha256 = (character: string) => `sha256:${character.repeat(64)}`;

const authorityPayload = (): PreviewWorkflowApiAuthorityPayload => {
  const databaseEndpointIdentity = previewWorkflowApiDatabaseEndpointIdentity(postgresEndpoint);
  if (databaseEndpointIdentity === undefined) throw new Error("fixture endpoint is invalid");
  const issuedAt = Date.now();
  return {
    schemaVersion: 1,
    issuedAt,
    expiresAt: issuedAt + 60_000,
    gatewayDomain: "dev.example.test",
    workflowExecution: {
      workflowApiEndpoint,
      databaseEndpoint: postgresEndpoint,
      databaseEndpointIdentity,
      stateIdentity: "workflow-state-dev",
      deployedManifestDigest: sha256("a"),
      schemaArtifactDigest: sha256("b"),
      workflowContractCatalogDigest: sha256("c"),
      authIssuer: "https://auth.dev.tiara-stack.moe",
      credentialEnvironmentBindings: [
        {
          environmentKey: "POSTGRES_URL",
          referenceName: "workflow-database",
          environmentName: "TIARA_PREVIEW_WORKFLOW_API_POSTGRES_URL",
        },
        {
          environmentKey: "SHEET_AUTH_OAUTH_CLIENT_ID",
          referenceName: "internal-oauth-client",
          environmentName: "TIARA_PREVIEW_WORKFLOW_API_OAUTH_CLIENT_ID",
        },
        {
          environmentKey: "SHEET_AUTH_OAUTH_CLIENT_SECRET",
          referenceName: "internal-oauth-client",
          environmentName: "TIARA_PREVIEW_WORKFLOW_API_OAUTH_CLIENT_SECRET",
        },
        {
          environmentKey: "SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS",
          referenceName: "workload-identity",
          environmentName: "TIARA_PREVIEW_WORKFLOW_API_DELEGATION_CLIENT_IDS",
        },
        {
          environmentKey: "SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID",
          referenceName: "workload-identity",
          environmentName: "TIARA_PREVIEW_WORKFLOW_API_BOT_CLIENT_ID",
        },
      ],
    },
    runtimeArtifactAttestations: { schemaVersion: 1, packages: {} },
  };
};

const signedEnvelope = (payload: PreviewWorkflowApiAuthorityPayload, privateKey: string) => {
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  return {
    algorithm: "Ed25519",
    payload: payloadBytes.toString("utf8"),
    signature: sign(null, payloadBytes, privateKey).toString("base64"),
  };
};

const credentialInput = () => {
  const databaseEndpointIdentity = previewWorkflowApiDatabaseEndpointIdentity(postgresEndpoint);
  if (databaseEndpointIdentity === undefined) throw new Error("fixture endpoint is invalid");
  const session = Schema.decodeUnknownSync(PreviewSessionSchema)({
    id: "11111111-1111-4111-8111-111111111111",
    owner: "developer:test",
    checkout: "/workspace/checkout",
    resources: {},
    manifests: { "sheet-workflows-api": "manifest" },
    requestedRevision: "revision-one",
    activeRevision: null,
    phase: "starting",
    generation: 4,
    leaseDeadline: 1_800_000_060_000,
    lastRenewedAt: 1_800_000_000_000,
    unsettled: 0,
    endedAt: null,
  });
  const config = Schema.decodeUnknownSync(connectedPreviewConfigSchema)({
    schemaVersion: 1,
    environment: "tiara-stack-dev",
    profile: "producer-only-test",
    owner: "developer:test",
    roles: ["sheet-workflows-api"],
    hostListeners: [
      { role: "sheet-workflows-api", host: "127.0.0.1", port: 48080, processId: "workflow-api" },
    ],
    identities: {
      sourceRevision: "revision-one",
      artifactDigests: { "sheet-workflows-api": sha256("d") },
      deployedManifestDigest: sha256("a"),
      workflowContractCatalogDigest: sha256("c"),
      schemaArtifactDigest: sha256("b"),
      catalogVersion: 1,
    },
    environmentFileInputs: [],
    groups: [
      {
        id: "workflow-execution",
        ownership: "reused",
        endpoint: workflowApiEndpoint,
        stateIdentity: "workflow-state-dev",
        deployedManifestDigest: sha256("a"),
        databaseEndpointIdentity,
        schemaArtifactDigest: sha256("b"),
        workflowContractCatalogDigest: sha256("c"),
      },
    ],
    changes: [],
    credentialReferences: {
      "sheet-workflows-api": {
        "workflow-database": "secret://tiara-stack-dev/sheet-workflows-api/workflow-database",
        "internal-oauth-client":
          "secret://tiara-stack-dev/sheet-workflows-api/internal-oauth-client",
        "workload-identity": "secret://tiara-stack-dev/sheet-workflows-api/workload-identity",
      },
    },
    sharedExecution: "producer-only",
  });
  const group = Schema.decodeUnknownSync(PreviewSharedWorkflowGroupSchema)({
    sessionId: session.id,
    generation: session.generation,
    groupId: "workflow-execution",
    endpoint: workflowApiEndpoint,
    databaseEndpointIdentity,
    stateIdentity: "workflow-state-dev",
    deployedManifestDigest: sha256("a"),
    schemaArtifactDigest: sha256("b"),
    apiArtifactDigest: sha256("d"),
    workflowContractCatalogDigest: sha256("c"),
  });
  const references = config.credentialReferences["sheet-workflows-api"];
  if (references === undefined) throw new Error("fixture credentials are missing");
  return { session, config, group };
};

it("verifies signed external authority bytes and rejects tampering, stale records, and wrong keys", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload = authorityPayload();
  const envelope = signedEnvelope(
    payload,
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  expect(
    verifyPreviewWorkflowApiAuthorityEnvelope(envelope, publicKeyPem, payload.issuedAt),
  ).toMatchObject({ workflowExecution: { stateIdentity: "workflow-state-dev" } });
  expect(() =>
    verifyPreviewWorkflowApiAuthorityEnvelope(
      { ...envelope, payload: envelope.payload.replace("workflow-state-dev", "attacker-state") },
      publicKeyPem,
      payload.issuedAt,
    ),
  ).toThrow();
  expect(() =>
    verifyPreviewWorkflowApiAuthorityEnvelope(envelope, publicKeyPem, payload.expiresAt + 1),
  ).toThrow();

  const { publicKey: otherPublicKey } = generateKeyPairSync("ed25519");
  expect(() =>
    verifyPreviewWorkflowApiAuthorityEnvelope(
      envelope,
      otherPublicKey.export({ type: "spki", format: "pem" }).toString(),
      payload.issuedAt,
    ),
  ).toThrow();

  const mismatchedCredentialAuthority = {
    ...payload,
    workflowExecution: {
      ...payload.workflowExecution,
      credentialEnvironmentBindings: payload.workflowExecution.credentialEnvironmentBindings.map(
        (binding) =>
          binding.environmentKey === "POSTGRES_URL"
            ? { ...binding, referenceName: "internal-oauth-client" }
            : binding,
      ),
    },
  };
  expect(() =>
    verifyPreviewWorkflowApiAuthorityEnvelope(
      signedEnvelope(
        mismatchedCredentialAuthority,
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      ),
      publicKeyPem,
      payload.issuedAt,
    ),
  ).toThrow();
});

it.effect(
  "binds selected-group identity before resolving scoped credential environment values",
  () =>
    Effect.gen(function* () {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const payload = authorityPayload();
      const envelope = signedEnvelope(
        payload,
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      );
      const authority = verifyPreviewWorkflowApiAuthorityEnvelope(
        envelope,
        publicKey.export({ type: "spki", format: "pem" }).toString(),
        payload.issuedAt,
      );
      const { session, config, group } = credentialInput();
      const references = config.credentialReferences["sheet-workflows-api"];
      if (references === undefined) throw new Error("fixture credentials are missing");
      const values: Record<string, string | undefined> = {
        TIARA_PREVIEW_WORKFLOW_API_POSTGRES_URL:
          "postgres://preview:secret@workflow.dev.tiara-stack.moe/tiara?sslmode=verify-full",
        TIARA_PREVIEW_WORKFLOW_API_OAUTH_CLIENT_ID: "preview-workflow-api",
        TIARA_PREVIEW_WORKFLOW_API_OAUTH_CLIENT_SECRET: "test-only-secret",
        TIARA_PREVIEW_WORKFLOW_API_DELEGATION_CLIENT_IDS: "preview-workflow-api",
        TIARA_PREVIEW_WORKFLOW_API_BOT_CLIENT_ID: "preview-bot-gateway",
      };
      const reads: string[] = [];
      const provider = makePreviewWorkflowApiCredentialProvider({
        authority,
        readEnvironment: (name) => {
          reads.push(name);
          return values[name];
        },
      });
      const target = yield* provider.resolveDatabaseTarget({ session, config, group });
      const credentials = yield* provider.resolve({
        session,
        config,
        references,
        databaseTarget: target,
      });
      expect(credentials.authIssuer).toBe("https://auth.dev.tiara-stack.moe");
      expect(credentials.environment).toEqual({
        POSTGRES_URL: values.TIARA_PREVIEW_WORKFLOW_API_POSTGRES_URL,
        SHEET_AUTH_OAUTH_CLIENT_ID: "preview-workflow-api",
        SHEET_AUTH_OAUTH_CLIENT_SECRET: "test-only-secret",
        SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS: "preview-workflow-api",
        SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "preview-bot-gateway",
      });
      const readsAfterResolution = reads.length;
      const mismatchedGroup = { ...group, stateIdentity: "another-state" };
      const untrustedGroup = yield* Effect.exit(
        provider.resolveDatabaseTarget({ session, config, group: mismatchedGroup }),
      );
      expect(untrustedGroup._tag).toBe("Failure");
      expect(reads).toHaveLength(readsAfterResolution);

      const mismatchedTarget = {
        ...target,
        endpoint: "postgres://other.dev.tiara-stack.moe/tiara",
      };
      const beforeMismatch = reads.length;
      const mismatch = yield* Effect.exit(
        provider.resolve({
          session,
          config,
          references,
          databaseTarget: mismatchedTarget,
        }),
      );
      expect(mismatch._tag).toBe("Failure");
      expect(reads).toHaveLength(beforeMismatch);
    }),
);

it.effect("rechecks signed authority expiry before target use and between credential reads", () =>
  Effect.gen(function* () {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const payload = authorityPayload();
    const authority = verifyPreviewWorkflowApiAuthorityEnvelope(
      signedEnvelope(payload, privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
      publicKey.export({ type: "spki", format: "pem" }).toString(),
      payload.issuedAt,
    );
    const { session, config, group } = credentialInput();
    const references = config.credentialReferences["sheet-workflows-api"];
    if (references === undefined) throw new Error("fixture credentials are missing");
    const values: Record<string, string | undefined> = {
      TIARA_PREVIEW_WORKFLOW_API_POSTGRES_URL:
        "postgres://preview:secret@workflow.dev.tiara-stack.moe/tiara?sslmode=verify-full",
      TIARA_PREVIEW_WORKFLOW_API_OAUTH_CLIENT_ID: "preview-workflow-api",
      TIARA_PREVIEW_WORKFLOW_API_OAUTH_CLIENT_SECRET: "test-only-secret",
      TIARA_PREVIEW_WORKFLOW_API_DELEGATION_CLIENT_IDS: "preview-workflow-api",
      TIARA_PREVIEW_WORKFLOW_API_BOT_CLIENT_ID: "preview-bot-gateway",
    };
    const reads: string[] = [];
    let now = payload.issuedAt;
    let expireDuringNextRead = false;
    const provider = makePreviewWorkflowApiCredentialProvider({
      authority,
      now: () => now,
      readEnvironment: (name) => {
        reads.push(name);
        const value = values[name];
        if (expireDuringNextRead) now = payload.expiresAt;
        return value;
      },
    });
    const databaseTarget = yield* provider.resolveDatabaseTarget({ session, config, group });
    expireDuringNextRead = true;
    const credentials = yield* Effect.exit(
      provider.resolve({ session, config, references, databaseTarget }),
    );
    expect(credentials._tag).toBe("Failure");
    expect(reads).toEqual(["TIARA_PREVIEW_WORKFLOW_API_POSTGRES_URL"]);

    const readsAfterExpiry = reads.length;
    const expiredTarget = yield* Effect.exit(
      provider.resolveDatabaseTarget({ session, config, group }),
    );
    const expiredCredentials = yield* Effect.exit(
      provider.resolve({ session, config, references, databaseTarget }),
    );
    expect(expiredTarget._tag).toBe("Failure");
    expect(expiredCredentials._tag).toBe("Failure");
    expect(reads).toHaveLength(readsAfterExpiry);
    if (provider.assertCurrent === undefined) throw new Error("expiry guard is missing");
    const expiredAssertion = yield* Effect.exit(provider.assertCurrent());
    expect(expiredAssertion._tag).toBe("Failure");
  }),
);

it.live(
  "loads a signed runtime authority only from explicit files outside the mutable checkout",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const checkout = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "preview-api-checkout-" }),
        );
        const externalConfig = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "preview-api-authority-" }),
        );
        const { publicKey, privateKey } = generateKeyPairSync("ed25519");
        const payload = authorityPayload();
        const envelope = signedEnvelope(
          payload,
          privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        );
        const keyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
        const externalBundlePath = `${externalConfig}/authority.json`;
        yield* fileSystem.writeFileString(externalBundlePath, JSON.stringify(envelope));

        const loadWithInjectedTestKey = (bundlePath: string) =>
          loadPreviewWorkflowApiTrustedAuthorityWithKey(
            {
              checkout,
              environment: { TIARA_PREVIEW_WORKFLOW_API_AUTHORITY_FILE: bundlePath },
              now: payload.issuedAt,
            },
            keyPem,
          );
        const loaded = yield* loadWithInjectedTestKey(externalBundlePath);
        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded))
          expect(loaded.value.workflowExecution.databaseEndpointIdentity).toBe(
            payload.workflowExecution.databaseEndpointIdentity,
          );

        const startLayer = previewWorkflowApiAuthorityLayerForArguments(
          ["preview", "start", "--config", "./preview.json"],
          {
            checkout,
            environment: { TIARA_PREVIEW_WORKFLOW_API_AUTHORITY_FILE: externalBundlePath },
          },
          keyPem,
        );
        expect(parseCommand(["preview", "start", "--config", "./preview.json"])).toMatchObject({
          kind: "preview",
          action: "start",
        });
        const authorityFromCli = yield* Effect.gen(function* () {
          return yield* PreviewWorkflowApiTrustedAuthority;
        }).pipe(Effect.provide(startLayer));
        expect(Option.isSome(authorityFromCli), JSON.stringify(authorityFromCli)).toBe(true);

        const checkoutBundlePath = `${checkout}/authority.json`;
        yield* fileSystem.writeFileString(checkoutBundlePath, JSON.stringify(envelope));
        const rejectedCheckoutPolicy = yield* loadWithInjectedTestKey(checkoutBundlePath);
        expect(Option.isNone(rejectedCheckoutPolicy)).toBe(true);
        const absent = yield* loadWithInjectedTestKey("");
        expect(Option.isNone(absent)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects a trusted signing key whose parent directory is writable by another user", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const checkout = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "preview-key-checkout-" }),
      );
      const authorityDirectory = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "preview-key-authority-" }),
      );
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const payload = authorityPayload();
      const envelopePath = `${authorityDirectory}/authority.json`;
      yield* fileSystem.writeFileString(
        envelopePath,
        JSON.stringify(
          signedEnvelope(payload, privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
        ),
      );
      const keyPath = "/etc/tiara-stack/preview-development/workflow-api-authority.pub";
      const keyDirectory = "/etc/tiara-stack/preview-development";
      const keyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const fileInfo = yield* fileSystem.stat(envelopePath);
      const directoryInfo = yield* fileSystem.stat(authorityDirectory);
      let parentStatCalls = 0;
      const fileSystemForDirectory = (uid: number, mode: number) =>
        ({
          ...fileSystem,
          realPath: (candidate: string) =>
            candidate === keyPath || candidate === keyDirectory
              ? Effect.succeed(candidate)
              : fileSystem.realPath(candidate),
          stat: (candidate: string) => {
            if (candidate === keyPath) {
              const metadata = {
                ...fileInfo,
                type: "File" as const,
                uid: Option.some(0),
                mode: 0o100644,
              };
              return Effect.succeed(metadata);
            }
            if (candidate === keyDirectory) {
              parentStatCalls += 1;
              const metadata = {
                ...directoryInfo,
                type: "Directory" as const,
                uid: Option.some(uid),
                mode,
              };
              return Effect.succeed(metadata);
            }
            return fileSystem.stat(candidate);
          },
          readFileString: (candidate: string) =>
            candidate === keyPath ? Effect.succeed(keyPem) : fileSystem.readFileString(candidate),
        }) satisfies FileSystem.FileSystem;
      const input = {
        checkout,
        environment: { TIARA_PREVIEW_WORKFLOW_API_AUTHORITY_FILE: envelopePath },
        now: payload.issuedAt,
      };
      const safeAuthority = yield* loadPreviewWorkflowApiTrustedAuthority(input).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystemForDirectory(0, 0o755)),
      );
      const unsafeAuthority = yield* loadPreviewWorkflowApiTrustedAuthority(input).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystemForDirectory(1000, 0o777)),
      );

      expect(parentStatCalls).toBe(2);
      expect(Option.isSome(safeAuthority)).toBe(true);
      expect(Option.isNone(unsafeAuthority)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "composes the CLI session action with signed authority before loading gateway runtime",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const checkout = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "preview-cli-checkout-" }),
        );
        const authorityDirectory = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "preview-cli-authority-" }),
        );
        const { publicKey, privateKey } = generateKeyPairSync("ed25519");
        const payload = authorityPayload();
        const envelope = signedEnvelope(
          payload,
          privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        );
        const authorityPath = `${authorityDirectory}/authority.json`;
        yield* fileSystem.writeFileString(authorityPath, JSON.stringify(envelope));
        const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
        let loaderCalls = 0;
        let loadedAuthority: PreviewWorkflowApiAuthorityPayload | undefined;
        const layer = previewGatewayRuntimeLayerForArguments(
          ["preview", "start", "--config", "./preview.json"],
          {
            checkout,
            environment: { TIARA_PREVIEW_WORKFLOW_API_AUTHORITY_FILE: authorityPath },
          },
          {
            trustedPublicKeyPem: publicKeyPem,
            loadRuntime: ({ authority }) => {
              loaderCalls += 1;
              loadedAuthority = authority;
              return Effect.succeed({
                runtime: Option.none(),
                unavailableReason: Option.none(),
              });
            },
          },
        );
        const runtime = yield* Effect.gen(function* () {
          return yield* PreviewGatewayRuntime;
        }).pipe(Effect.provide(layer));
        expect(Option.isNone(runtime.runtime)).toBe(true);
        expect(Option.isNone(runtime.unavailableReason)).toBe(true);
        expect(loaderCalls).toBe(1);
        expect(loadedAuthority?.workflowExecution.databaseEndpointIdentity).toBe(
          payload.workflowExecution.databaseEndpointIdentity,
        );

        const checkoutAuthorityPath = `${checkout}/authority.json`;
        yield* fileSystem.writeFileString(checkoutAuthorityPath, JSON.stringify(envelope));
        const rejectedLayer = previewGatewayRuntimeLayerForArguments(
          ["preview", "start", "--config", "./preview.json"],
          {
            checkout,
            environment: { TIARA_PREVIEW_WORKFLOW_API_AUTHORITY_FILE: checkoutAuthorityPath },
          },
          {
            trustedPublicKeyPem: publicKeyPem,
            loadRuntime: () => {
              loaderCalls += 1;
              return Effect.succeed({
                runtime: Option.none(),
                unavailableReason: Option.none(),
              });
            },
          },
        );
        const rejectedRuntime = yield* Effect.gen(function* () {
          return yield* PreviewGatewayRuntime;
        }).pipe(Effect.provide(rejectedLayer));
        expect(Option.isNone(rejectedRuntime.runtime)).toBe(true);
        expect(Option.isNone(rejectedRuntime.unavailableReason)).toBe(true);
        expect(loaderCalls).toBe(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
