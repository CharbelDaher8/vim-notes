import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/target/**',
      '**/*.d.ts',
      '**/.tauri/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // The hexagon boundary, enforced mechanically rather than by convention.
  //
  // packages/core holds the port interfaces, NotePath and the conflict rules.
  // It is imported by BOTH the server and the browser client, so it has to stay
  // free of Node builtins entirely -- including `node:path`, which is pure but
  // would still drag in a polyfill on the web side. NotePath therefore
  // hand-rolls the small amount of POSIX path logic it needs; see
  // packages/core/src/domain/note-path.ts.
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'fs/*',
                'path',
                'child_process',
                'os',
                'net',
                'http',
                'https',
                'crypto',
                'stream',
                'worker_threads',
              ],
              message:
                'core is the interior of the hexagon: no I/O, no Node builtins (it ships to the browser too). Put this behind a port and implement it in packages/server/src/adapters.',
            },
            {
              group: ['@vim-notes/server', '@vim-notes/server/*', '@vim-notes/web', '@vim-notes/web/*'],
              message: 'core must not depend on outer layers. Dependencies point inward only.',
            },
          ],
        },
      ],
    },
  },

  // Adapters are where I/O is supposed to live, so the ban is lifted there.
  {
    files: ['packages/server/**/*.ts', 'packages/web/**/*.ts', 'packages/web/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Tests may reach for whatever they need.
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/test/**'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
