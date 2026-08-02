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

### Not done yet: Windows browser accelerators

On Windows the interception point is different. WebView2 has no tabs or windows
of its own, so Ctrl+W and Ctrl+T reach the page already — but WebView2 _does_
claim a set of browser accelerator keys, and three of them matter here:

| Key      | WebView2 does | vim wants          |
| -------- | ------------- | ------------------ |
| `Ctrl+F` | Find on page  | page forward       |
| `Ctrl+P` | Print         | previous / history |
| `Ctrl+R` | Reload        | redo               |

Turning those off is one call —
`ICoreWebView2Settings3::put_AreBrowserAcceleratorKeysEnabled(false)`, reached
through `WebviewWindow::with_webview` — but it needs the `webview2-com` and
`windows` crates pinned to exactly the versions Tauri itself uses, and a
mismatch there is a type error rather than a graceful failure. That was not
verifiable without fetching the crate index, so it is written down here rather
than guessed at.

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

If that origin should be settable in the UI rather than baked in at build time,
this package is where a `get_server_url` / `set_server_url` command pair would
live, and `capabilities/default.json` would gain the permission for it. Nothing
here assumes either answer yet.
