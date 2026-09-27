//! Live macOS unified logs, shared by the Tauri and Electron owners.
//! Forwarders never reach owner startup, so attaching a pipe does not create
//! another collector. No historical replay or privileged helper is involved.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use chrono::DateTime;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::event::{Event, Level};
use crate::ring::Ring;

const SOURCE: &str = "macos";
const MAX_RETRY: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct Config {
    level: String,
    predicate: Option<String>,
}

impl Config {
    fn from_env() -> Self {
        let level = std::env::var("ISTORIA_SYSTEM_LOG_LEVEL").unwrap_or_else(|_| "default".into());
        let level = match level.trim().to_ascii_lowercase().as_str() {
            "info" => "info",
            "debug" => "debug",
            _ => "default",
        };
        Self {
            level: level.into(),
            predicate: std::env::var("ISTORIA_SYSTEM_LOG_PREDICATE")
                .ok()
                .filter(|v| !v.trim().is_empty()),
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new("/usr/bin/log");
        command.args([
            "stream",
            "--style",
            "ndjson",
            "--type",
            "log",
            "--level",
            &self.level,
        ]);
        if let Some(predicate) = &self.predicate {
            // Pass the predicate as one argument, never through a shell.
            command.args(["--predicate", predicate]);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }
}

pub struct Collector {
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl Collector {
    /// Must be called inside the owner's async runtime.
    pub fn start(ring: Arc<Ring>) -> Self {
        Self::spawn(ring, Config::from_env())
    }

    fn spawn(ring: Arc<Ring>, config: Config) -> Self {
        let (tx, rx) = oneshot::channel();
        Self {
            shutdown: Some(tx),
            task: Some(tokio::spawn(run(ring, config, rx))),
        }
    }

    /// Wait until the subprocess has been killed and reaped.
    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for Collector {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

async fn run(ring: Arc<Ring>, config: Config, mut shutdown: oneshot::Receiver<()>) {
    let mut retry = Duration::from_secs(1);
    loop {
        // Also notice cancellation between attempts, before spawning again.
        if !matches!(
            shutdown.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ) {
            return;
        }
        let started = std::time::Instant::now();
        match config.command().spawn() {
            Ok(mut child) => {
                let stdout = child.stdout.take().expect("piped stdout");
                let stderr = child.stderr.take().expect("piped stderr");
                let result = tokio::select! {
                    biased;
                    _ = &mut shutdown => {
                        let _ = child.kill().await;
                        return;
                    }
                    result = read_stream(&ring, stdout, stderr) => result,
                };
                // EOF or a read error: kill if still running, and always reap.
                let status = match child.try_wait() {
                    Ok(Some(status)) => status.to_string(),
                    _ => {
                        let _ = child.kill().await;
                        "stream closed".into()
                    }
                };
                if started.elapsed() >= MAX_RETRY {
                    retry = Duration::from_secs(1);
                }
                let detail = result.err().map(|e| format!(": {e}")).unwrap_or_default();
                diagnostic(
                    &ring,
                    format!(
                        "macOS log capture stopped ({status}){detail}; retrying in {}s",
                        retry.as_secs()
                    ),
                );
            }
            Err(error) => diagnostic(
                &ring,
                format!(
                    "Could not start macOS log capture: {error}; retrying in {}s",
                    retry.as_secs()
                ),
            ),
        }
        tokio::select! {
            _ = &mut shutdown => return,
            _ = tokio::time::sleep(retry) => {},
        }
        retry = (retry * 2).min(MAX_RETRY);
    }
}

async fn read_stream(
    ring: &Ring,
    stdout: impl tokio::io::AsyncRead + Unpin,
    stderr: impl tokio::io::AsyncRead + Unpin,
) -> std::io::Result<()> {
    let mut out = BufReader::new(stdout).lines();
    let mut err = BufReader::new(stderr).lines();
    let mut out_open = true;
    let mut err_open = true;
    // Drain both pipes concurrently: permission/predicate errors must be
    // visible in the UI, and an unread stderr pipe must never block capture.
    while out_open || err_open {
        tokio::select! {
            line = out.next_line(), if out_open => match line? {
                Some(raw) => {
                    if let Some(event) = parse_line(raw) {
                        ring.append(event);
                    }
                }
                None => out_open = false,
            },
            line = err.next_line(), if err_open => match line? {
                Some(line) if !line.trim().is_empty() => diagnostic(ring, line),
                Some(_) => {},
                None => err_open = false,
            },
        }
    }
    Ok(())
}

fn diagnostic(ring: &Ring, message: String) {
    tracing::warn!(%message, "system log collector");
    let mut event = Event::from_plain_line(0, SOURCE, message);
    event.level = Level::Warn;
    event.fields = Some(serde_json::json!({"collector": "macos"}));
    ring.append(event);
}

fn parse_line(raw: String) -> Option<Event> {
    let mut fields: Value = serde_json::from_str(&raw).ok()?;
    // `log stream` also emits a banner and {"count":...,"finished":...}
    // control records. They are not log messages.
    let message = fields.get("eventMessage")?.as_str()?.to_owned();
    let level = match fields.get("messageType").and_then(Value::as_str) {
        Some("Error" | "Fault") => Level::Error,
        Some("Warning") => Level::Warn,
        Some("Debug") => Level::Debug,
        _ => Level::Info,
    };
    let timestamp = fields
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|s| {
            DateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f%z")
                .or_else(|_| DateTime::parse_from_rfc3339(s))
                .ok()
                .map(|ts| ts.timestamp_millis())
        });
    // Convenient facet alongside the full original processImagePath.
    if let Some(process) = fields
        .get("processImagePath")
        .and_then(Value::as_str)
        .and_then(|path| path.rsplit('/').next())
        .map(str::to_owned)
    {
        fields["process"] = Value::String(process);
    }
    let mut event = Event::from_plain_line(0, SOURCE, raw);
    if let Some(ts) = timestamp {
        event.ts = ts;
    }
    event.msg = message;
    event.level = level;
    event.fields = Some(fields);
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(kind: &str) -> String {
        serde_json::json!({
            "eventMessage": "request failed\n  details: <private>",
            "messageType": kind,
            "timestamp": "2026-09-24 00:02:33.989541+0200",
            "processImagePath": "/usr/libexec/example",
            "processID": 123,
            "subsystem": "com.example.test",
            "category": "network"
        })
        .to_string()
    }

    #[test]
    fn preserves_message_timestamp_and_metadata() {
        let raw = record("Fault");
        let event = parse_line(raw.clone()).unwrap();
        assert_eq!(event.source, "macos");
        assert!(event.branch.is_empty());
        assert_eq!(event.msg, "request failed\n  details: <private>");
        assert_eq!(event.raw, raw);
        assert_eq!(event.level, Level::Error);
        assert_eq!(
            event.ts,
            DateTime::parse_from_rfc3339("2026-09-23T22:02:33.989Z")
                .unwrap()
                .timestamp_millis()
        );
        let fields = event.fields.unwrap();
        assert_eq!(fields["process"], "example");
        assert_eq!(fields["processID"], 123);
        assert_eq!(fields["subsystem"], "com.example.test");
        assert_eq!(fields["category"], "network");
    }

    #[test]
    fn maps_native_severity_without_inferring_from_message() {
        for (native, expected) in [
            ("Default", Level::Info),
            ("Info", Level::Info),
            ("Debug", Level::Debug),
            ("Error", Level::Error),
            ("Fault", Level::Error),
        ] {
            assert_eq!(parse_line(record(native)).unwrap().level, expected);
        }
    }

    #[test]
    fn ignores_control_and_malformed_records() {
        for raw in [
            "",
            "Filtering the log data using type == 1024",
            "{\"count\":1,\"finished\":1}",
            "{broken",
            "[]",
            "{\"eventMessage\":null}",
        ] {
            assert!(parse_line(raw.into()).is_none());
        }
        assert!(
            parse_line("{\"eventMessage\":\"\",\"timestamp\":\"bad\"}".into())
                .unwrap()
                .ts
                > 0
        );
    }

    #[tokio::test]
    async fn ingests_stdout_and_surfaces_stderr() {
        let ring = Ring::new(10);
        let stdout = format!(
            "banner\n{}\n{}\n{{\"finished\":1}}\n",
            record("Info"),
            record("Error")
        );
        read_stream(&ring, stdout.as_bytes(), &b"permission denied\n"[..])
            .await
            .unwrap();
        let events = ring.snapshot_since(0, 10);
        assert_eq!(events.len(), 3);
        assert_eq!(
            events
                .iter()
                .filter(|e| e.fields.as_ref().unwrap().get("processID").is_some())
                .count(),
            2
        );
        assert!(events
            .iter()
            .any(|e| e.msg == "permission denied" && e.level == Level::Warn));
    }

    #[test]
    fn predicate_is_a_single_literal_argument() {
        let predicate = "process == \"example\" AND eventMessage CONTAINS \"$(not-a-shell)\"";
        let config = Config {
            level: "debug".into(),
            predicate: Some(predicate.into()),
        };
        let command = config.command();
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|a| a.to_str().unwrap())
            .collect();
        assert_eq!(
            args,
            [
                "stream",
                "--style",
                "ndjson",
                "--type",
                "log",
                "--level",
                "debug",
                "--predicate",
                predicate
            ]
        );
    }
}
