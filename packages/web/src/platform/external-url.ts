/**
 * Only http(s) links are ever handed to the operating system.
 *
 * A note is a text file that anyone -- or a `git pull` from the hub -- can put
 * anything into, and passing an arbitrary scheme to the OS is how a markdown
 * link becomes code execution. `file:` reads local disk, `javascript:` runs in
 * whatever context opens it, and every custom scheme some other installed
 * application registered is an entry point nobody here has audited.
 *
 * Enforced on both hosts rather than only the Tauri one: the browser is the
 * safer of the two, but the rule is about what is in the note, not about which
 * window is open.
 */
export function isSafeExternalUrl(url: string): boolean {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    // Relative or malformed. Nothing to hand off.
    return false
  }

  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}
