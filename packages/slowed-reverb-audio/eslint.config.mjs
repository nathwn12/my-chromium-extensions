import globals from "globals";

export default [
  {
    ignores: [
      "eslint.config.mjs",
      "**/node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "qa/**",
      ".playwright/**",
    ],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.es2020,
        SlowedReverbShared: "readonly",
        importScripts: "readonly",
        AudioWorkletProcessor: "readonly",
        registerProcessor: "readonly",
        sampleRate: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", vars: "local" }],
      "no-undef": "error",
      "no-constant-binary-expression": "error",
      "no-var": "warn",
      "prefer-const": "warn",
      eqeqeq: ["warn", "smart"],
    },
  },
];
