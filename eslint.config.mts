import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";

export default defineConfig([
  // Base JS/TS config
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },

  // TypeScript config
  tseslint.configs.recommended,

  // React config
  {
    ...pluginReact.configs.flat.recommended,
    settings: {
      react: {
        version: "detect", // Auto-detect React version
      },
    },
  },

  // React Hooks config
  {
    plugins: {
      "react-hooks": pluginReactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // Project-specific rules
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // React 17+ with new JSX transform doesn't need React in scope
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off", // Using TypeScript for prop types

      // TypeScript-specific adjustments
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
      "@typescript-eslint/no-explicit-any": "warn",

      // Allow empty functions (useful for noop callbacks)
      "@typescript-eslint/no-empty-function": "off",
    },
  },

  // Ignore patterns
  {
    ignores: [
      "node_modules/",
      "out/",
      "dist/",
      "*.config.*",
    ],
  },
]);
