import eslintPluginJs from "@eslint/js"
import eslintPluginStylistic from "@stylistic/eslint-plugin"
import globals from "globals"

const config = [
  {
    files: ["**/*.js", "**/*.mjs"],
  },
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        Log: "readonly",
        Module: "readonly",
      },
    },
    plugins: {
      ...eslintPluginStylistic.configs["recommended-flat"].plugins,
    },
    rules: {
      ...eslintPluginJs.configs.recommended.rules,
      ...eslintPluginStylistic.configs["recommended-flat"].rules,
      "@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: true }],
      "@stylistic/comma-dangle": ["error", "only-multiline"],
      "@stylistic/max-statements-per-line": ["error", { max: 2 }],
      "@stylistic/quotes": ["error", "double"]
    },
  }
]

export default config
