pub mod claude;
pub mod cli;
pub mod cli_link;
pub mod coalesce;
pub mod code;
pub mod event;
pub mod format;
pub mod http;
pub mod ingest;
pub mod ipc;
pub mod json_lines;
pub mod mcp;
pub mod query;
pub mod relevance;
pub mod ring;
pub mod socket;
pub mod source;
pub mod state;
pub mod transformers;
pub mod update;

use std::io::IsTerminal;
use std::process;
use std::sync::Arc;
use std::time::Duration;

use tauri::Emitter;

use ipc::EventNewPayload;
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

    // Derive branch label from the *invocation* cwd: every forwarder
    // runs in its own dir, so this must be done before forwarder
    // dispatch swaps us into the owner's working directory.
    let branch = std::env::current_dir()
        .ok()
        .and_then(|p| source::derive_branch(&p))
        .unwrap_or_default();

    if stdin_piped {
        // Forwarder dispatch: try to attach to existing owner.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio rt");
        let connect = rt.block_on(socket::try_connect(&socket_path));
        if let Some(stream) = connect {
            tracing::info!("forwarder attaching to existing istoria");
            let res = rt.block_on(socket::run_forwarder(
                stream,
                cli.name.clone(),
                branch.clone(),
            ));
            if let Err(e) = res {
                tracing::warn!(error = %e, "forwarder ended with error");
            }
            process::exit(0);
        }
    }

    let ring = Arc::new(Ring::from_env());
    let registry = Arc::new(source::Registry::new());
    let source_roots = Arc::new(relevance::SourceRoots::new());
    let pattern_cache = Arc::new(relevance::PatternCache::new());
    let relevance_engine = Arc::new(relevance::RelevanceEngine::new(
        Arc::clone(&source_roots),
        Arc::clone(&pattern_cache),
        Arc::clone(&ring),
    ));
    let source_name = registry.allocate(cli.name.as_deref());

    if stdin_piped {
        let ring_for_ingest = Arc::clone(&ring);
        let tee = !cli.silent;
        let source_for_ingest = source_name.clone();
        let branch_for_ingest = branch.clone();
        tauri::async_runtime::spawn(async move {
            ingest::run_stdin_reader(
                ring_for_ingest,
                source_for_ingest,
                branch_for_ingest,
                tee,
            )
            .await;
        });
    }

    let ring_for_socket = Arc::clone(&ring);
    let registry_for_socket = Arc::clone(&registry);
    let socket_path_for_owner = socket_path.clone();
    let roots_for_socket = Arc::clone(&source_roots);
    tauri::async_runtime::spawn(async move {
        if let Some(listener) = socket::try_bind(&socket_path_for_owner) {
            socket::run_owner_listener(
                listener,
                ring_for_socket,
                registry_for_socket,
                roots_for_socket,
            )
            .await;
        } else {
            tracing::warn!("could not bind socket — multi-pipe forwarders disabled");
        }
    });

    let ring_for_http = Arc::clone(&ring);
    tauri::async_runtime::spawn(async move {
        http::run_server(ring_for_http).await;
    });

    let ring_for_mcp = Arc::clone(&ring);
    tauri::async_runtime::spawn(async move {
        mcp::run_server(ring_for_mcp).await;
    });

    let ring_for_emit = Arc::clone(&ring);

    let project_root = std::env::current_dir()
        .ok()
        .and_then(|p| p.canonicalize().ok());
    if let Some(p) = project_root.as_ref() {
        tracing::info!(path = %p.display(), "project root captured");
        // The owner stdin source (if any) lives at the owner's cwd.
        // Forwarders register their own cwd via the socket header.
        if stdin_piped {
            source_roots.register(&source_name, p.clone());
        }
    }
    let code_cache = Arc::new(code::CodeCache::new());

    let relevance_for_emit = Arc::clone(&relevance_engine);
    let relevance_for_poll = Arc::clone(&relevance_engine);

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            ring,
            project_root,
            code_cache,
            source_registry: registry,
            source_roots,
            pattern_cache,
            relevance: Arc::clone(&relevance_engine),
        })
        .invoke_handler(tauri::generate_handler![
            ipc::query_recent,
            ipc::query_since,
            ipc::query_parse,
            ipc::pin_event,
            ipc::unpin_event,
            ipc::list_pins,
            ipc::get_code_preview,
            ipc::get_emission_site,
            ipc::list_editors,
            ipc::open_url,
            ipc::clear_session,
            ipc::mcp_port,
            ipc::open_terminal,
            ipc::relevance_snapshot,
            ipc::focus_changed,
            claude::claude_status,
            claude::codex_status,
            update::check_for_updates,
            update::detect_install_method,
            cli_link::cli_link_status,
            cli_link::install_cli_link,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let ring = ring_for_emit;
            // ring → "event-new" + relevance consider
            let app_for_event = app_handle.clone();
            let relevance_for_consider = Arc::clone(&relevance_for_emit);
            let ring_for_consider = Arc::clone(&ring);
            let mut last_id_consumed: u64 = 0;
            tauri::async_runtime::spawn(async move {
                loop {
                    ring.notified().await;
                    tokio::time::sleep(Duration::from_millis(16)).await;
                    let payload = EventNewPayload {
                        len: ring.len(),
                        dropped: ring.dropped_count(),
                    };
                    if app_for_event.emit("event-new", payload).is_err() {
                        break;
                    }
                    // Drain newly arrived events into relevance worker.
                    // Bounded per-tick scan: snapshot_since uses
                    // last_id_consumed as cursor, returns events with
                    // id > cursor.
                    let new_events = ring_for_consider.snapshot_since(last_id_consumed, 10_000);
                    if let Some(last) = new_events.last() {
                        last_id_consumed = last.id;
                    }
                    let rel = Arc::clone(&relevance_for_consider);
                    if !new_events.is_empty() {
                        tauri::async_runtime::spawn_blocking(move || {
                            for ev in new_events {
                                rel.consider(&ev);
                            }
                        });
                    }
                }
            });

            // relevance-updated debounced emitter
            let app_for_relevance = app_handle.clone();
            let relevance_for_setemit = Arc::clone(&relevance_for_emit);
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
            relevance_for_setemit.set_emit(move || {
                let _ = tx.send(());
            });
            tauri::async_runtime::spawn(async move {
                loop {
                    if rx.recv().await.is_none() {
                        break;
                    }
                    // Coalesce a burst.
                    tokio::time::sleep(relevance::emit_debounce()).await;
                    while rx.try_recv().is_ok() {}
                    if app_for_relevance
                        .emit("relevance-updated", ())
                        .is_err()
                    {
                        break;
                    }
                }
            });

            // 15s polling task: recompute patterns per registered root.
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(relevance::recompute_interval()).await;
                    let rel = Arc::clone(&relevance_for_poll);
                    tauri::async_runtime::spawn_blocking(move || {
                        rel.force_recompute_all();
                    });
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
