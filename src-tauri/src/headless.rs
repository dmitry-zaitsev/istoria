//! Headless entry point for the Electron shell.
//!
//! Same wiring as the Tauri app (`lib.rs::run`) — ring, stdin ingest, Unix
//! socket owner/forwarder, HTTP ingest, MCP, relevance engine — but with no
//! window and no WKWebView. Instead of Tauri `invoke`/`emit`, the frontend is
//! served over HTTP + SSE by `http_api`. Electron spawns this as a sidecar.

use std::io::{IsTerminal, Read};
use std::process;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast;

use crate::cli::Cli;
use crate::http_api::{self, ApiState, StreamMsg};
use crate::ring::Ring;
use crate::{code, ingest, mcp, relevance, socket, source};

pub fn run_headless(cli: Cli) {
    init_tracing();

    let socket_path = socket::socket_path();
    let stdin_piped = !std::io::stdin().is_terminal();
    // Electron spawns us as the GUI owner: force owner mode and never ingest
    // stdin (keeps stdout clean for the port handshake; logs arrive via the
    // `istoria` CLI over the socket and the browser extension over /ingest).
    let gui_owner = std::env::var_os("ISTORIA_GUI_OWNER").is_some();

    let branch = std::env::current_dir()
        .ok()
        .and_then(|p| source::derive_branch(&p))
        .unwrap_or_default();

    // Forwarder dispatch: a piped CLI invocation (`cmd | istoria`) attaches to
    // the running app and exits. Skipped for the GUI owner (it *is* the owner).
    //
    // If no owner is running we launch our own Electron app (the core lives
    // inside its .app bundle) and wait for its core to bind the socket, then
    // forward. This restores the Tauri UX where `cmd | istoria` opened the
    // window — the headless core has no window of its own, so it opens the app.
    if stdin_piped && !gui_owner {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio rt");
        let connected = rt.block_on(async {
            if let Some(s) = socket::try_connect(&socket_path).await {
                return Some(s);
            }
            if launch_app_bundle() {
                tracing::info!("no owner running — launching istoria app");
                for _ in 0..60 {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    if let Some(s) = socket::try_connect(&socket_path).await {
                        return Some(s);
                    }
                }
            }
            None
        });
        if let Some(stream) = connected {
            tracing::info!("forwarder attaching to istoria");
            if let Err(e) = rt.block_on(socket::run_forwarder(stream, cli.name.clone(), branch.clone())) {
                tracing::warn!(error = %e, "forwarder ended with error");
            }
            process::exit(0);
        }
        // Bare binary outside a bundle (e.g. dev), or the app never came up —
        // fall through to become a headless owner so piped logs aren't lost.
        tracing::warn!("no istoria window available — running as headless owner");
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio rt");

    rt.block_on(async move {
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
        let code_cache = Arc::new(code::CodeCache::new());
        let token = Arc::new(resolve_token());

        let project_root = std::env::current_dir().ok().and_then(|p| p.canonicalize().ok());
        if let Some(p) = project_root.as_ref() {
            tracing::info!(path = %p.display(), "project root captured");
        }

        // stdin ingest. Runs whenever stdin is piped — including the GUI owner,
        // so `logs | just dev` (Electron passes its piped stdin to the core)
        // streams straight into the window, matching the old `cmd | istoria`
        // Tauri behavior. Launched-from-Finder stdin is /dev/null → immediate EOF.
        if stdin_piped {
            if let Some(p) = project_root.as_ref() {
                source_roots.register(&source_name, p.clone());
            }
            let ring_i = Arc::clone(&ring);
            let tee = !cli.silent;
            let src = source_name.clone();
            let br = branch.clone();
            tokio::spawn(async move {
                ingest::run_stdin_reader(ring_i, src, br, tee).await;
            });
        }

        // Unix socket owner listener (multi-pipe forwarders).
        {
            let ring_s = Arc::clone(&ring);
            let reg_s = Arc::clone(&registry);
            let roots_s = Arc::clone(&source_roots);
            let sp = socket_path.clone();
            tokio::spawn(async move {
                if let Some(listener) = socket::try_bind(&sp) {
                    socket::run_owner_listener(listener, ring_s, reg_s, roots_s).await;
                } else {
                    tracing::warn!("could not bind socket — multi-pipe forwarders disabled");
                }
            });
        }

        // MCP server.
        {
            let ring_m = Arc::clone(&ring);
            tokio::spawn(async move {
                mcp::run_server(ring_m).await;
            });
        }

        let (tx, _rx) = broadcast::channel::<StreamMsg>(1024);

        // event-new emitter + relevance consider drain (mirrors lib.rs setup).
        {
            let ring2 = Arc::clone(&ring);
            let rel2 = Arc::clone(&relevance_engine);
            let tx_a = tx.clone();
            let mut last_id_consumed: u64 = 0;
            tokio::spawn(async move {
                loop {
                    ring2.notified().await;
                    tokio::time::sleep(Duration::from_millis(16)).await;
                    let _ = tx_a.send(StreamMsg::EventNew {
                        len: ring2.len(),
                        dropped: ring2.dropped_count(),
                    });
                    let new_events = ring2.snapshot_since(last_id_consumed, 10_000);
                    if let Some(last) = new_events.last() {
                        last_id_consumed = last.id;
                    }
                    if !new_events.is_empty() {
                        let rel = Arc::clone(&rel2);
                        tokio::task::spawn_blocking(move || {
                            for ev in new_events {
                                rel.consider(&ev);
                            }
                        });
                    }
                }
            });
        }

        // relevance-updated debounced emitter.
        {
            let (sig_tx, mut sig_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
            relevance_engine.set_emit(move || {
                let _ = sig_tx.send(());
            });
            let tx_b = tx.clone();
            tokio::spawn(async move {
                loop {
                    if sig_rx.recv().await.is_none() {
                        break;
                    }
                    tokio::time::sleep(relevance::emit_debounce()).await;
                    while sig_rx.try_recv().is_ok() {}
                    let _ = tx_b.send(StreamMsg::RelevanceUpdated);
                }
            });
        }

        // 15s pattern recompute poll.
        {
            let rel3 = Arc::clone(&relevance_engine);
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(relevance::recompute_interval()).await;
                    let rel = Arc::clone(&rel3);
                    tokio::task::spawn_blocking(move || rel.force_recompute_all());
                }
            });
        }

        let state = ApiState {
            ring: Arc::clone(&ring),
            code_cache,
            relevance: Arc::clone(&relevance_engine),
            source_registry: Arc::clone(&registry),
            project_root: project_root.map(Arc::new),
            token,
            tx,
        };

        // Blocks forever serving the API + SSE.
        http_api::serve(state).await;
    });
}

/// Launch the Electron app bundle this core lives inside (…/istoria.app) via
/// `open`. Returns true if a bundle was found and launch was attempted; false
/// when running the bare binary (dev), so the caller falls back to headless.
fn launch_app_bundle() -> bool {
    let Some(exe) = std::env::current_exe().ok().and_then(|p| p.canonicalize().ok()) else {
        return false;
    };
    let app = exe
        .ancestors()
        .find(|a| a.extension().map(|e| e == "app").unwrap_or(false));
    if let Some(app) = app {
        let _ = std::process::Command::new("open").arg(app).spawn();
        true
    } else {
        false
    }
}

/// Bearer token: from Electron (`ISTORIA_TOKEN`) or a local random fallback.
fn resolve_token() -> String {
    if let Ok(t) = std::env::var("ISTORIA_TOKEN") {
        if !t.is_empty() {
            return t;
        }
    }
    let mut buf = [0u8; 16];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .is_ok()
    {
        return buf.iter().map(|b| format!("{b:02x}")).collect();
    }
    format!("istoria-{}", process::id())
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
