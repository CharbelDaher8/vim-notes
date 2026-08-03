export type { HostCapabilities, HostCommand, Platform, PlatformHost, PlatformId } from './platform'
export { PlatformProvider, usePlatform } from './platform-provider'
export { InMemoryPlatform, type InMemoryPlatformOptions } from './in-memory-platform'
export { SEED_NOTES } from './in-memory-seed'
export { WebPlatform } from './web-platform'
export { createNotesClient, type NotesClient } from './trpc-client'
export { TauriPlatform, createTauriHost, isRunningInTauri } from './tauri-platform'
export { documentHost } from './document-host'
export {
  registerServiceWorker,
  shouldRegisterServiceWorker,
  type ServiceWorkerEnvironment,
} from './register-service-worker'
export { isSafeExternalUrl } from './external-url'
export {
  apiUrl,
  clearStoredOrigin,
  currentServerOrigin,
  describeOriginError,
  isUsablePageOrigin,
  parseServerOrigin,
  readStoredOrigin,
  resolveServerOrigin,
  socketUrl,
  writeStoredOrigin,
  type OriginError,
  type OriginResolution,
  type OriginSource,
} from './server-origin'
