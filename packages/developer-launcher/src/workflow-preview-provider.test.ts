import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  connectedPreviewConfigSchema,
  type ConnectedWorkflowPreviewProviderApi,
} from "./connected-preview";
import { loadConfiguredWorkflowPreviewProvider } from "./workflow-preview-provider";
import { PreviewSessionSchema } from "./preview-sessions";

type WorkflowPreviewProviderRequest = Parameters<
  Extract<ConnectedWorkflowPreviewProviderApi, { readonly _tag: "Configured" }>["resolveActivation"]
>[0];

const providerRequest = (checkout: string): WorkflowPreviewProviderRequest => ({
  session: Schema.decodeUnknownSync(PreviewSessionSchema)({
    id: "preview-session",
    owner: "developer:alice",
    checkout,
    resources: {},
    manifests: {},
    requestedRevision: "revision-one",
    activeRevision: null,
    phase: "pending",
    generation: 1,
    leaseDeadline: 1,
    lastRenewedAt: 0,
    unsettled: 0,
    endedAt: null,
  }),
  ownerIdentity: "preview-owner-identity",
  config: Schema.decodeUnknownSync(connectedPreviewConfigSchema)({
    schemaVersion: 1,
    environment: "tiara-stack-dev",
    profile: "connected-preview-test",
    owner: "developer:alice",
    roles: [],
    identities: {
      sourceRevision: "revision-one",
      artifactDigests: {},
      deployedManifestDigest: "deployment-digest",
      catalogVersion: 1,
    },
    environmentFileInputs: [],
    groups: [],
    changes: [],
    credentialReferences: {},
    sharedExecution: "disabled",
  }),
  checkout,
});

it.live("loads the configured checkout-local workflow provider for CLI composition", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const checkout = process.cwd();
    const moduleName = `.workflow-preview-provider-${randomUUID()}.mjs`;
    const modulePath = path.join(checkout, moduleName);
    yield* fileSystem.writeFileString(
      modulePath,
      `export class Provider {\n  _tag = "Unavailable";\n  marker = "prototype-method-bound";\n  resolveActivation() { return this.marker; }\n}\nexport const makeWorkflowPreviewProvider = () => new Provider();\n`,
    );
    const provider = yield* loadConfiguredWorkflowPreviewProvider({
      checkout,
      environment: { TIARA_PREVIEW_WORKFLOW_PROVIDER_MODULE: moduleName },
    }).pipe(Effect.ensuring(fileSystem.remove(modulePath).pipe(Effect.ignore)));
    if (provider._tag !== "Configured") throw new Error("configured provider did not load");
    expect(typeof provider.resolveActivation).toBe("function");
    expect(provider.resolveActivation(providerRequest(checkout))).toBe("prototype-method-bound");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects configured workflow provider modules outside the checkout", () =>
  Effect.gen(function* () {
    const provider = yield* loadConfiguredWorkflowPreviewProvider({
      checkout: process.cwd(),
      environment: {
        TIARA_PREVIEW_WORKFLOW_PROVIDER_MODULE: "../outside-workflow-provider.mjs",
      },
    });
    expect(provider).toMatchObject({
      _tag: "Unavailable",
      reason: "provider-module-outside-checkout",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "canonicalizes symlinked checkouts without allowing provider module symlink escapes",
  () => {
    const suffix = randomUUID();
    const checkout = process.cwd();
    const checkoutAlias = path.join(tmpdir(), `workflow-preview-checkout-${suffix}`);
    const moduleName = `.workflow-preview-provider-${suffix}.mjs`;
    const modulePath = path.join(checkout, moduleName);
    const outsideModulePath = path.join(tmpdir(), `workflow-preview-provider-${suffix}.mjs`);
    const escapingModulePath = path.join(checkout, `.workflow-preview-provider-link-${suffix}.mjs`);
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const realCheckout = yield* fileSystem.realPath(checkout);
      yield* fileSystem.symlink(checkout, checkoutAlias);
      yield* fileSystem.writeFileString(
        modulePath,
        `export const makeWorkflowPreviewProvider = ({ checkout }) => ({\n  resolveActivation: () => checkout,\n});\n`,
      );
      const provider = yield* loadConfiguredWorkflowPreviewProvider({
        checkout: checkoutAlias,
        environment: { TIARA_PREVIEW_WORKFLOW_PROVIDER_MODULE: moduleName },
      });
      if (provider._tag !== "Configured")
        throw new Error("symlinked checkout provider did not load");
      expect(provider.resolveActivation(providerRequest(realCheckout))).toBe(realCheckout);

      yield* fileSystem.writeFileString(
        outsideModulePath,
        `export const makeWorkflowPreviewProvider = () => ({ resolveActivation: () => "escaped" });\n`,
      );
      yield* fileSystem.symlink(outsideModulePath, escapingModulePath);
      const escapedProvider = yield* loadConfiguredWorkflowPreviewProvider({
        checkout: checkoutAlias,
        environment: { TIARA_PREVIEW_WORKFLOW_PROVIDER_MODULE: path.basename(escapingModulePath) },
      });
      expect(escapedProvider).toMatchObject({
        _tag: "Unavailable",
        reason: "provider-module-outside-checkout",
      });
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* Effect.all(
            [
              fileSystem.remove(modulePath).pipe(Effect.ignore),
              fileSystem.remove(outsideModulePath).pipe(Effect.ignore),
              fileSystem.remove(checkoutAlias).pipe(Effect.ignore),
              fileSystem.remove(escapingModulePath).pipe(Effect.ignore),
            ],
            { concurrency: "unbounded" },
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    );
  },
);
