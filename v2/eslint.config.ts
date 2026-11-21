import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const typed = {
  parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
};

export default defineConfig(
  { ignores: ["node_modules/**", "dist/**", "**/*.test.ts", "src/test/**", "eslint.config.ts"] },
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.base],
    languageOptions: typed,
    linterOptions: { noInlineConfig: true },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
    },
  },
  {
    files: ["src/tui/otui/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/strict-boolean-expressions": "error",
    },
  },
);
