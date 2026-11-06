import { createRequire } from "node:module";
import { Config, ConfigProvider, Effect, Schema } from "effect";

const PlaywrightPackageSchema = Schema.Struct({ version: Schema.NonEmptyString });

const packageResolutionError = () =>
  new Config.ConfigError(
    new ConfigProvider.SourceError({
      message: "The pinned Playwright package must be resolvable from the workflow runtime",
    }),
  );

const packageMetadataError = () =>
  new Config.ConfigError(
    new ConfigProvider.SourceError({
      message: "The installed Playwright package must provide valid version metadata",
    }),
  );

/** Resolves the installed Playwright version only when the capability identity Effect runs. */
export const playwrightPackageVersionFrom = (referrerUrl: string) =>
  Effect.try({
    try: () => createRequire(referrerUrl)("playwright/package.json"),
    catch: packageResolutionError,
  }).pipe(
    Effect.flatMap((metadata) =>
      Schema.decodeUnknownEffect(PlaywrightPackageSchema)(metadata).pipe(
        Effect.map(({ version }) => version),
        Effect.mapError(() => packageMetadataError()),
      ),
    ),
  );
