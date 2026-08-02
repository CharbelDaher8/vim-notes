# @vim-notes/desktop

The Tauri shell. A window, a menu bar, and nothing else — DECISIONS §10 keeps
this a wrapper around the same web client rather than a second codebase, so all
the behaviour lives in `packages/web` behind the `Platform` port.

## Running it

```sh
pnpm --filter @vim-notes/desktop icons   # once: generates the platform icon set
pnpm --filter @vim-notes/desktop dev
```

`dev` starts the web dev server through `beforeDevCommand` and points the window
at it. `pnpm --filter @vim-notes/desktop build:app` produces a bundle for the
current platform.

The build script is `build:app`, not `build`, on purpose: `pnpm -r build` at the
repository root would otherwise require a Rust toolchain to build the web client.

## Icons

`icons/app-icon.png` is the source. `pnpm icons` expands it into the `.png`,
`.icns` and `.ico` set that the bundler needs, into `src-tauri/icons/`, which is
gitignored because it is derived.

The current source icon is a **placeholder** — a terminal block cursor, drawn
programmatically so that it looks deliberate rather than missing. Replace it
with anything 1024×1024 and re-run `pnpm icons`.

## What the shell actually does: the keyboard

This is the reason the desktop target exists. Browsers bind `Cmd+W`, `Ctrl+W`
and `Cmd+T` to their own window management, and those collide with vim and with
terminal bindings.

A native window does **not** get them for free. On macOS, Tauri's default menu
is the standard macOS set, which binds Cmd+W to Close Window and Cmd+N to New
Window — and macOS dispatches menu accelerators _before_ the key event reaches
the webview. Using the default menu would recreate the exact collision the
desktop build exists to remove.

So `src-tauri/src/main.rs` builds the menu by hand, and the accelerators are
absent by construction: no Close Window, no New Window, no View or Window
submenu. Cmd+W, Cmd+T and Cmd+N therefore reach the editor. The window closes
with Cmd+Q or the red button.

The Edit submenu is kept deliberately: on macOS the clipboard inside a webview
is driven by those menu items, and an app without them has copy and paste that
silently do nothing.

### Windows: browser accelerators

The interception point on Windows is different. WebView2 has no tabs or windows
of its own, so Ctrl+W and Ctrl+T reach the page already — but it claims a set of
_browser_ accelerators before the page sees them, and three of those are
bindings this app cannot afford to lose:

| Key      | WebView2 does | what it means here    |
| -------- | ------------- | --------------------- |
| `Ctrl+F` | Find on page  | page forward in vim   |
| `Ctrl+P` | Print         | previous / completion |
| `Ctrl+R` | Reload        | redo                  |

The `keyboard` module in `src-tauri/src/main.rs` turns them off through
`ICoreWebView2Settings3::AreBrowserAcceleratorKeysEnabled`, reached via
`WebviewWindow::with_webview`. An older WebView2 runtime does not implement that
interface, so the cast is allowed to fail: the app stays usable with the
accelerators left on rather than refusing to start.

`webview2-com` and `windows` are pinned in `Cargo.toml` to the versions Tauri
already resolves (0.38 and 0.61), and both bind `windows-core` 0.61.2. That
matters more than it looks: the cast converts a COM pointer the webview handed
us, so a second copy of `windows-core` in the tree would make the interface a
nominally different type and the cast would not compile.

**Not yet compiled for Windows.** The pins are read from `Cargo.lock` and the
manifest is verified, but the FFI body itself — the method names and the
`false.into()` conversion — has only been checked on a macOS host, where the
Windows target is never built. The `desktop` workflow compiles it for real on
`windows-latest`; until that runs, treat this block as unverified. Locally:

```sh
rustup target add x86_64-pc-windows-msvc
cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml \
  --target x86_64-pc-windows-msvc
```

## Signing

Not signed, deliberately (DECISIONS §10). macOS builds get an ad-hoc signature;
right-click-open once. Windows builds are unsigned; click through SmartScreen
once. CI sets no certificate secrets.

## What the web side needs

`TauriPlatform` in `packages/web/src/platform/` is not part of this package. For
it to work against this shell it needs one thing the browser build gets for
free: **the server's base URL**. In a browser the client is served by Caddy and
can use a relative path; here the client is loaded from the bundle over
`tauri://` (or `http://tauri.localhost` on Windows), so `/trpc` resolves to the
bundle rather than to the server.

So the desktop build needs a configured server origin — the tailnet address from
DECISIONS §11 — and both the tRPC URL and the terminal WebSocket URL have to be
absolute. The CSP in `tauri.conf.json` already allows `http:`, `https:`, `ws:`
and `wss:` in `connect-src` for exactly this reason; it cannot be narrowed to a
literal host, because the host is the user's own machine name.

**That origin is a runtime setting in `packages/web`, not a Tauri command.**
`localStorage` works in the Tauri webview, so the web package persists it with a
build-time default and no Rust is involved. Two reasons it landed there: it adds
no IPC at all, which is the right posture for something whose entire access story
is "unreachable off the tailnet"; and a tailnet address can change, so baking it
in at build time would mean rebuilding the app to move house.

It is implemented in `packages/web/src/platform/server-origin.ts`, with the form
in `packages/web/src/app/server-settings.tsx`. Precedence is stored value →
`VITE_SERVER_ORIGIN` at build time → the page's own origin, which is only usable
in a browser. Set a build-time default with:

```sh
VITE_SERVER_ORIGIN=http://100.64.0.1:8080 pnpm --filter @vim-notes/desktop build:app
```

So this package writes **no commands of its own**. The entire IPC surface is two
permissions from `tauri-plugin-opener`, listed in `capabilities/default.json`.

## The opener plugin

`openExternal` is load-bearing rather than cosmetic: a plain navigation inside a
webview **replaces the running application**, with no browser chrome and no back
button to return from, and notes are full of links. The web client previously
invoked `open_external` and `reveal_in_file_manager`, neither of which existed
here — `invoke` rejects an unknown command, so every external link failed.

`tauri-plugin-opener` rather than two hand-written commands: the per-platform
business of `open` / `xdg-open` / `ShellExecute` is then maintained by someone
else, and the permissions are narrower than the blanket shell access a bespoke
version invites.

Granted individually rather than via `opener:default`, which also permits
opening arbitrary paths with an arbitrary program:

| Permission                        | Used by                    |
| --------------------------------- | -------------------------- |
| `opener:allow-open-url`           | `host.openExternal`        |
| `opener:allow-reveal-item-in-dir` | `host.revealInFileManager` |

The web side reaches them as `plugin:opener|open_url` and
`plugin:opener|reveal_item_in_dir` through the core `invoke`, so
`@tauri-apps/plugin-opener` is not a dependency — it would only wrap those two
strings.

### `withGlobalTauri` is on, and is load-bearing

`app.withGlobalTauri: true` in `tauri.conf.json` puts the JS API on
`window.__TAURI__`. `packages/web/src/platform/tauri-platform.ts` reaches the
native side through that global rather than through `@tauri-apps/api`, which is
not a dependency of the web package.

Without it the webview looks exactly like a browser to the client: the host
reports `kind: 'browser'`, falls back to `documentHost`, and the server-address
form — the only way to configure the desktop build — never renders. So the app
would ship unable to reach any server and with no UI to fix it.

The alternative is adding `@tauri-apps/api` to `packages/web` and importing
properly, which is tidier and needs an install.
