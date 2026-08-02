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
    let builder = tauri::Builder::default();

    // Only macOS gets a menu. On Windows and Linux an app has no menu bar
    // unless one is set, and setting one there would add a strip of chrome
    // whose only purpose is to take key bindings away from the editor.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build);

    builder
        .run(tauri::generate_context!())
        .expect("failed to start the vim-notes desktop shell");
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
