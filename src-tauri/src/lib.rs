pub mod alerts;
pub mod cli;
pub mod event;
pub mod format;
pub mod http;
pub mod ingest;
pub mod ipc;
pub mod persistence;
pub mod pins;
pub mod query;
pub mod ring;
pub mod socket;
pub mod source;
pub mod state;
pub mod views;

use std::io::IsTerminal;
use std::process;
use std::sync::Arc;
use std::time::Duration;

use tauri::Emitter;

use ipc::EventNewPayload;
use persistence::Store;
use ring::Ring;
use state::AppState;

/// Dispatch entry point. Three paths:
///  1. Stdin is a tty → owner mode, no ingest.
///  2. Stdin is piped, socket already owned → forwarder mode (no window).
///  3. Stdin is piped, no owner → owner mode + ingest stdin + listen.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(cli: cli::Cli) {
    init_tracing();

    let socket_path = socket::socket_path();
    let stdin_piped = !std::io::stdin().is_terminal();

    if stdin_piped {
        // Forwarder dispatch: try to attach to existing owner.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio rt");
        let connect = rt.block_on(socket::try_connect(&socket_path));
        if let Some(stream) = connect {
            let name = source::resolve(cli.name.as_deref(), &[]);
            tracing::info!(name = %name, "forwarder attached to existing istoria");
            let res = rt.block_on(socket::run_forwarder(stream, name));
            if let Err(e) = res {
                tracing::warn!(error = %e, "forwarder ended with error");
            }
            process::exit(0);
        }
    }

    let ring = Arc::new(Ring::from_env());
    let source_name = source::resolve(cli.name.as_deref(), &[]);

    let store = match Store::open_default(cli.clear) {
        Ok(s) => {
            let arc = Arc::new(s);
            if let Err(e) = views::seed_default(&arc) {
                tracing::warn!(error = %e, "could not seed default view");
            }
            Some(arc)
        }
        Err(e) => {
            tracing::warn!(error = %e, "DuckDB store unavailable; running in-memory only");
            None
        }
    };

    if stdin_piped {
        let ring_for_ingest = Arc::clone(&ring);
        let tee = !cli.silent;
        let source_for_ingest = source_name.clone();
        let store_for_ingest = store.clone();
        tauri::async_runtime::spawn(async move {
            ingest::run_stdin_reader(ring_for_ingest, store_for_ingest, source_for_ingest, tee)
                .await;
        });
    }

    let ring_for_socket = Arc::clone(&ring);
    let store_for_socket = store.clone();
    let socket_path_for_owner = socket_path.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(listener) = socket::try_bind(&socket_path_for_owner) {
            socket::run_owner_listener(listener, ring_for_socket, store_for_socket).await;
        } else {
            tracing::warn!("could not bind socket — multi-pipe forwarders disabled");
        }
    });

    let ring_for_http = Arc::clone(&ring);
    let store_for_http = store.clone();
    tauri::async_runtime::spawn(async move {
        http::run_server(ring_for_http, store_for_http).await;
    });

    let ring_for_emit = Arc::clone(&ring);

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(AppState { ring, store })
        .invoke_handler(tauri::generate_handler![
            ipc::query_recent,
            ipc::query_parse,
            ipc::views_list,
            ipc::views_create,
            ipc::views_update,
            ipc::views_delete,
            ipc::views_duplicate,
            ipc::meta_get,
            ipc::meta_set,
            ipc::pin_event,
            ipc::unpin_event,
            ipc::list_pins,
            ipc::alerts_list,
            ipc::alerts_create,
            ipc::alerts_update,
            ipc::alerts_delete,
            ipc::clear_session,
        ])
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
