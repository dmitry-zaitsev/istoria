use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use tokio::net::TcpListener;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::event::{Event, Level};
use crate::persistence::Store;
use crate::ring::Ring;

const DEFAULT_PORT: u16 = 9787;
const PORT_FALLBACK_RANGE: u16 = 20;
const PORT_FILE: &str = "http.port";
const MAX_SOURCE_LEN: usize = 256;
const ALLOWED_ORIGIN_PREFIX: &str = "chrome-extension://";

#[derive(Clone)]
struct AppCtx {
    ring: Arc<Ring>,
    store: Option<Arc<Store>>,
}

#[derive(Deserialize)]
struct IngestBody {
    source: String,
    /// Optional branch label. External clients (browser extension)
    /// often have no git context; empty string is fine.
    #[serde(default)]
    branch: String,
    events: Vec<IngestEvent>,
}

#[derive(Deserialize)]
struct IngestEvent {
    #[serde(default)]
    ts: Option<i64>,
    #[serde(default)]
    level: Option<String>,
    text: String,
    #[serde(default)]
    meta: Option<serde_json::Value>,
}

pub async fn run_server(ring: Arc<Ring>, store: Option<Arc<Store>>) {
    let ctx = AppCtx { ring, store };

    // CORS preflight: only echo back chrome-extension:// origins.
    // A web page on https://evil.example sending application/json
    // triggers preflight; with no matching ACAO the browser drops
    // the actual POST. This is the first line of defence against
    // DNS rebinding + drive-by localhost POSTs.
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            origin
                .to_str()
                .map(|s| s.starts_with(ALLOWED_ORIGIN_PREFIX))
                .unwrap_or(false)
        }))
        .allow_methods([axum::http::Method::POST])
        .allow_headers([axum::http::header::CONTENT_TYPE]);

    let app = Router::new()
        .route("/ingest", post(ingest))
        .with_state(ctx)
        .layer(cors);

    let (listener, port) = match bind_with_fallback(DEFAULT_PORT).await {
        Some(x) => x,
        None => {
            tracing::warn!("could not bind any HTTP port for ingest");
            return;
        }
    };
    write_port_file(port);
    tracing::info!(port, "http ingest listening on 127.0.0.1:{port}");
    if let Err(e) = axum::serve(listener, app).await {
        tracing::warn!(error = %e, "http server ended");
    }
}

async fn bind_with_fallback(start: u16) -> Option<(TcpListener, u16)> {
    for offset in 0..PORT_FALLBACK_RANGE {
        let port = start.saturating_add(offset);
        let addr: SocketAddr = ([127, 0, 0, 1], port).into();
        if let Ok(listener) = TcpListener::bind(addr).await {
            return Some((listener, port));
        }
    }
    None
}

fn data_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("", "", crate::persistence::DB_DIR_NAME)
        .map(|d| d.data_dir().to_path_buf())
}

pub fn port_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join(PORT_FILE))
}

fn write_port_file(port: u16) {
    if let Some(dir) = data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(PORT_FILE), port.to_string());
    }
}

async fn ingest(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<IngestBody>,
) -> Result<StatusCode, StatusCode> {
    // Defence-in-depth: even if a non-browser client (curl, another
    // language) bypasses CORS, the Origin header check still gates
    // ingestion. Empty / mismatched Origin → reject.
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !is_allowed_origin(origin) {
        return Err(StatusCode::FORBIDDEN);
    }
    if body.source.is_empty() || body.source.len() > MAX_SOURCE_LEN {
        return Err(StatusCode::BAD_REQUEST);
    }
    for ev in body.events {
        let id = ctx.ring.next_id();
        let level = ev.level.as_deref().map(parse_level).unwrap_or(Level::Info);
        let raw = serde_json::to_string(&serde_json::json!({
            "ts": ev.ts,
            "level": ev.level,
            "text": ev.text,
            "meta": ev.meta,
        }))
        .unwrap_or_else(|_| ev.text.clone());
        let event = Event {
            id,
            ts: ev.ts.unwrap_or_else(now_unix_ms),
            source: body.source.clone(),
            branch: body.branch.clone(),
            level,
            msg: ev.text,
            raw,
            fields: ev.meta,
        };
        if let Some(s) = ctx.store.as_ref() {
            s.submit(event.clone());
        }
        ctx.ring.push(event);
    }
    Ok(StatusCode::ACCEPTED)
}

fn is_allowed_origin(origin: &str) -> bool {
    origin.starts_with(ALLOWED_ORIGIN_PREFIX)
}

fn parse_level(s: &str) -> Level {
    match s.to_ascii_lowercase().as_str() {
        "error" | "err" | "fatal" | "panic" | "crit" | "critical" => Level::Error,
        "warn" | "warning" => Level::Warn,
        "info" | "notice" | "log" => Level::Info,
        "debug" | "dbg" | "verbose" => Level::Debug,
        "trace" => Level::Trace,
        _ => Level::Info,
    }
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_level_maps_browser_levels() {
        assert_eq!(parse_level("error"), Level::Error);
        assert_eq!(parse_level("warning"), Level::Warn);
        assert_eq!(parse_level("log"), Level::Info);
        assert_eq!(parse_level("verbose"), Level::Debug);
        assert_eq!(parse_level("anything-else"), Level::Info);
    }

    #[test]
    fn allowed_origin_accepts_extension_only() {
        assert!(is_allowed_origin("chrome-extension://abcdef"));
        assert!(!is_allowed_origin(""));
        assert!(!is_allowed_origin("https://evil.example"));
        assert!(!is_allowed_origin("http://127.0.0.1:9787"));
        assert!(!is_allowed_origin("null"));
        assert!(!is_allowed_origin("file://"));
    }
}
