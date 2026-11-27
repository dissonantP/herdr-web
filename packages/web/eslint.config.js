import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

// Browser code: of the server package it may use only the wire types (chat.ts, model.ts); it
// talks to a server over HTTP and WebSockets, never by importing it.
export default tseslint.config(
  { ignores: ["node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  {
    files: ["src/**"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": ["error", { patterns: [{ group: ["@herdr/server/*", "!@herdr/server/chat.ts", "!@herdr/server/model.ts"], message: "Only the wire types (@herdr/server/chat.ts, model.ts) come from the server package." }] }],
    },
  },
);
