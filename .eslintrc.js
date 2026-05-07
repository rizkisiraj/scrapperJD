module.exports = {
  env: {
    node: true,
    es2021: true,
  },
  // Tell ESLint these are CommonJS scripts, not ES modules.
  // Without this, Airbnb flags 'use strict' as unnecessary (it's built into ESM).
  parserOptions: {
    sourceType: 'script',
  },
  extends: 'airbnb-base',
  rules: {
    // Airbnb defaults strict to 'never' (assumes ESM). We're CJS, so require it globally.
    strict: ['error', 'global'],

    // CommonJS modules — no ES module syntax
    'import/no-commonjs': 'off',

    // Uncle Bob: descriptive names are often long — don't penalise them
    'max-len': ['warn', { code: 120 }],

    // Structured logging via pino uses console-free pattern, but allow it during dev
    'no-console': 'warn',
  },
};
