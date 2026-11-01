// ESLint flat config for the whole monorepo: SDK, web app, scripts and config files.
// `pnpm lint` checks everything; formatting is left to Prettier (`pnpm format:check`).
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.next/**",
      "**/.next-*/**",
      "**/next-env.d.ts",
      "target/**",
      "artifacts/**",
      "apps/web/public/**",
      ".submission/**",
      ".vercel/**",
      ".ui-backup/**",
      ".icon-tmp/**",
      ".vscode/**",
      ".idea/**",
      "test-results/**",
      "playwright-report/**",
      "blob-report/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // `_`-prefixed bindings are intentionally unused (e.g. `const { runtime: _runtime, ...rest }`).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    // The web app and the SDK both run in the browser.
    files: ["apps/web/src/**/*.{ts,tsx}", "packages/agent-swarm-sdk/src/**/*.ts"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // Callbacks passed to page.evaluate() run inside Chromium.
    files: ["scripts/wallet-smoke.mjs"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    settings: { next: { rootDir: "apps/web" } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs["recommended-latest"].rules,
    },
  },
  prettier,
);
