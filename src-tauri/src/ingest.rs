use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::event::Event;
use crate::ring::Ring;

/// Read stdin line-by-line, push each into the ring buffer.
/// If `tee` is true, also forward each line to stdout so the user
/// continues to see logs in their terminal.
pub async fn run_stdin_reader(ring: Arc<Ring>, source: String, tee: bool) {
    let stdin = BufReader::with_capacity(64 * 1024, tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();

    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if tee {
                    let _ = stdout.write_all(line.as_bytes()).await;
                    let _ = stdout.write_all(b"\n").await;
                }
                let id = ring.next_id();
                ring.push(Event::from_plain_line(id, &source, line));
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
        "stdin closed"
    );
}
