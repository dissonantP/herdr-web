import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// The adapter boundary (SPEC F9): the interfaces in src/adapters name no implementation.
export default tseslint.config(
  { ignores: ["node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  {
    files: ["src/adapters/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/herdr-core/**", "**/claude/**"], message: "The adapter interfaces name no implementation." }] }],
    },
  },
);
