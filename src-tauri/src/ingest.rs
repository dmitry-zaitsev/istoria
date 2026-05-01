use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::timeout;

use crate::coalesce::Coalescer;
use crate::event::Event;
use crate::format::Detector;
use crate::persistence::Store;
use crate::ring::Ring;

/// Read stdin line-by-line, push each into the ring buffer.
/// If `tee` is true, also forward each raw line to stdout so the user
/// continues to see logs in their terminal. A per-source `Detector`
/// sniffs the first ~20 lines to pick JSON vs plain. A `Coalescer`
/// folds indented continuations (stack frames, multi-line plain
/// blocks) into the preceding head event.
pub async fn run_stdin_reader(
    ring: Arc<Ring>,
    store: Option<Arc<Store>>,
    source: String,
    branch: String,
    tee: bool,
) {
    let stdin = BufReader::with_capacity(64 * 1024, tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();
    let mut detector = Detector::new();
    let mut coalescer = Coalescer::new();

    loop {
        let read = if coalescer.has_pending() {
            match timeout(coalescer.idle(), lines.next_line()).await {
                Ok(r) => r,
                Err(_) => {
                    if let Some(ev) = coalescer.flush() {
                        emit(&ring, &store, ev);
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
                let ev = detector.parse(0, &source, &branch, line);
                if let Some(out) = coalescer.push(ev) {
                    emit(&ring, &store, out);
                }
            }
            Ok(None) => {
                if let Some(ev) = coalescer.flush() {
                    emit(&ring, &store, ev);
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

fn emit(ring: &Arc<Ring>, store: &Option<Arc<Store>>, mut ev: Event) {
    if ev.msg.trim().is_empty() && ev.fields.is_none() && ev.raw.trim().is_empty() {
        return;
    }
    ev.id = ring.next_id();
    if let Some(s) = store.as_ref() {
        s.submit(ev.clone());
    }
    ring.push(ev);
}
