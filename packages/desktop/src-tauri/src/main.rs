// A release build must not open a console window behind the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The vim-notes desktop shell.
//!
//! Deliberately almost empty. DECISIONS §10 makes this a wrapper around the same
//! web client, not a second codebase: everything the UI does goes through the
//! `Platform` port on the web side, so there is nothing for Rust to do here
//! beyond opening a window and getting out of the way.
//!
//! What it does own is the keyboard, which is the actual reason the desktop
//! target exists. See `menu` below.

fn main() {
    // The only plugin, and the only IPC this shell exposes beyond Tauri's own
    // defaults. See Cargo.toml for why it is worth the surface.
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // Only macOS gets a menu. On Windows and Linux an app has no menu bar
    // unless one is set, and setting one there would add a strip of chrome
    // whose only purpose is to take key bindings away from the editor.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build);

    // Windows takes its keys back from the webview instead -- see `keyboard`.
    #[cfg(target_os = "windows")]
    let builder = builder.setup(|app| {
        keyboard::release_browser_accelerators(app);
        Ok(())
    });

    builder
        .run(tauri::generate_context!())
        .expect("failed to start the vim-notes desktop shell");
}

/// Windows: hand the browser accelerator keys back to the editor.
///
/// The macOS problem is the menu bar. The Windows problem is a different one
/// with the same consequence. WebView2 has no tabs and no windows of its own,
/// so Ctrl+W and Ctrl+T reach the page already -- but it does claim a set of
/// *browser* accelerators before the page sees them, and three of those are
/// bindings this app cannot afford to lose:
///
/// | key    | WebView2 does | what it means here      |
/// |--------|---------------|-------------------------|
/// | Ctrl+F | find on page  | page forward in vim     |
/// | Ctrl+P | print dialog  | previous / completion   |
/// | Ctrl+R | reload        | redo                    |
///
/// A print dialog opening over nvim because someone reached for Ctrl+P is the
/// desktop build failing at the one job it exists to do.
///
/// Turning them off is a single COM property, but it is reachable only through
/// the platform webview, hence the FFI. `ICoreWebView2Settings3` is the
/// interface that carries it; an older WebView2 runtime will not implement it,
/// which is why the cast is allowed to fail rather than being unwrapped.
#[cfg(target_os = "windows")]
mod keyboard {
    use tauri::{App, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    pub fn release_browser_accelerators(app: &App) {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };

        // `with_webview` runs on the UI thread once the webview exists.
        let _ = window.with_webview(|webview| {
            let outcome = unsafe {
                webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.Settings())
                    .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
                    .and_then(|settings| settings.SetAreBrowserAcceleratorKeysEnabled(false.into()))
            };

            // Degrading quietly is the right behaviour in a release build: the
            // app is perfectly usable with browser accelerators left on, and
            // there is no console to print to under `windows_subsystem`. In a
            // debug build there is one, and silence would make this impossible
            // to tell apart from the code never having run.
            #[cfg(debug_assertions)]
            if let Err(error) = &outcome {
                eprintln!("vim-notes: could not release WebView2 accelerator keys: {error}");
            }

            let _ = outcome;
        });
    }
}

/// The macOS menu bar, and the keyboard argument for the whole desktop app.
///
/// macOS routes menu accelerators before the key event ever reaches the
/// webview, and Tauri's default menu is the standard macOS set -- which binds
/// **Cmd+W to Close Window** and Cmd+N to New Window. In a browser those are the
/// bindings that make vim painful (DECISIONS §10), and simply putting the same
/// app in a native window does not fix them: the default menu re-creates the
/// exact collision the desktop build was supposed to remove.
///
/// So the menu is built by hand and the accelerators we want the editor to see
/// are *absent by construction*:
///
/// - **No Close Window**, so Cmd+W reaches the webview. The window is closed
///   with Cmd+Q or the red button.
/// - **No New Window / New Tab**, so Cmd+T and Cmd+N reach the webview.
/// - **No View or Window submenu**, which is where the rest of the standard
///   accelerators (Cmd+M, Cmd+0/+/-) would otherwise come from.
///
/// The Edit submenu is kept on purpose and is not optional: on macOS, copy and
/// paste inside a webview are driven by those menu items, and an app without
/// them has a clipboard that silently does nothing.
#[cfg(target_os = "macos")]
mod menu {
    use tauri::{
        menu::{AboutMetadata, Menu, MenuBuilder, SubmenuBuilder},
        AppHandle, Runtime,
    };

    pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
        // The first submenu is the application menu whatever it is called; the
        // name shown is the bundle's, not this string.
        let application = SubmenuBuilder::new(app, "vim-notes")
            .about(Some(AboutMetadata::default()))
            .separator()
            .hide()
            .separator()
            .quit()
            .build()?;

        let edit = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;

        MenuBuilder::new(app).items(&[&application, &edit]).build()
    }
}
