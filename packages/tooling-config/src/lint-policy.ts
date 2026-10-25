import type { UserConfig } from "vite-plus";

type LintConfig = NonNullable<UserConfig["lint"]>;

export const lintPolicy = {
  options: {
    typeAware: true,
    typeCheck: true,
    respectEslintDisableDirectives: false,
  },
  rules: {
    "eslint/no-nested-ternary": "error",
    "tiara-effect-policy/no-nested-ternary-adoption": "error",
    "tiara-effect-policy/effect-predicate": "error",
    "tiara-effect-policy/effect-match": "error",
    "tiara-effect-policy/effect-live-test": "error",
    "tiara-effect-policy/controlled-test-timeouts": "error",
    "tiara-effect-policy/exhaustive-diagnostic-tables": "error",
    "tiara-effect-policy/preserve-unknown-evidence": "error",
    "tiara-effect-policy/canonical-lifecycle-contracts": "error",
    "tiara-effect-policy/builtin-site-adoption": "error",
    "typescript/no-unsafe-type-assertion": "error",
    "typescript/restrict-template-expressions": [
      "error",
      {
        allowAny: true,
        allowBoolean: true,
        allowNumber: true,
        allowNullish: false,
        allowRegExp: true,
      },
    ],
  },
} satisfies Pick<LintConfig, "options" | "rules">;
