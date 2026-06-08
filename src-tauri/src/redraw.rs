//! Graphics-context recovery for the macOS WKWebView.
//!
//! WKWebView renders out-of-process through Core Animation; its content
//! lives in an IOSurface-backed *remote* layer. When the window server
//! rebuilds the graphics context — system sleep/wake, **display** sleep/wake,
//! a monitor being connected/disconnected/rearranged, or the window moving
//! to a display with a different backing scale — that remote layer can keep
//! compositing the *previous* frame's glyphs. That is the doubled, ghosted
//! log text (see the prior `fix(logstream): …ghost…` attempts).
//!
//! The reason two earlier DOM-only fixes failed is the *trigger*, not the
//! repaint: on a plain display sleep→wake with an unchanged monitor layout
//! the page stays `visible`, the window keeps focus and size, and the scale
//! factor is unchanged — so `visibilitychange` / `focus` / `resize` /
//! `onScaleChanged` never fire and the JS `flush()` never runs. These events
//! ARE observable as native AppKit / `NSWorkspace` notifications, which is
//! why the authoritative fix lives here.
//!
//! On any such notification we force a full repaint by nudging the window
//! height down one physical pixel and restoring it a frame later: wry
//! re-lays-out the WKWebView to match, re-rendering the whole surface and
//! dropping the stale tile. We also emit `gfx-context-rebuilt` so the web
//! layer can flush its own subtree (belt-and-suspenders).

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    use tauri::{AppHandle, Emitter, Manager, PhysicalSize, Runtime, WebviewWindow};

    // Posted on the *default* NSNotificationCenter.
    const APP_NOTES: &[&str] = &[
        // Monitor connected/disconnected/rearranged, resolution change,
        // GPU reconfiguration. Fires on multi-display reconfigs.
        "NSApplicationDidChangeScreenParametersNotification",
        // This window moved to a display with a different backing scale
        // (e.g. Retina ⇄ non-Retina), or its colorspace changed.
        "NSWindowDidChangeBackingPropertiesNotification",
        // The window moved to a *different* screen (dragged between two
        // monitors, even same-DPI) — fires only on the actual change, not
        // per drag tick. Closes the same-DPI multi-monitor gap.
        "NSWindowDidChangeScreenNotification",
    ];
    // Posted on the *NSWorkspace* notification center (a separate center).
    const WORKSPACE_NOTES: &[&str] = &[
        "NSWorkspaceDidWakeNotification",        // system sleep → wake
        "NSWorkspaceScreensDidWakeNotification", // display sleep → wake
    ];

    // Coalesce a wake burst (DidWake + ScreensDidWake + ChangeScreenParameters
    // can all post within a few ms) into a single nudge.
    static NUDGING: AtomicBool = AtomicBool::new(false);

    pub fn install<R: Runtime>(app: &AppHandle<R>) {
        let handle = app.clone();
        // One block, reused for every observer — NSNotificationCenter
        // copies it on registration. The closure must never panic
        // (release builds are panic=abort); every call inside is
        // failure-tolerant.
        let block = RcBlock::new(move |_note: *mut AnyObject| trigger(&handle, false));

        // SAFETY: all receivers are live process singletons / classes, and
        // the block outlives registration because each center copies it.
        let register = |center: *mut AnyObject, name: &str| {
            if center.is_null() {
                return;
            }
            let ns_name = NSString::from_str(name);
            let nil: *mut AnyObject = std::ptr::null_mut();
            unsafe {
                let token: *mut AnyObject = msg_send![
                    center,
                    addObserverForName: &*ns_name,
                    object: nil,
                    queue: nil,
                    usingBlock: &*block
                ];
                // Hold the observer token for the whole app lifetime.
                let _: *mut AnyObject = msg_send![token, retain];
            }
        };

        let (default_center, ws_center) = unsafe {
            let default_center: *mut AnyObject =
                msg_send![class!(NSNotificationCenter), defaultCenter];
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            let ws_center: *mut AnyObject = msg_send![workspace, notificationCenter];
            (default_center, ws_center)
        };
        for name in APP_NOTES {
            register(default_center, name);
        }
        for name in WORKSPACE_NOTES {
            register(ws_center, name);
        }
        // `block` (our owning handle) may drop here; the centers retain
        // their own copies.
    }

    /// Run every repaint primitive we have. `hard` adds the visible
    /// hide/show cycle (one-frame flash) — reserved for the manual escape
    /// hatch where the user is actively clearing a stuck ghost.
    pub fn trigger<R: Runtime>(app: &AppHandle<R>, hard: bool) {
        // (Ⓐ/Ⓑ) Web-layer flush — subtree teardown + scroll-nudge. Invisible.
        let _ = app.emit("gfx-context-rebuilt", ());

        let Some(win) = app.get_webview_window("main") else {
            return;
        };

        // (Ⓓ/Ⓔ) Poke the WKWebView directly: invalidate its view + layer,
        // and on `hard`, hide/show to guarantee a full re-raster. Works
        // even in fullscreen/maximized (no window-size dependency).
        poke_webview(&win, hard);

        // (Ⓒ) Window 1px nudge — forces wry to re-lay-out the whole webview.
        // Skip when it would fight fullscreen/maximized; the paths above
        // already cover those.
        if win.is_fullscreen().unwrap_or(false) || win.is_maximized().unwrap_or(false) {
            return;
        }
        // Coalesce bursts; the deferred restore clears the flag.
        if NUDGING.swap(true, Ordering::SeqCst) {
            return;
        }
        let Ok(size) = win.inner_size() else {
            NUDGING.store(false, Ordering::SeqCst);
            return;
        };
        if size.height <= 2 {
            NUDGING.store(false, Ordering::SeqCst);
            return;
        }

        let restored = size;
        let nudged = PhysicalSize::new(size.width, size.height - 1);
        let _ = win.set_size(nudged);
        // Restore a frame later, so the shrunk size is realized and
        // rendered before we revert — that guarantees a fresh full repaint
        // at the original size. One physical pixel for ~40ms is invisible.
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(40)).await;
            let _ = win.set_size(restored);
            NUDGING.store(false, Ordering::SeqCst);
        });
    }

    /// Invalidate the WKWebView's view + layer; on `hard`, hide it and
    /// restore a frame later to force a guaranteed full re-raster. Runs on
    /// the UI thread via `with_webview`. Best-effort — any failure is a
    /// no-op (and it never panics; release builds are panic=abort).
    fn poke_webview<R: Runtime>(win: &WebviewWindow<R>, hard: bool) {
        let _ = win.with_webview(move |wv| {
            let view = wv.inner() as *mut AnyObject;
            if view.is_null() {
                return;
            }
            // SAFETY: `view` is the live WKWebView (an NSView subclass) and
            // this closure is dispatched onto the UI thread.
            unsafe {
                let _: () = msg_send![view, setNeedsDisplay: Bool::new(true)];
                let layer: *mut AnyObject = msg_send![view, layer];
                if !layer.is_null() {
                    let _: () = msg_send![layer, setNeedsDisplay];
                }
                if hard {
                    let _: () = msg_send![view, setHidden: Bool::new(true)];
                }
            }
        });
        if !hard {
            return;
        }
        // Un-hide a frame later (on the UI thread) so the hidden state is
        // realized first; the show then forces a clean full repaint.
        let win = win.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(33)).await;
            let _ = win.with_webview(|wv| {
                let view = wv.inner() as *mut AnyObject;
                if view.is_null() {
                    return;
                }
                // SAFETY: see above.
                unsafe {
                    let _: () = msg_send![view, setHidden: Bool::new(false)];
                }
            });
        });
    }
}

/// Install native observers that force a WKWebView repaint after a
/// graphics-context rebuild (sleep/wake, monitor or scale change). No-op
/// off macOS.
#[cfg(target_os = "macos")]
pub fn install_graphics_recovery<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    imp::install(app);
}

#[cfg(not(target_os = "macos"))]
pub fn install_graphics_recovery<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {}

/// Force an immediate WKWebView repaint on demand — used by the JS
/// wall-clock heartbeat (after a sleep/freeze) and the manual ⌘⇧R escape
/// hatch. `hard` adds a hide/show cycle (one-frame flash) for clearing a
/// stuck ghost. No-op off macOS.
#[cfg(target_os = "macos")]
pub fn force<R: tauri::Runtime>(app: &tauri::AppHandle<R>, hard: bool) {
    imp::trigger(app, hard);
}

#[cfg(not(target_os = "macos"))]
pub fn force<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, _hard: bool) {}
