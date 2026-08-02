/**
 * The package entry, and deliberately nothing but types.
 *
 * `packages/web` depends on this package for exactly one thing: `AppRouter`,
 * which is what gives the browser a fully typed client with no codegen step
 * (DECISIONS.md §8). A type disappears at build time, so the web bundle gets
 * the contract and none of the server.
 *
 * Values must not be exported here. `package.json` points this file at the raw
 * TypeScript, so a value export is an invitation for the browser build to pull
 * fastify, chokidar or node-pty into its graph -- and node-pty is a native
 * module that cannot be bundled at all.
 */
export type { AppRouter } from './api/router'
