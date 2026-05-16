use std::path::PathBuf;
use std::sync::Arc;

use interprocess::local_socket::tokio::{prelude::*, Listener, Stream};
use interprocess::local_socket::{GenericFilePath, ListenerOptions, ToFsName};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::timeout;

use crate::coalesce::Coalescer;
use crate::event::Event;
use crate::format::Detector;
use crate::ring::Ring;
use crate::source;

const SOCKET_FILE: &str = "daemon.sock";
const DATA_DIR_NAME: &str = "istoria";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForwarderHeader {
    /// Optional `--name` from the forwarder. The owner resolves this
    /// against the live registry — sending the already-resolved name
    /// would mean every forwarder picks `pipe-1` independently.
    #[serde(default)]
    pub name_override: Option<String>,
    /// Branch label (git branch or folder name fallback) of the
    /// forwarder's cwd. Each forwarder lives in its own working
    /// directory, so the owner cannot derive this on its own.
    #[serde(default)]
    pub branch: String,
    pub pid: i32,
}

pub fn socket_path() -> PathBuf {
    if cfg!(target_os = "linux") {
        if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
            return PathBuf::from(dir).join("istoria.sock");
        }
    }
    let dirs = directories::ProjectDirs::from("", "", DATA_DIR_NAME)
        .expect("project dirs resolvable");
    let path = dirs.data_dir().join(SOCKET_FILE);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    path
}

/// Try to take ownership of the Unix socket. Returns the listener if
/// we became the owner, `None` if another live owner already holds
/// it. Stale sockets from crashed owners are cleaned up first.
pub fn try_bind(path: &std::path::Path) -> Option<Listener> {
    if path.exists() {
        // probe the existing socket: live owner accepts; stale one errors out.
        match std::os::unix::net::UnixStream::connect(path) {
            Ok(_) => return None,
            Err(_) => {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    let name = path.to_str()?.to_fs_name::<GenericFilePath>().ok()?;
    ListenerOptions::new().name(name).create_tokio().ok()
}

/// Connect to an existing owner. Used by forwarder dispatch.
pub async fn try_connect(path: &std::path::Path) -> Option<Stream> {
    let name = path.to_str()?.to_fs_name::<GenericFilePath>().ok()?;
    Stream::connect(name).await.ok()
}

/// Owner-side accept loop: each connection handled as a forwarder.
/// Header line first, then line-buffered events.
pub async fn run_owner_listener(
    listener: Listener,
    ring: Arc<Ring>,
    registry: Arc<source::Registry>,
) {
    loop {
        match listener.accept().await {
            Ok(stream) => {
                let ring = Arc::clone(&ring);
                let registry = Arc::clone(&registry);
                tokio::spawn(async move {
                    if let Err(e) = handle_forwarder(stream, ring, registry).await {
                        tracing::warn!(error = %e, "forwarder ended with error");
                    }
                });
            }
            Err(e) => {
                tracing::warn!(error = %e, "accept failed");
                break;
            }
        }
    }
}

async fn handle_forwarder(
    stream: Stream,
    ring: Arc<Ring>,
    registry: Arc<source::Registry>,
) -> std::io::Result<()> {
    let mut reader = BufReader::with_capacity(64 * 1024, stream);
    let mut header_line = String::new();
    let n = reader.read_line(&mut header_line).await?;
    if n == 0 {
        return Ok(());
    }
    let header: ForwarderHeader = serde_json::from_str(header_line.trim()).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, format!("bad header: {e}"))
    })?;
    let source_name = registry.allocate(header.name_override.as_deref());
    let branch = header.branch.clone();
    tracing::info!(name = %source_name, branch = %branch, pid = header.pid, "forwarder attached");

    let mut detector = Detector::new();
    let mut coalescer = Coalescer::new();
    let mut lines = reader.lines();
    loop {
        let read = if coalescer.has_pending() {
            match timeout(coalescer.idle(), lines.next_line()).await {
                Ok(r) => r,
                Err(_) => {
                    if let Some(ev) = coalescer.flush() {
                        emit(&ring, ev);
                    }
                    continue;
                }
            }
        } else {
            lines.next_line().await
        };

        match read {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                let ev = detector.parse(0, &source_name, &branch, line);
                if let Some(out) = coalescer.push(ev) {
                    emit(&ring, out);
                }
            }
            Ok(None) => {
                if let Some(ev) = coalescer.flush() {
                    emit(&ring, ev);
                }
                break;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn emit(ring: &Arc<Ring>, mut ev: Event) {
    if ev.msg.trim().is_empty() && ev.fields.is_none() && ev.raw.trim().is_empty() {
        return;
    }
    ev.id = ring.next_id();
    ring.push(ev);
}

/// Forwarder mode: connect to owner, send header, pipe stdin → owner.
/// Returns Ok on graceful EOF.
pub async fn run_forwarder(
    stream: Stream,
    name_override: Option<String>,
    branch: String,
) -> std::io::Result<()> {
    let mut writer = stream;
    let header = ForwarderHeader {
        name_override,
        branch,
        pid: std::process::id() as i32,
    };
    let mut header_bytes = serde_json::to_vec(&header).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode header: {e}"))
    })?;
    header_bytes.push(b'\n');
    writer.write_all(&header_bytes).await?;

    let stdin = tokio::io::stdin();
    let mut buf = BufReader::with_capacity(64 * 1024, stdin);
    let mut line = String::new();
    loop {
        line.clear();
        let n = buf.read_line(&mut line).await?;
        if n == 0 {
            break;
        }
        writer.write_all(line.as_bytes()).await?;
    }
    writer.flush().await?;
    Ok(())
}
