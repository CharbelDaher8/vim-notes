import { defineConfig } from 'tsup'

/**
 * tsup treats everything in `dependencies` as external, and `@vim-notes/core`
 * is a workspace dependency whose package entry is `./src/index.ts`. That is
 * fine everywhere the TypeScript toolchain is present -- tests, `tsx watch`,
 * the typechecker -- and fatal in a runtime image, where plain `node` would be
 * asked to import a `.ts` file and refuse. Without `noExternal` the built
 * server exits on its first import.
 *
 * Everything else stays external and is installed normally. That matters most
 * for node-pty, which is a native module and cannot be bundled at all.
 */
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  noExternal: [/^@vim-notes\//],
})
