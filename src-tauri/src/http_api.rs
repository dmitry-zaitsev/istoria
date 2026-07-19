//! Combined HTTP + SSE API for the Electron shell.
//!
//! This is the headless equivalent of the Tauri IPC surface (`ipc.rs`): every
//! route calls the exact same ring/code/relevance logic the Tauri commands
//! call — only the transport changes (Tauri `invoke`/`emit` → HTTP + SSE). It
//! also carries the browser-extension `/ingest` route (previously in `http.rs`)
//! so the whole app talks to one loopback origin.
//!
//! Security: every route except `/ingest` requires a per-launch bearer token
//! (Electron generates it, passes it to this process via env, and hands it to
//! the renderer via preload). Loopback + token gates the log data and, more
//! importantly, `/code/*` which reads local source files. `/ingest` keeps its
//! own `chrome-extension://` origin check.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::{
    extract::{Path, Query, Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::code::{self, CodeLine, EditorEntry, EmissionSite};
use crate::event::{Event, Level};
use crate::query::{self, Ast};
use crate::relevance::{RelevanceEngine, RelevanceSnapshot};
use crate::ring::Ring;
use crate::source;

const DEFAULT_PORT: u16 = 9787;
const PORT_FALLBACK_RANGE: u16 = 20;
const PORT_FILE: &str = "http.port";
const DATA_DIR_NAME: &str = "istoria";
const MAX_SOURCE_LEN: usize = 256;
const ALLOWED_ORIGIN_PREFIX: &str = "chrome-extension://";

/// Push messages fanned out to every open `/stream` (SSE) subscriber. The
/// headless emitter loops send these; the SSE handler forwards them as named
/// events the frontend's `subscribeEvents` / `subscribeRelevance` listen for.
#[derive(Clone, Debug)]
pub enum StreamMsg {
    EventNew { len: usize, dropped: u64 },
    RelevanceUpdated,
}

#[derive(Clone)]
pub struct ApiState {
    pub ring: Arc<Ring>,
    pub code_cache: Arc<code::CodeCache>,
    pub relevance: Arc<RelevanceEngine>,
    pub source_registry: Arc<source::Registry>,
    pub project_root: Option<Arc<PathBuf>>,
    pub token: Arc<String>,
    pub tx: broadcast::Sender<StreamMsg>,
}

/// Bind the loopback server and serve until it dies. Prints
/// `ISTORIA_HTTP_PORT=<port>` to stderr once bound so the Electron parent can
/// discover the port, and writes the same port file the CLI uses.
pub async fn serve(state: ApiState) {
    let cors = CorsLayer::new()
        // Loopback + bearer token is the real gate; allow any origin so the
        // Electron renderer (dev: http://localhost:1420, prod: file:// → null)
        // can call the API. `/ingest` keeps its server-side origin check below.
        .allow_origin(AllowOrigin::any())
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);

    let app = Router::new()
        .route("/ingest", post(ingest))
        .route("/query/recent", get(query_recent))
        .route("/query/since", get(query_since))
        .route("/query/parse", post(query_parse))
        .route("/pins", get(list_pins).post(pin_event))
        .route("/pins/:id", delete(unpin_event))
        .route("/code/preview", get(get_code_preview))
        .route("/code/emission-site", get(get_emission_site))
        .route("/relevance/snapshot", get(relevance_snapshot))
        .route("/session/clear", post(clear_session))
        .route("/editors", get(list_editors))
        .route("/open-url", post(open_url))
        .route("/open-terminal", post(open_terminal))
        .route("/mcp/port", get(mcp_port))
        .route("/focus", post(focus_changed))
        .route("/claude/status", get(claude_status))
        .route("/codex/status", get(codex_status))
        .route("/update/check", get(check_for_updates))
        .route("/install-method", get(detect_install_method))
        .route("/cli-link", get(cli_link_status))
        .route("/cli-link/install", post(install_cli_link))
        .route("/stream", get(stream))
        .layer(middleware::from_fn_with_state(state.clone(), require_token))
        .layer(cors)
        .with_state(state);

    let (listener, port) = match bind_with_fallback(DEFAULT_PORT).await {
        Some(x) => x,
        None => {
            tracing::error!("could not bind any HTTP port for the API");
            return;
        }
    };
    write_port_file(port);
    // Handshake line for the Electron parent (stderr — stdout may carry teed logs).
    eprintln!("ISTORIA_HTTP_PORT={port}");
    tracing::info!(port, "api listening on 127.0.0.1:{port}");
    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!(error = %e, "api server ended");
    }
}

/// Token gate for every route except `/ingest` (extension, origin-checked) and
/// CORS preflight. Accepts the token as `Authorization: Bearer <t>` (fetch) or
/// `?token=<t>` (EventSource, which can't set headers).
async fn require_token(State(state): State<ApiState>, req: Request, next: Next) -> Response {
    if req.method() == Method::OPTIONS || req.uri().path() == "/ingest" {
        return next.run(req).await;
    }
    let from_header = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned);
    let from_query = req
        .uri()
        .query()
        .and_then(|q| query_param(q, "token"));
    let provided = from_header.or(from_query);
    if provided.as_deref() == Some(state.token.as_str()) {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, "invalid token").into_response()
    }
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        if it.next() == Some(key) {
            let raw = it.next().unwrap_or("");
            return Some(percent_decode(raw));
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    // Minimal decode: token is url-safe hex, but handle %XX + '+' anyway.
    let bytes = s.replace('+', " ");
    let bytes = bytes.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&String::from_utf8_lossy(&bytes[i + 1..i + 3]), 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---- query -----------------------------------------------------------------

#[derive(Deserialize)]
struct RecentParams {
    limit: usize,
    #[serde(default)]
    filter: Option<String>,
}

async fn query_recent(
    State(st): State<ApiState>,
    Query(p): Query<RecentParams>,
) -> Json<Vec<Event>> {
    Json(st.ring.snapshot(p.limit, p.filter.as_deref()))
}

#[derive(Deserialize)]
struct SinceParams {
    last_id: u64,
    limit: usize,
}

#[derive(Serialize)]
struct QuerySincePayload {
    events: Vec<Event>,
    min_id: Option<u64>,
    len: usize,
}

async fn query_since(
    State(st): State<ApiState>,
    Query(p): Query<SinceParams>,
) -> Json<QuerySincePayload> {
    let events = st.ring.snapshot_since(p.last_id, p.limit);
    Json(QuerySincePayload {
        events,
        min_id: st.ring.min_id(),
        len: st.ring.len(),
    })
}

#[derive(Deserialize)]
struct ParseBody {
    input: String,
}

#[derive(Serialize)]
struct ParseResult {
    ast: Option<Ast>,
    error: Option<String>,
}

async fn query_parse(Json(body): Json<ParseBody>) -> Json<ParseResult> {
    Json(match query::parse(&body.input) {
        Ok(ast) => ParseResult { ast: Some(ast), error: None },
        Err(e) => ParseResult { ast: None, error: Some(e.message) },
    })
}

// ---- pins ------------------------------------------------------------------

#[derive(Deserialize)]
struct PinBody {
    event_id: i64,
}

async fn pin_event(State(st): State<ApiState>, Json(body): Json<PinBody>) -> StatusCode {
    st.ring.pin(body.event_id);
    StatusCode::NO_CONTENT
}

async fn unpin_event(State(st): State<ApiState>, Path(id): Path<i64>) -> StatusCode {
    st.ring.unpin(id);
    StatusCode::NO_CONTENT
}

async fn list_pins(State(st): State<ApiState>) -> Json<Vec<i64>> {
    Json(st.ring.list_pins())
}

// ---- code ------------------------------------------------------------------

fn project_root_or_err(st: &ApiState) -> Result<&FsPath, (StatusCode, String)> {
    st.project_root
        .as_deref()
        .map(|p| p.as_path())
        .ok_or((StatusCode::BAD_REQUEST, "project root unavailable".into()))
}

#[derive(Deserialize)]
struct PreviewParams {
    path: String,
    line: u32,
    context: u32,
}

async fn get_code_preview(
    State(st): State<ApiState>,
    Query(p): Query<PreviewParams>,
) -> Result<Json<Vec<CodeLine>>, (StatusCode, String)> {
    let root = project_root_or_err(&st)?;
    code::read_slice(root, &p.path, p.line, p.context)
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

#[derive(Deserialize)]
struct EmissionParams {
    msg: String,
}

async fn get_emission_site(
    State(st): State<ApiState>,
    Query(p): Query<EmissionParams>,
) -> Result<Json<Option<EmissionSite>>, (StatusCode, String)> {
    let root = project_root_or_err(&st)?;
    let cache = Arc::clone(&st.code_cache);
    let Some((path, line)) = code::find_emission_site(root, &cache, &p.msg)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?
    else {
        return Ok(Json(None));
    };
    let preview =
        code::read_slice(root, path.to_str().unwrap_or_default(), line, 2).unwrap_or_default();
    let is_local = code::is_local_change(root, &cache, &path, line);
    let rel_path = path
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned());
    Ok(Json(Some(EmissionSite {
        path: path.to_string_lossy().into_owned(),
        rel_path,
        line,
        preview,
        is_local,
    })))
}

// ---- relevance / session ---------------------------------------------------

async fn relevance_snapshot(State(st): State<ApiState>) -> Json<RelevanceSnapshot> {
    let engine = Arc::clone(&st.relevance);
    let snap = tokio::task::spawn_blocking(move || engine.snapshot())
        .await
        .unwrap_or(RelevanceSnapshot { ids: Vec::new(), sites: Vec::new() });
    Json(snap)
}

async fn clear_session(State(st): State<ApiState>) -> StatusCode {
    st.ring.clear();
    st.source_registry.reset();
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
struct FocusBody {
    focused: bool,
}

async fn focus_changed(State(st): State<ApiState>, Json(body): Json<FocusBody>) -> StatusCode {
    if body.focused {
        let engine = Arc::clone(&st.relevance);
        tokio::task::spawn_blocking(move || engine.force_recompute_all());
    }
    StatusCode::NO_CONTENT
}

// ---- editors / shell -------------------------------------------------------

async fn list_editors() -> Json<Vec<EditorEntry>> {
    Json(code::list_installed_editors())
}

#[derive(Deserialize)]
struct OpenUrlBody {
    url: String,
}

async fn open_url(Json(body): Json<OpenUrlBody>) -> Result<StatusCode, (StatusCode, String)> {
    let allowed = code::allowed_schemes();
    if !allowed.iter().any(|p| body.url.starts_with(p)) {
        return Err((StatusCode::BAD_REQUEST, format!("scheme not allowed: {}", body.url)));
    }
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "start"
    } else {
        "xdg-open"
    };
    std::process::Command::new(cmd)
        .arg(&body.url)
        .spawn()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct OpenTerminalBody {
    command: String,
}

async fn open_terminal(
    Json(body): Json<OpenTerminalBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    if body.command.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "empty command".into()));
    }
    #[cfg(target_os = "macos")]
    {
        let escaped = body.command.replace('\\', "\\\\").replace('"', "\\\"");
        let do_script = format!("tell application \"Terminal\" to do script \"{}\"", escaped);
        let activate = "tell application \"Terminal\" to activate".to_string();
        std::process::Command::new("osascript")
            .args(["-e", &do_script, "-e", &activate])
            .spawn()
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        return Ok(StatusCode::NO_CONTENT);
    }
    #[allow(unreachable_code)]
    Err((StatusCode::NOT_IMPLEMENTED, "unsupported platform".into()))
}

async fn mcp_port() -> Json<u16> {
    Json(crate::mcp::DEFAULT_PORT)
}

// ---- status / update / cli-link (reuse the pure logic) ---------------------

async fn claude_status() -> Json<crate::claude::ClaudeStatus> {
    Json(crate::claude::detect())
}

async fn codex_status() -> Json<crate::claude::ClaudeStatus> {
    Json(crate::claude::detect_codex())
}

async fn check_for_updates() -> Result<Json<crate::update::UpdateInfo>, (StatusCode, String)> {
    crate::update::check_for_updates()
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}

async fn detect_install_method() -> Json<crate::update::InstallMethod> {
    Json(crate::update::detect_install_method())
}

async fn cli_link_status() -> Json<crate::cli_link::CliLinkStatus> {
    Json(crate::cli_link::cli_link_status())
}

async fn install_cli_link() -> Result<StatusCode, (StatusCode, String)> {
    crate::cli_link::install_cli_link()
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

// ---- SSE stream ------------------------------------------------------------

async fn stream(State(st): State<ApiState>) -> Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>> {
    let rx = st.tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|res| res.ok()).map(|msg| {
        let ev = match msg {
            StreamMsg::EventNew { len, dropped } => SseEvent::default()
                .event("event-new")
                .json_data(serde_json::json!({ "len": len, "dropped": dropped }))
                .unwrap_or_else(|_| SseEvent::default().event("event-new").data("{}")),
            StreamMsg::RelevanceUpdated => {
                SseEvent::default().event("relevance-updated").data("{}")
            }
        };
        Ok(ev)
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ---- ingest (browser extension) — origin-checked, no token -----------------

#[derive(Deserialize)]
struct IngestBody {
    source: String,
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

async fn ingest(
    State(st): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<IngestBody>,
) -> Result<StatusCode, StatusCode> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !origin.starts_with(ALLOWED_ORIGIN_PREFIX) {
        return Err(StatusCode::FORBIDDEN);
    }
    if body.source.is_empty() || body.source.len() > MAX_SOURCE_LEN {
        return Err(StatusCode::BAD_REQUEST);
    }
    for ev in body.events {
        let level = ev.level.as_deref().map(parse_level).unwrap_or(Level::Info);
        let raw = serde_json::to_string(&serde_json::json!({
            "ts": ev.ts,
            "level": ev.level,
            "text": ev.text,
            "meta": ev.meta,
        }))
        .unwrap_or_else(|_| ev.text.clone());
        st.ring.append(Event {
            // Placeholder — `append` stamps the real id under the deque lock so
            // concurrent extension POSTs can't reorder the ring (see Ring::append).
            id: 0,
            ts: ev.ts.unwrap_or_else(now_unix_ms),
            source: body.source.clone(),
            branch: body.branch.clone(),
            level,
            msg: ev.text,
            raw,
            fields: ev.meta,
        });
    }
    Ok(StatusCode::ACCEPTED)
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

// ---- port binding ----------------------------------------------------------

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
    directories::ProjectDirs::from("", "", DATA_DIR_NAME).map(|d| d.data_dir().to_path_buf())
}

fn write_port_file(port: u16) {
    if let Some(dir) = data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(PORT_FILE), port.to_string());
    }
}
