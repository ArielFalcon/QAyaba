// Lints the scripts that run as text in another process (src/**/embedded/**): recommended rules, and no empty catch
// (a swallowed fault says why it is swallowed).
import tseslint from "typescript-eslint";

export default tseslint.config(...tseslint.configs.recommended, {
  files: ["**/*.cjs"],
  rules: {
    "no-empty": ["error", { allowEmptyCatch: false }],
    "@typescript-eslint/no-require-imports": "off",
    "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none", argsIgnorePattern: "^_" }],
  },
});
