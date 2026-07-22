import { globSync } from "glob";
import path from "pathe";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite-plus";

type PackConfig = Exclude<NonNullable<UserConfig["pack"]>, readonly unknown[]>;

const lint = {
  ignorePatterns: [".output", ".ts-out", "dist"],
  env: {
    es2022: true,
  },
  plugins: ["unicorn", "typescript", "oxc"],
  rules: {
    "no-unused-vars": [
      "error",
      {
        args: "all",
        argsIgnorePattern: "^_",
        caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        ignoreRestSiblings: true,
      },
    ],
  },
  options: {
    typeAware: true,
    typeCheck: true,
  },
} satisfies NonNullable<UserConfig["lint"]>;

const mergeRecord = <Defaults extends object, Overrides extends object>(
  defaults: Defaults,
  overrides: Overrides | undefined,
) => ({
  ...defaults,
  ...overrides,
});

const browserEnv = (browser: boolean) => (browser ? { browser: true } : {});

type LintConfig = NonNullable<UserConfig["lint"]>;

const mergeIgnorePatterns = (overrides: LintConfig | undefined) => [
  ...lint.ignorePatterns,
  ...(overrides?.ignorePatterns ?? []),
];

const mergeLintEnv = (overrides: LintConfig | undefined, browser: boolean) =>
  mergeRecord({ ...lint.env, ...browserEnv(browser) }, overrides?.env);

const mergeLintOptions = (overrides: LintConfig | undefined) =>
  mergeRecord(lint.options, overrides?.options);

const mergeLintRules = (overrides: LintConfig | undefined) =>
  mergeRecord(lint.rules, overrides?.rules);

const mergedLint = (overrides: LintConfig | undefined, browser: boolean): LintConfig => ({
  ...lint,
  ...overrides,
  ignorePatterns: mergeIgnorePatterns(overrides),
  env: mergeLintEnv(overrides, browser),
  options: mergeLintOptions(overrides),
  rules: mergeLintRules(overrides),
});

const mergeLint = (config: UserConfig, browser: boolean): UserConfig => ({
  ...config,
  lint: mergedLint(config.lint, browser),
});

const mergePack = (pack: PackConfig): PackConfig => ({
  sourcemap: true,
  dts: { tsgo: true },
  ...pack,
  deps: {
    onlyBundle: false,
    ...pack.deps,
  },
});

const packageConfig = (config: UserConfig, browser: boolean): UserConfig =>
  mergeLint(
    {
      ...config,
      ...(config.pack === undefined
        ? {}
        : {
            pack: Array.isArray(config.pack) ? config.pack.map(mergePack) : mergePack(config.pack),
          }),
    },
    browser,
  );

export const library = (config: UserConfig): UserConfig =>
  defineConfig(packageConfig(config, false));

export const browserLibrary = (config: UserConfig): UserConfig =>
  defineConfig(packageConfig(config, true));

export const app = (config: UserConfig): UserConfig => defineConfig(packageConfig(config, false));

export const browserApp = (config: UserConfig): UserConfig =>
  defineConfig(packageConfig(config, true));

export const appsScript = (config: UserConfig): UserConfig =>
  defineConfig(packageConfig(config, true));

export const packageEntries = (
  configUrl: string,
  patterns: readonly string[],
): Record<string, string> =>
  Object.fromEntries(
    patterns.flatMap((pattern) =>
      globSync(pattern, { nodir: true }).map((file) => {
        const filePath = fileURLToPath(new URL(file, configUrl));
        const relativePath = path.relative("./src", filePath);
        const parsed = path.parse(relativePath);
        const module = path.join(parsed.dir.replace(/\.+\//g, ""), parsed.name);

        return [module, filePath];
      }),
    ),
  );
