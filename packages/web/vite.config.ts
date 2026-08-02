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
    },
  },

  build: {
    target: 'es2022',
    sourcemap: true,
  },

  test: {
    // Everything under test here is deliberately DOM-free: the platform fake,
    // the pure models, the schedulers. Rendering React would need jsdom, which
    // is not a dependency of this package.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
