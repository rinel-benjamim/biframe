import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'release/**',
      'node_modules/**',
      'coverage/**',
      '.poc-out/**',
      '.test-out/**',
      '.tmp/**',
      '.taste-skill/**',
      // Local render/screenshot harnesses, not application code.
      'scripts/dev/**',
      'scripts/poc/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
