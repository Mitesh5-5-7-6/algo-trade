// Root ESLint law for the workspace — encodes the lint-able subset of
// plan/25_CODING_STANDARDS.md (§2 type discipline, §5 error/async discipline).
// Boundary bans (§4: event literals, cross-package infra imports) land as
// custom rules per the 25 §10 roadmap once the packages they police exist.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/out/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // plan/25 §2 — `any` is banned, absolutely
      "@typescript-eslint/no-explicit-any": "error",
      // plan/25 §5 — an unawaited rejection is an invisible failure
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // plan/25 §5 — no swallowed errors
      "no-empty": ["error", { allowEmptyCatch: false }],
      // Numbers interpolate deterministically; objects/arrays still error.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
