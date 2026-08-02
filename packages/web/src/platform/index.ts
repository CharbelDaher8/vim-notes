export type { HostCapabilities, HostCommand, Platform, PlatformHost, PlatformId } from './platform'
export { PlatformProvider, usePlatform } from './platform-provider'
export { InMemoryPlatform, type InMemoryPlatformOptions } from './in-memory-platform'
export { SEED_NOTES } from './in-memory-seed'
export { WebPlatform, type NotesApiClient } from './web-platform'
export { TauriPlatform, createTauriHost, isRunningInTauri } from './tauri-platform'
export { documentHost } from './document-host'
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
