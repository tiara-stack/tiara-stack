import { Effect, FileSystem, Predicate, Schema } from "effect";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ConnectedWorkflowPreviewProviderApi } from "./connected-preview";

const providerModuleEnvironmentName = "TIARA_PREVIEW_WORKFLOW_PROVIDER_MODULE";

class WorkflowPreviewProviderConfigurationError extends Schema.TaggedErrorClass<WorkflowPreviewProviderConfigurationError>()(
  "WorkflowPreviewProviderConfigurationError",
  { reason: Schema.String },
) {}

type WorkflowPreviewProviderModuleFactory = (input: { readonly checkout: string }) => unknown;
type WorkflowPreviewProviderResolver = {
  readonly resolveActivation: Extract<
    ConnectedWorkflowPreviewProviderApi,
    { readonly _tag: "Configured" }
  >["resolveActivation"];
};

const isProviderModule = (
  value: unknown,
): value is { readonly makeWorkflowPreviewProvider: WorkflowPreviewProviderModuleFactory } =>
  Predicate.isObject(value) &&
  Predicate.hasProperty("makeWorkflowPreviewProvider")(value) &&
  Predicate.isFunction(value.makeWorkflowPreviewProvider);

const isCheckoutChild = (checkout: string, candidate: string) => {
  const relativePath = path.relative(checkout, candidate);
  return Predicate.and(
    (value: string) => value.length > 0,
    Predicate.and(
      (value: string) => value !== "..",
      Predicate.and(
        (value: string) => !value.startsWith(`..${path.sep}`),
        (value: string) => !path.isAbsolute(value),
      ),
    ),
  )(relativePath);
};

const requireCheckoutChild = (checkout: string, candidate: string) =>
  isCheckoutChild(checkout, candidate)
    ? Effect.void
    : Effect.fail(
        new WorkflowPreviewProviderConfigurationError({
          reason: "provider-module-outside-checkout",
        }),
      );

/** Load only an explicitly configured provider module within the development checkout. */
const resolveProviderModulePath = (
  checkoutInput: string,
  configuredPath: string,
  fileSystem: FileSystem.FileSystem,
) =>
  Effect.gen(function* () {
    if (path.isAbsolute(configuredPath))
      return yield* Effect.fail(
        new WorkflowPreviewProviderConfigurationError({
          reason: "provider-module-must-be-checkout-relative",
        }),
      );

    const unresolvedCheckout = yield* Effect.try({
      try: () => path.resolve(checkoutInput),
      catch: () =>
        new WorkflowPreviewProviderConfigurationError({ reason: "checkout-path-invalid" }),
    });
    const checkout = yield* fileSystem.realPath(unresolvedCheckout).pipe(
      Effect.mapError(
        () =>
          new WorkflowPreviewProviderConfigurationError({
            reason: "checkout-path-invalid",
          }),
      ),
    );
    const requestedModulePath = path.resolve(checkout, configuredPath);
    yield* requireCheckoutChild(checkout, requestedModulePath);
    const modulePath = yield* fileSystem.realPath(requestedModulePath).pipe(
      Effect.mapError(
        () =>
          new WorkflowPreviewProviderConfigurationError({
            reason: "provider-module-unavailable",
          }),
      ),
    );
    yield* requireCheckoutChild(checkout, modulePath);
    return { checkout, modulePath };
  });

const importProviderModule = (modulePath: string) =>
  Effect.tryPromise({
    try: () => import(pathToFileURL(modulePath).href),
    catch: () =>
      new WorkflowPreviewProviderConfigurationError({ reason: "provider-module-load-failed" }),
  }).pipe(
    Effect.flatMap((moduleValue: unknown) =>
      isProviderModule(moduleValue)
        ? Effect.succeed(moduleValue)
        : Effect.fail(
            new WorkflowPreviewProviderConfigurationError({
              reason: "provider-module-factory-missing",
            }),
          ),
    ),
  );

const initializeProvider = (
  moduleValue: { readonly makeWorkflowPreviewProvider: WorkflowPreviewProviderModuleFactory },
  checkout: string,
) =>
  Effect.tryPromise({
    try: async () => await moduleValue.makeWorkflowPreviewProvider({ checkout }),
    catch: () =>
      new WorkflowPreviewProviderConfigurationError({
        reason: "provider-module-initialization-failed",
      }),
  }).pipe(
    Effect.flatMap((providerValue: unknown) =>
      Effect.try({
        try: () => {
          if (!Predicate.isObject(providerValue)) throw new Error("provider-api-invalid");
          const resolveActivation: unknown = Reflect.get(providerValue, "resolveActivation");
          if (!Predicate.isFunction(resolveActivation)) throw new Error("provider-api-invalid");
          return {
            _tag: "Configured" as const,
            resolveActivation: resolveActivation.bind(providerValue),
          } satisfies WorkflowPreviewProviderResolver & { readonly _tag: "Configured" };
        },
        catch: () =>
          new WorkflowPreviewProviderConfigurationError({ reason: "provider-api-invalid" }),
      }),
    ),
  );

const loadConfiguredWorkflowPreviewProviderOrFail = (input: {
  readonly checkout: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<
  ConnectedWorkflowPreviewProviderApi,
  WorkflowPreviewProviderConfigurationError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const configuredPath = input.environment[providerModuleEnvironmentName];
    if (configuredPath === undefined || configuredPath.trim().length === 0)
      return yield* Effect.fail(
        new WorkflowPreviewProviderConfigurationError({ reason: "provider-module-not-configured" }),
      );
    const fileSystem = yield* FileSystem.FileSystem;
    const resolved = yield* resolveProviderModulePath(input.checkout, configuredPath, fileSystem);
    const providerModule = yield* importProviderModule(resolved.modulePath);
    return yield* initializeProvider(providerModule, resolved.checkout);
  });

export const loadConfiguredWorkflowPreviewProvider = (input: {
  readonly checkout: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<ConnectedWorkflowPreviewProviderApi, never, FileSystem.FileSystem> =>
  loadConfiguredWorkflowPreviewProviderOrFail(input).pipe(
    Effect.catch((error) => Effect.succeed({ _tag: "Unavailable" as const, reason: error.reason })),
  );
