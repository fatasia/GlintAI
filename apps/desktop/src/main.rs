#[cfg(not(windows))]
compile_error!("This minimal Glint development host currently supports Windows only.");

mod job;
mod protocol;
mod service;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use tauri::{webview::NewWindowResponse, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

fn main() {
    if !cfg!(debug_assertions) {
        eprintln!("Glint desktop release build: needs GLINT_DESKTOP_REPO, GLINT_DESKTOP_NODE and GLINT_DESKTOP_TSX (the portable launcher sets them).");
    }
    let (stop_tx, stop_rx) = mpsc::channel();
    let finished = Arc::new(AtomicBool::new(false));
    let shutting_down = Arc::new(AtomicBool::new(false));
    let thread_finished = finished.clone();
    let app = tauri::Builder::default()
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let result = (|| {
                    let (mut service, ready) = service::Service::spawn(&data_dir)?;
                    let url = service.wait_ready(&ready, &stop_rx)?;
                    let owned = url.clone();
                    WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                        .title(if cfg!(debug_assertions) { "Glint — Development" } else { "Glint" })
                        .theme(Some(tauri::Theme::Dark))
                        .background_color(tauri::webview::Color(11, 15, 20, 255))
                        .inner_size(1440.0, 960.0).min_inner_size(800.0, 600.0)
                        .on_navigation(move |candidate| protocol::same_origin(candidate, &owned))
                        .on_new_window(|_, _| NewWindowResponse::Deny)
                        .disable_drag_drop_handler()
                        .build().map_err(|e| format!("Cannot create native WebView2 window: {e}. Verify the Microsoft Edge WebView2 runtime is installed."))?;
                    eprintln!("Glint desktop: native window created for owned loopback service");
                    service.monitor(&stop_rx)
                    // Service drops here: nonce shutdown + EOF, 3s grace, then kill/Job cleanup.
                })();
                let code = if let Err(error) = result {
                    eprintln!("Glint desktop: {error}");
                    1
                } else { 0 };
                thread_finished.store(true, Ordering::Release);
                handle.exit(code);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Cannot initialize Glint development host; verify Windows WebView2 runtime and app data access");
    app.run(move |_app, event| match event {
        RunEvent::ExitRequested { api, .. } if !finished.load(Ordering::Acquire) => {
            api.prevent_exit();
            if !shutting_down.swap(true, Ordering::AcqRel) {
                let _ = stop_tx.send(());
            }
        }
        RunEvent::Exit => {
            let _ = stop_tx.send(());
        }
        _ => {}
    });
}
