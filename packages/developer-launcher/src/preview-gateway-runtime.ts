import { Context, Effect, FileSystem, Option, Predicate, Result, Schema } from "effect";
import type { PreviewGatewayAdapters } from "./preview-gateway";
import type { PreviewWorkflowApiAuthorityPayload } from "./preview-workflow-api-authority";
import path from "node:path";
import { pathToFileURL } from "node:url";

const gatewayAdapterModuleEnvironmentName = "TIARA_PREVIEW_GATEWAY_ADAPTER_MODULE";
const gatewayAdapterTrustedInstallRoot = "/etc/tiara-stack/preview-development";
const previewGatewayRuntimeFailureReasonSchema = Schema.Literals([
  "gateway-adapter-module-not-configured",
  "gateway-adapter-module-path-invalid",
  "gateway-adapter-module-unavailable",
  "gateway-adapter-module-factory-missing",
  "gateway-adapter-module-failed",
  "gateway-adapter-api-invalid",
]);
export type PreviewGatewayRuntimeFailureReason =
  typeof previewGatewayRuntimeFailureReasonSchema.Type;

class PreviewGatewayRuntimeError extends Schema.TaggedErrorClass<PreviewGatewayRuntimeError>()(
  "PreviewGatewayRuntimeError",
  {
    reason: previewGatewayRuntimeFailureReasonSchema,
  },
) {}

type GatewayAdapterModuleFactory = (input: {
  readonly authority: PreviewWorkflowApiAuthorityPayload;
  /** Only explicitly prefixed gateway transport inputs are passed to the installed adapter. */
  readonly environment: Readonly<Record<string, string>>;
}) => unknown;

export interface PreviewGatewayRuntimeConfig {
  readonly domain: string;
  readonly adapters: PreviewGatewayAdapters;
  readonly https: {
    readonly host: string;
    /** Zero asks the OS to allocate this session listener's unique TCP port. */
    readonly port: number;
    readonly certificate: string;
    readonly privateKey: string;
  };
}

export interface PreviewGatewayRuntimeLoadResult {
  readonly runtime: Option.Option<PreviewGatewayRuntimeConfig>;
  readonly unavailableReason: Option.Option<PreviewGatewayRuntimeFailureReason>;
}

export class PreviewGatewayRuntime extends Context.Service<
  PreviewGatewayRuntime,
  PreviewGatewayRuntimeLoadResult
>()("developer-launcher/PreviewGatewayRuntime") {}

type GatewayAdapterModule = {
  readonly makePreviewGatewayRuntime: GatewayAdapterModuleFactory;
};

const isGatewayAdapterModule = (value: unknown): value is GatewayAdapterModule => {
  if (!Predicate.isObject(value)) return false;
  const factory: unknown = Reflect.get(value, "makePreviewGatewayRuntime");
  return Predicate.isFunction(factory);
};

const isPreviewGatewayAdapters = (value: unknown): value is PreviewGatewayAdapters => {
  if (!Predicate.isObject(value)) return false;
  const checkSetup: unknown = Reflect.get(value, "checkSetup");
  const authenticate: unknown = Reflect.get(value, "authenticate");
  const connect: unknown = Reflect.get(value, "connect");
  const connectChannel: unknown = Reflect.get(value, "connectChannel");
  const recoverChannel: unknown = Reflect.get(value, "recoverChannel");
  if (
    !Effect.isEffect(checkSetup) ||
    !Predicate.isFunction(authenticate) ||
    !Predicate.isFunction(connect) ||
    !Predicate.isFunction(connectChannel) ||
    !Predicate.isFunction(recoverChannel)
  )
    return false;
  const dependency: unknown = Reflect.get(value, "applicationDependency");
  if (dependency === undefined) return true;
  if (!Predicate.isObject(dependency)) return false;
  return ["checkTarget", "request", "socket"].every((name) =>
    Predicate.isFunction(Reflect.get(dependency, name)),
  );
};

const isValidGatewayCertificatePair = (certificate: unknown, privateKey: unknown) =>
  typeof certificate === "string" &&
  /-----BEGIN CERTIFICATE-----/.test(certificate) &&
  typeof privateKey === "string" &&
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey);

const isPreviewGatewayHttpsOptions = (value: unknown) => {
  if (!Predicate.isObject(value)) return false;
  const host: unknown = Reflect.get(value, "host");
  const port: unknown = Reflect.get(value, "port");
  const certificate: unknown = Reflect.get(value, "certificate");
  const privateKey: unknown = Reflect.get(value, "privateKey");
  return (
    typeof host === "string" &&
    host.trim().length > 0 &&
    port === 0 &&
    isValidGatewayCertificatePair(certificate, privateKey)
  );
};

const isPreviewGatewayRuntime = (
  value: unknown,
  domain: string,
): value is Omit<PreviewGatewayRuntimeConfig, "domain"> => {
  if (!Predicate.isObject(value)) return false;
  const adapters: unknown = Reflect.get(value, "adapters");
  const https: unknown = Reflect.get(value, "https");
  return (
    domain.length > 0 && isPreviewGatewayAdapters(adapters) && isPreviewGatewayHttpsOptions(https)
  );
};

const trustedInstallRootAncestors = (installRoot: string) => {
  const ancestors: string[] = [];
  let ancestor = path.dirname(installRoot);
  while (true) {
    ancestors.push(ancestor);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return ancestors;
    ancestor = parent;
  }
};

type TrustedInstallRootAncestor = {
  readonly path: string;
  readonly canonicalPath: string;
  readonly info: FileSystem.File.Info;
};

const isCheckoutChild = (checkout: string, candidate: string) => {
  const relativePath = path.relative(checkout, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
};

const configuredGatewayModulePath = (configuredPath: string | undefined) => {
  if (configuredPath === undefined || configuredPath.trim().length === 0)
    return {
      error: new PreviewGatewayRuntimeError({ reason: "gateway-adapter-module-not-configured" }),
    } as const;
  if (!path.isAbsolute(configuredPath))
    return {
      error: new PreviewGatewayRuntimeError({ reason: "gateway-adapter-module-path-invalid" }),
    } as const;
  return { path: path.resolve(configuredPath) } as const;
};

const resolveGatewayModuleEvidence = (
  input: {
    readonly checkout: string;
    readonly requestedPath: string;
    readonly ownerUid: number | undefined;
  },
  fileSystem: FileSystem.FileSystem,
  trustedInstallRoot: string,
) =>
  Effect.gen(function* () {
    const canonicalInstallRoot = yield* fileSystem
      .realPath(path.resolve(trustedInstallRoot))
      .pipe(
        Effect.mapError(
          () => new PreviewGatewayRuntimeError({ reason: "gateway-adapter-module-unavailable" }),
        ),
      );
    const installRootInfo = yield* fileSystem
      .stat(canonicalInstallRoot)
      .pipe(
        Effect.mapError(
          () => new PreviewGatewayRuntimeError({ reason: "gateway-adapter-module-unavailable" }),
        ),
      );
    const installRootAncestorInfo: readonly TrustedInstallRootAncestor[] =
      input.ownerUid === undefined
        ? []
        : yield* Effect.forEach(
            trustedInstallRootAncestors(canonicalInstallRoot),
            (ancestor) =>
              Effect.gen(function* () {
                const canonicalPath = yield* fileSystem.realPath(ancestor).pipe(
                  Effect.mapError(
                    () =>
                      new PreviewGatewayRuntimeError({
                        reason: "gateway-adapter-module-path-invalid",
                      }),
                  ),
                );
                const info = yield* fileSystem.stat(canonicalPath).pipe(
                  Effect.mapError(
                    () =>
                      new PreviewGatewayRuntimeError({
                        reason: "gateway-adapter-module-path-invalid",
                      }),
                  ),
                );
                return { path: ancestor, canonicalPath, info };
              }),
            { concurrency: 1 },
          );
    const canonicalCheckout = yield* fileSystem
      .realPath(path.resolve(input.checkout))
      .pipe(
        Effect.mapError(
          () => new PreviewGatewayRuntimeError({ reason: "gateway-adapter-module-path-invalid" }),
        ),
      );
    const canonicalModulePath = yield* fileSystem
      .realPath(input.requestedPath)
      .pipe(
        Effect.mapError(
          () => new PreviewGatewayRuntimeError({ reason: "gateway-adapter-module-unavailable" }),
        ),
      );
    const status = yield* fileSystem
      .stat(canonicalModulePath)
      .pipe(
        Effect.mapError(
          () => new PreviewGatewayRuntimeError({ reason: "gateway-adapter-module-unavailable" }),
        ),
      );
    return {
      canonicalInstallRoot,
      installRootInfo,
      installRootAncestorInfo,
      canonicalCheckout,
      canonicalModulePath,
      moduleInfo: status,
    };
  });

const ownerMatchesTrustedUid = (uid: Option.Option<number>, ownerUid: number | undefined) =>
  ownerUid === undefined || (Option.isSome(uid) && uid.value === ownerUid);

const isTrustedInstallDirectoryInfo = (info: FileSystem.File.Info, ownerUid: number | undefined) =>
  info.type === "Directory" &&
  ownerMatchesTrustedUid(info.uid, ownerUid) &&
  (info.mode & 0o022) === 0;

const isTrustedInstallDirectory = (
  canonicalInstallRoot: string,
  installRootInfo: FileSystem.File.Info,
  installRootAncestorInfo: readonly TrustedInstallRootAncestor[],
  trustedInstallRoot: string,
  ownerUid: number | undefined,
) =>
  canonicalInstallRoot === path.resolve(trustedInstallRoot) &&
  isTrustedInstallDirectoryInfo(installRootInfo, ownerUid) &&
  (ownerUid === undefined ||
    installRootAncestorInfo.every(
      ({ path: ancestorPath, canonicalPath, info }) =>
        canonicalPath === ancestorPath && isTrustedInstallDirectoryInfo(info, ownerUid),
    ));

const isTrustedAdapterModuleFile = (input: {
  readonly requestedPath: string;
  readonly canonicalCheckout: string;
  readonly canonicalInstallRoot: string;
  readonly canonicalModulePath: string;
  readonly moduleInfo: FileSystem.File.Info;
  readonly ownerUid: number | undefined;
}) => {
  const pathWithinInstallRoot = path.relative(
    input.canonicalInstallRoot,
    input.canonicalModulePath,
  );
  if (
    input.requestedPath !== input.canonicalModulePath ||
    pathWithinInstallRoot === "" ||
    pathWithinInstallRoot.includes(path.sep) ||
    isCheckoutChild(input.canonicalCheckout, input.canonicalModulePath) ||
    input.moduleInfo.type !== "File" ||
    !ownerMatchesTrustedUid(input.moduleInfo.uid, input.ownerUid) ||
    (input.moduleInfo.mode & 0o022) !== 0 ||
    input.moduleInfo.size > 4 * 1024 * 1024
  )
    return false;
  return true;
};

const resolveExternalModulePath = (
  input: { readonly checkout: string; readonly configuredPath: string | undefined },
  fileSystem: FileSystem.FileSystem,
  trustedInstallRoot: string,
  ownerUid: number | undefined,
) =>
  Effect.gen(function* () {
    const requested = configuredGatewayModulePath(input.configuredPath);
    if ("error" in requested) return yield* Effect.fail(requested.error);
    const evidence = yield* resolveGatewayModuleEvidence(
      { checkout: input.checkout, requestedPath: requested.path, ownerUid },
      fileSystem,
      trustedInstallRoot,
    );
    if (
      !isTrustedInstallDirectory(
        evidence.canonicalInstallRoot,
        evidence.installRootInfo,
        evidence.installRootAncestorInfo,
        trustedInstallRoot,
        ownerUid,
      ) ||
      !isTrustedAdapterModuleFile({ ...evidence, requestedPath: requested.path, ownerUid })
    )
      return yield* Effect.fail(
        new PreviewGatewayRuntimeError({ reason: "gateway-adapter-module-path-invalid" }),
      );
    return evidence.canonicalModulePath;
  });

const defaultImportModule = (modulePath: string) =>
  Effect.tryPromise({
    try: () => import(pathToFileURL(modulePath).href) as Promise<unknown>,
    catch: () => new PreviewGatewayRuntimeError({ reason: "gateway-adapter-module-unavailable" }),
  });

/** Loads only host-installed gateway transport code; the mutable checkout cannot define it. */
const loadPreviewGatewayAdaptersFromRoot = (
  input: {
    readonly checkout: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly authority: PreviewWorkflowApiAuthorityPayload;
    readonly importModule?: (
      modulePath: string,
    ) => Effect.Effect<unknown, PreviewGatewayRuntimeError>;
  },
  trustedInstallRoot: string,
  ownerUid: number | undefined,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const modulePath = yield* resolveExternalModulePath(
      {
        checkout: input.checkout,
        configuredPath: input.environment[gatewayAdapterModuleEnvironmentName],
      },
      fileSystem,
      trustedInstallRoot,
      ownerUid,
    );
    const imported = yield* (input.importModule ?? defaultImportModule)(modulePath);
    if (!isGatewayAdapterModule(imported))
      return yield* Effect.fail(
        new PreviewGatewayRuntimeError({ reason: "gateway-adapter-module-factory-missing" }),
      );
    const gatewayEnvironment = Object.fromEntries(
      Object.entries(input.environment).filter(
        (entry): entry is [string, string] =>
          entry[0].startsWith("TIARA_PREVIEW_GATEWAY_") && entry[1] !== undefined,
      ),
    );
    const runtime = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          imported.makePreviewGatewayRuntime({
            authority: input.authority,
            environment: gatewayEnvironment,
          }),
        ),
      catch: () => new PreviewGatewayRuntimeError({ reason: "gateway-adapter-module-failed" }),
    });
    if (!isPreviewGatewayRuntime(runtime, input.authority.gatewayDomain))
      return yield* Effect.fail(
        new PreviewGatewayRuntimeError({ reason: "gateway-adapter-api-invalid" }),
      );
    return Option.some({ ...runtime, domain: input.authority.gatewayDomain });
  });

/** Loads only the root-installed production gateway adapter module. */
export const loadPreviewGatewayAdapters = (input: {
  readonly checkout: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly authority: PreviewWorkflowApiAuthorityPayload;
  readonly importModule?: (
    modulePath: string,
  ) => Effect.Effect<unknown, PreviewGatewayRuntimeError>;
}): Effect.Effect<PreviewGatewayRuntimeLoadResult, never, FileSystem.FileSystem> =>
  Effect.result(
    loadPreviewGatewayAdaptersFromRoot(input, gatewayAdapterTrustedInstallRoot, 0),
  ).pipe(
    Effect.map(
      Result.match({
        onFailure: (error) => ({
          runtime: Option.none(),
          unavailableReason: Option.some(error.reason),
        }),
        onSuccess: (runtime) => ({
          runtime,
          unavailableReason: Option.none(),
        }),
      }),
    ),
  );

/** Unit-test seam for a private temporary install directory; normal CLI never calls this. */
export const loadPreviewGatewayAdaptersFromTrustedDirectory = (
  input: {
    readonly checkout: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly authority: PreviewWorkflowApiAuthorityPayload;
    readonly importModule?: (
      modulePath: string,
    ) => Effect.Effect<unknown, PreviewGatewayRuntimeError>;
  },
  trustedInstallRoot: string,
  ownerUid?: number,
) => loadPreviewGatewayAdaptersFromRoot(input, trustedInstallRoot, ownerUid);
