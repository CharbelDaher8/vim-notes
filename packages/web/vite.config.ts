import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],

  server: {
    // The dev server binds to the tailnet address the API is on too, so the
    // phone can reach it without a tunnel. See DECISIONS.md §11.
    host: true,
    proxy: {
      '/trpc': { target: 'http://127.0.0.1:4000', changeOrigin: true, ws: true },
      // The pty socket. Same origin in production, so only dev needs this.
      '/terminal': { target: 'ws://127.0.0.1:4000', ws: true },
    },
  },

  build: {
    target: 'es2022',
    sourcemap: true,

    rollupOptions: {
      treeshake: {
        /**
         * `@vim-notes/core` is the interior of the hexagon: no I/O, no Node
         * builtins, no module-level effects -- and that is enforced by lint,
         * not just asserted. Telling the bundler so lets it drop the parts the
         * browser never touches.
         *
         * Concretely: core's barrel re-exports `schemas/index`, which builds
         * zod schemas at module scope. The server validates with those; this
         * client only ever imports types and pure functions from core, so
         * without this the browser downloads all of zod to use none of it.
         */
        moduleSideEffects: (id) => !id.includes('/packages/core/'),
      },
    },
  },

  test: {
    // Everything under test here is deliberately DOM-free: the platform fake,
    // the pure models, the schedulers. Rendering React would need jsdom, which
    // is not a dependency of this package.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
