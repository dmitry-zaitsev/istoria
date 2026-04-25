pub mod cli;
pub mod event;
pub mod format;
pub mod ingest;
pub mod ipc;
pub mod ring;
pub mod state;

use std::io::IsTerminal;
use std::sync::Arc;
use std::time::Duration;

use tauri::Emitter;

use ipc::EventNewPayload;
use ring::Ring;
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(cli: cli::Cli) {
    init_tracing();

    if cli.clear {
        // M2: purge the DuckDB store. No-op for now.
    }

    let ring = Arc::new(Ring::from_env());
    let source = cli.name.clone().unwrap_or_else(|| "stdin".into());

    if !std::io::stdin().is_terminal() {
        let ring_for_ingest = Arc::clone(&ring);
        let tee = !cli.silent;
        let source_for_ingest = source.clone();
        tauri::async_runtime::spawn(async move {
            ingest::run_stdin_reader(ring_for_ingest, source_for_ingest, tee).await;
        });
    }

    let ring_for_emit = Arc::clone(&ring);

    tauri::Builder::default()
        .manage(AppState { ring })
        .invoke_handler(tauri::generate_handler![ipc::query_recent])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let ring = ring_for_emit;
            tauri::async_runtime::spawn(async move {
                loop {
                    ring.notified().await;
                    // Debounce: coalesce bursts within ~16 ms (one frame).
                    tokio::time::sleep(Duration::from_millis(16)).await;
                    let payload = EventNewPayload {
                        len: ring.len(),
                        dropped: ring.dropped_count(),
                    };
                    if app_handle.emit("event-new", payload).is_err() {
                        break;
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running istoria");
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            EnvFilter::try_from_env("ISTORIA_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .try_init();
}
