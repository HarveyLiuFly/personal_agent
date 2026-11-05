// Report-only lint baseline (CORE.0). `pnpm lint` lists findings; it does not gate `pnpm check` yet.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'packages/codex-adapter/src/generated/**',
      'build/**',
      'node_modules/**',
      '.local/**',
      'refs/**',
      'docs/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Review A8: errors swallowed by empty catch blocks.
      'no-empty': ['warn', { allowEmptyCatch: false }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
);
