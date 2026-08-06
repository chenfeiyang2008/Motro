import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      ".agents/**",
      ".claude/**",
      ".impeccable/**",
      ".scratch/**",
      "docs/**",
      "prototype/**",
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts,mjs,cjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
        global: "readonly",
      },
    },
  },
  eslintConfigPrettier,
);
