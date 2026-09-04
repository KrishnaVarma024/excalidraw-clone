import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', '_learning'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      // Unused args are fine when they are there to document a signature,
      // as long as they are marked with a leading underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `!` shows up in hot loops where the compiler cannot prove an index is
      // in range. Each use is commented; blanket-banning it would push us to
      // add branches inside 60fps code paths.
      '@typescript-eslint/no-non-null-assertion': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  {
    files: ['src/react/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  /* Node globals for everything that runs OUTSIDE the browser: the test suite,
     the config files, the build scripts, and the Playwright specs. Kept as an
     explicit list rather than "everything not in src/" so that adding a new
     top-level directory is a decision — src/engine/ is deliberately DOM-free
     but it is not Node either, and giving it `process` by accident is how a
     `process.env` check ends up shipped to a browser. */
  {
    files: [
      'tests/**/*.ts',
      'e2e/**/*.ts',
      'scripts/**/*.mjs',
      'vite.config.ts',
      'playwright.config.ts',
      'eslint.config.js',
    ],
    languageOptions: { globals: globals.node },
    rules: {
      // These files ARE the console output. `checkBundle.mjs` prints a table;
      // suppressing that would defeat the script.
      'no-console': 'off',
    },
  },
);
