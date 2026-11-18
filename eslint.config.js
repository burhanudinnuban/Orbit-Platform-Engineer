import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // The portal lints itself (portal/eslint.config.js). App templates are the
  // starting code of user repositories, not Orbit's own code.
  globalIgnores(['dist/', 'portal/', 'templates/', '.orbit-data/']),
  {
    files: ['**/*.{ts,js,mjs}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // `const { secret: _s, ...rest } = obj` is how the code omits a key.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true },
      ],
    },
  },
  {
    // The API logs through pino. The CLI and the bootstrap scripts print to a
    // terminal on purpose, so they are exempt.
    files: ['src/**/*.ts'],
    ignores: ['src/cli.ts'],
    rules: {
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
])
