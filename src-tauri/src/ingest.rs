use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::timeout;

use crate::coalesce::Coalescer;
use crate::event::Event;
use crate::format::Detector;
use crate::json_lines::JsonLines;
use crate::ring::Ring;

/// Read stdin line-by-line, push each into the ring buffer.
/// If `tee` is true, also forward each raw line to stdout so the user
/// continues to see logs in their terminal. A per-source `Detector`
/// sniffs the first ~20 lines to pick JSON vs plain. A `Coalescer`
/// folds indented continuations (stack frames, multi-line plain
/// blocks) into the preceding head event.
pub async fn run_stdin_reader(
    ring: Arc<Ring>,
    source: String,
    branch: String,
    tee: bool,
) {
    let stdin = BufReader::with_capacity(64 * 1024, tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();
    let mut detector = Detector::new();
    let mut coalescer = Coalescer::new();
    let mut json_lines = JsonLines::new();

    loop {
        let pending = coalescer.has_pending() || json_lines.has_pending();
        let read = if pending {
            match timeout(coalescer.idle(), lines.next_line()).await {
                Ok(r) => r,
                Err(_) => {
                    for raw in json_lines.flush() {
                        let ev = detector.parse(0, &source, &branch, raw);
                        if let Some(out) = coalescer.push(ev) {
                            emit(&ring, out);
                        }
                    }
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
                if tee {
                    let _ = stdout.write_all(line.as_bytes()).await;
                    let _ = stdout.write_all(b"\n").await;
                }
                if line.trim().is_empty() {
                    continue;
                }
                for raw in json_lines.push(line) {
                    let ev = detector.parse(0, &source, &branch, raw);
                    if let Some(out) = coalescer.push(ev) {
                        emit(&ring, out);
                    }
                }
            }
            Ok(None) => {
                for raw in json_lines.flush() {
                    let ev = detector.parse(0, &source, &branch, raw);
                    if let Some(out) = coalescer.push(ev) {
                        emit(&ring, out);
                    }
                }
                if let Some(ev) = coalescer.flush() {
                    emit(&ring, ev);
                }
                break;
            }
            Err(e) => {
                tracing::warn!(error = %e, "stdin read error");
                break;
            }
        }
    }
    let _ = stdout.flush().await;
    tracing::info!(
        events = ring.len(),
        dropped = ring.dropped_count(),
        format = ?detector.locked_format(),
        "stdin closed"
    );
}

fn emit(ring: &Arc<Ring>, ev: Event) {
    if ev.msg.trim().is_empty() && ev.fields.is_none() && ev.raw.trim().is_empty() {
        return;
    }
    // `append` stamps the id under the deque lock so concurrent sources can't
    // reorder the ring (see Ring::append).
    ring.append(ev);
}
