use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::format::Detector;
use crate::ring::Ring;

/// Read stdin line-by-line, push each into the ring buffer.
/// If `tee` is true, also forward each line to stdout so the user
/// continues to see logs in their terminal. A per-source `Detector`
/// sniffs the first ~20 lines to pick JSON vs plain.
pub async fn run_stdin_reader(ring: Arc<Ring>, source: String, tee: bool) {
    let stdin = BufReader::with_capacity(64 * 1024, tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();
    let mut detector = Detector::new();

    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if tee {
                    let _ = stdout.write_all(line.as_bytes()).await;
                    let _ = stdout.write_all(b"\n").await;
                }
                let id = ring.next_id();
                let ev = detector.parse(id, &source, line);
                ring.push(ev);
            }
            Ok(None) => break,
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
