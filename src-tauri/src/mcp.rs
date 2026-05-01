//! Local MCP (Model Context Protocol) server.
//!
//! Exposes a single HTTP endpoint that lets local agents (Claude Code,
//! Codex, …) query the running istoria session for log data. JSON-RPC 2.0
//! over HTTP per MCP's "Streamable HTTP" transport.
//!
//! Bound to 127.0.0.1 only — the logs are local data; treat this like the
//! existing `/ingest` server. No auth on top, no session management.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;

use crate::event::{Event, Level};
use crate::ring::Ring;

pub const DEFAULT_PORT: u16 = 8731;
const PROTOCOL_VERSION: &str = "2025-06-18";
const MAX_LIMIT: u64 = 5000;
const DEFAULT_LIMIT: u64 = 100;

#[derive(Clone)]
struct McpCtx {
    ring: Arc<Ring>,
}

#[derive(Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Serialize, Debug)]
struct JsonRpcError {
    code: i32,
    message: String,
}

pub async fn run_server(ring: Arc<Ring>) {
    let ctx = McpCtx { ring };
    let app = Router::new()
        .route("/mcp", post(handle_mcp))
        .with_state(ctx);

    let addr: SocketAddr = ([127, 0, 0, 1], DEFAULT_PORT).into();
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!(error = %e, port = DEFAULT_PORT, "could not bind MCP port");
            return;
        }
    };
    tracing::info!(port = DEFAULT_PORT, "MCP listening on 127.0.0.1:{DEFAULT_PORT}/mcp");
    if let Err(e) = axum::serve(listener, app).await {
        tracing::warn!(error = %e, "MCP server ended");
    }
}

async fn handle_mcp(
    State(ctx): State<McpCtx>,
    _headers: HeaderMap,
    Json(req): Json<JsonRpcRequest>,
) -> Response {
    if req.jsonrpc != "2.0" {
        return (StatusCode::BAD_REQUEST, "expected jsonrpc 2.0").into_response();
    }
    // Notifications (no id) — accept and return no body.
    let Some(id) = req.id.clone() else {
        return StatusCode::ACCEPTED.into_response();
    };

    let result = dispatch(&ctx, &req.method, req.params).await;
    let resp = match result {
        Ok(v) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(v),
            error: None,
        },
        Err(e) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(e),
        },
    };
    Json(resp).into_response()
}

async fn dispatch(
    ctx: &McpCtx,
    method: &str,
    params: Option<Value>,
) -> Result<Value, JsonRpcError> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "istoria",
                "version": env!("CARGO_PKG_VERSION"),
            },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_descriptors() })),
        "tools/call" => call_tool(ctx, params).await,
        // Optional surfaces — return empty so probing clients don't error.
        "prompts/list" => Ok(json!({ "prompts": [] })),
        "resources/list" => Ok(json!({ "resources": [] })),
        _ => Err(JsonRpcError {
            code: -32601,
            message: format!("method not found: {method}"),
        }),
    }
}

fn tool_descriptors() -> Value {
    json!([
        {
            "name": "query_logs",
            "description": "Query recent logs from the running istoria session. \
Returns most-recent-first events with id, timestamp, level, source, and message. \
Use `filter` for a case-insensitive substring match on the message text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filter": {
                        "type": "string",
                        "description": "Optional case-insensitive substring filter on message text."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max events to return (1..=5000).",
                        "default": DEFAULT_LIMIT,
                        "minimum": 1,
                        "maximum": MAX_LIMIT
                    }
                }
            }
        }
    ])
}

async fn call_tool(ctx: &McpCtx, params: Option<Value>) -> Result<Value, JsonRpcError> {
    let p = params.ok_or_else(|| JsonRpcError {
        code: -32602,
        message: "missing params".into(),
    })?;
    let name = p
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| JsonRpcError {
            code: -32602,
            message: "missing tool name".into(),
        })?;
    let args = p.get("arguments").cloned().unwrap_or(Value::Null);
    match name {
        "query_logs" => tool_query_logs(ctx, args),
        _ => Err(JsonRpcError {
            code: -32602,
            message: format!("unknown tool: {name}"),
        }),
    }
}

fn tool_query_logs(ctx: &McpCtx, args: Value) -> Result<Value, JsonRpcError> {
    let filter = args
        .get("filter")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT) as usize;
    let events = ctx.ring.snapshot(limit, filter.as_deref());
    Ok(json!({
        "content": [
            { "type": "text", "text": format_events(&events) }
        ]
    }))
}

fn format_events(events: &[Event]) -> String {
    if events.is_empty() {
        return "no events".to_string();
    }
    let mut out = String::with_capacity(events.len() * 96);
    out.push_str(&format!("{} events (most recent first)\n\n", events.len()));
    for e in events {
        out.push_str(&format!(
            "[{}] {} {:5} {}\n  {}\n",
            e.id,
            format_ts(e.ts),
            level_str(e.level),
            e.source,
            e.msg
        ));
    }
    out
}

fn level_str(l: Level) -> &'static str {
    match l {
        Level::Error => "error",
        Level::Warn => "warn",
        Level::Info => "info",
        Level::Debug => "debug",
        Level::Trace => "trace",
    }
}

fn format_ts(ms: i64) -> String {
    use chrono::{DateTime, Utc};
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339())
        .unwrap_or_else(|| ms.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_strings() {
        assert_eq!(level_str(Level::Error), "error");
        assert_eq!(level_str(Level::Info), "info");
    }

    #[test]
    fn format_events_empty() {
        assert_eq!(format_events(&[]), "no events");
    }

    #[test]
    fn format_events_includes_id_and_msg() {
        let e = Event::from_plain_line(42, "src", "boom".into());
        let s = format_events(&[e]);
        assert!(s.contains("[42]"));
        assert!(s.contains("boom"));
        assert!(s.contains("src"));
    }

    #[test]
    fn tool_descriptors_lists_query_logs() {
        let v = tool_descriptors();
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["name"], "query_logs");
    }

    #[tokio::test]
    async fn dispatch_initialize_includes_protocol_version() {
        let ctx = McpCtx { ring: Arc::new(Ring::new(8)) };
        let v = dispatch(&ctx, "initialize", None).await.unwrap();
        assert_eq!(v["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(v["serverInfo"]["name"], "istoria");
    }

    #[tokio::test]
    async fn dispatch_tools_list_returns_query_logs() {
        let ctx = McpCtx { ring: Arc::new(Ring::new(8)) };
        let v = dispatch(&ctx, "tools/list", None).await.unwrap();
        assert_eq!(v["tools"][0]["name"], "query_logs");
    }

    #[tokio::test]
    async fn dispatch_unknown_method_errors() {
        let ctx = McpCtx { ring: Arc::new(Ring::new(8)) };
        let err = dispatch(&ctx, "totally/madeup", None).await.unwrap_err();
        assert_eq!(err.code, -32601);
    }

    #[tokio::test]
    async fn tool_call_query_logs_returns_recorded_events() {
        let ring = Arc::new(Ring::new(8));
        ring.push(Event::from_plain_line(1, "src", "hello world".into()));
        ring.push(Event::from_plain_line(2, "src", "ERROR boom".into()));
        let ctx = McpCtx { ring };

        let params = json!({
            "name": "query_logs",
            "arguments": { "filter": "boom", "limit": 5 }
        });
        let v = dispatch(&ctx, "tools/call", Some(params)).await.unwrap();
        let text = v["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("ERROR boom"), "got: {text}");
        assert!(!text.contains("hello world"));
    }
}
