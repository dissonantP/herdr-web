import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

// The adapter boundary (SPEC F9), enforced: the UI imports only the shared model; the HTTP layer
// and everything else on the server import the adapter interfaces (@herdr/server/adapters), never
// an implementation (@herdr/server/herdr-core, @herdr/server/claude). Only src/server/main.ts (the
// composition root) may name one.
const implementations = ["**/herdr-core/**", "**/claude/**"];

export default tseslint.config(
  { ignores: ["dist", "node_modules", "test-results", "playwright-report"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  {
    files: ["src/web/**"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/server/**"], message: "The UI talks to the backend only over the HTTP API (src/shared/model.ts types)." }] }],
    },
  },
  {
    files: ["src/server/**"],
    ignores: ["src/server/main.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: implementations, message: "Depend on the @herdr/server/adapters interfaces; only main.ts picks an implementation." }] }],
    },
  },
);
