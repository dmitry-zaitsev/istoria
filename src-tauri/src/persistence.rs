use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use duckdb::{params, Connection};
use parking_lot::Mutex;
use tokio::sync::mpsc;

use crate::event::{Event, Level};

pub const DB_DIR_NAME: &str = "istoria";
pub const DB_FILE_NAME: &str = "istoria.db";
pub const SCHEMA_VERSION: i64 = 3;
pub const FLUSH_INTERVAL_MS: u64 = 250;
pub const FLUSH_BATCH: usize = 1_000;

pub fn db_path() -> Option<PathBuf> {
    let dirs = directories::ProjectDirs::from("", "", DB_DIR_NAME)?;
    let dir = dirs.data_dir();
    Some(dir.join(DB_FILE_NAME))
}

/// On-disk persistent store backed by DuckDB.
///
/// Single connection guarded by a `Mutex`. The connection drives both
/// the batched Appender writer (background task) and synchronous
/// reads from IPC commands.
pub struct Store {
    conn: Arc<Mutex<Connection>>,
    session_id: i64,
    tx: mpsc::UnboundedSender<Event>,
}

impl Store {
    /// Open the DuckDB at the platform default path. Creates parent
    /// directory if missing. Runs schema migrations and starts a new
    /// session row.
    pub fn open_default(clear: bool) -> duckdb::Result<Self> {
        let path = db_path().expect("project dirs resolvable");
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if clear && path.exists() {
            let _ = std::fs::remove_file(&path);
        }
        Self::open_at(&path)
    }

    pub fn open_at(path: &std::path::Path) -> duckdb::Result<Self> {
        let conn = Connection::open(path)?;
        migrate(&conn)?;
        let session_id = start_session(&conn)?;
        let conn = Arc::new(Mutex::new(conn));
        let (tx, rx) = mpsc::unbounded_channel();
        let writer_conn = Arc::clone(&conn);
        tauri::async_runtime::spawn(async move {
            run_writer(writer_conn, session_id, rx).await;
        });
        Ok(Self { conn, session_id, tx })
    }

    pub fn session_id(&self) -> i64 {
        self.session_id
    }

    /// Delete all events for the current session from disk. Also drops
    /// pins pointing at those events so the pins set never references
    /// rows that no longer exist.
    pub fn clear_session(&self) -> duckdb::Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM pins WHERE event_id IN (SELECT id FROM events WHERE session_id = ?)",
            params![self.session_id as i32],
        )?;
        conn.execute(
            "DELETE FROM events WHERE session_id = ?",
            params![self.session_id as i32],
        )?;
        Ok(())
    }

    pub fn conn(&self) -> Arc<Mutex<Connection>> {
        Arc::clone(&self.conn)
    }

    /// Enqueue an event for batched persistence. Writer task drains
    /// the channel every 250 ms or 1k events.
    pub fn submit(&self, ev: Event) {
        let _ = self.tx.send(ev);
    }
}

/// Schema migrations keyed off a single row in `schema_meta`. Future
/// migrations bump SCHEMA_VERSION and append `ALTER`s under the
/// matching `if stored < N` block.
fn migrate(conn: &Connection) -> duckdb::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )?;
    let stored: i64 = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'user_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if stored < 1 {
        conn.execute_batch(
            r#"
            CREATE SEQUENCE IF NOT EXISTS sessions_id_seq;
            CREATE TABLE IF NOT EXISTS sessions (
                id          INTEGER PRIMARY KEY DEFAULT nextval('sessions_id_seq'),
                started_at  TIMESTAMP NOT NULL,
                ended_at    TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS events (
                id          BIGINT  PRIMARY KEY,
                ts          TIMESTAMP NOT NULL,
                session_id  INTEGER NOT NULL,
                source      TEXT NOT NULL,
                level       TEXT NOT NULL,
                msg         TEXT NOT NULL,
                raw         TEXT NOT NULL,
                fields      JSON
            );
            CREATE INDEX IF NOT EXISTS events_session_ts ON events(session_id, ts);
            CREATE INDEX IF NOT EXISTS events_level      ON events(level);
            "#,
        )?;
    }

    if stored < 2 {
        conn.execute_batch(
            r#"
            CREATE SEQUENCE IF NOT EXISTS views_id_seq;
            CREATE TABLE IF NOT EXISTS views (
                id          INTEGER PRIMARY KEY DEFAULT nextval('views_id_seq'),
                name        TEXT NOT NULL,
                query       TEXT NOT NULL DEFAULT '',
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TIMESTAMP NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )?;
    }

    if stored < 3 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS pins (
                event_id  BIGINT PRIMARY KEY,
                pinned_at TIMESTAMP NOT NULL DEFAULT now()
            );
            "#,
        )?;
    }
    conn.execute(
        "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('user_version', ?)",
        params![SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
}

fn start_session(conn: &Connection) -> duckdb::Result<i64> {
    let now = chrono::Utc::now().naive_utc();
    let mut stmt = conn.prepare("INSERT INTO sessions(started_at) VALUES (?) RETURNING id")?;
    let mut rows = stmt.query(params![now])?;
    let row = rows.next()?.expect("RETURNING yields one row");
    let id: i32 = row.get(0)?;
    Ok(id as i64)
}

async fn run_writer(
    conn: Arc<Mutex<Connection>>,
    session_id: i64,
    mut rx: mpsc::UnboundedReceiver<Event>,
) {
    let mut buf: Vec<Event> = Vec::with_capacity(FLUSH_BATCH);
    let mut tick = tokio::time::interval(Duration::from_millis(FLUSH_INTERVAL_MS));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            maybe = rx.recv() => {
                match maybe {
                    Some(ev) => {
                        buf.push(ev);
                        while let Ok(more) = rx.try_recv() {
                            buf.push(more);
                            if buf.len() >= FLUSH_BATCH { break; }
                        }
                        if buf.len() >= FLUSH_BATCH {
                            flush(&conn, session_id, &mut buf);
                        }
                    }
                    None => {
                        if !buf.is_empty() {
                            flush(&conn, session_id, &mut buf);
                        }
                        return;
                    }
                }
            }
            _ = tick.tick() => {
                if !buf.is_empty() {
                    flush(&conn, session_id, &mut buf);
                }
            }
        }
    }
}

fn flush(conn: &Mutex<Connection>, session_id: i64, buf: &mut Vec<Event>) {
    if buf.is_empty() {
        return;
    }
    let guard = conn.lock();
    let result = (|| -> duckdb::Result<()> {
        let mut app = guard.appender("events")?;
        for ev in buf.iter() {
            let ts = ts_to_naive(ev.ts);
            let fields_json = ev
                .fields
                .as_ref()
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".into());
            app.append_row(params![
                ev.id as i64,
                ts,
                session_id as i32,
                ev.source.as_str(),
                level_str(ev.level),
                ev.msg.as_str(),
                ev.raw.as_str(),
                fields_json,
            ])?;
        }
        app.flush()?;
        Ok(())
    })();
    if let Err(e) = result {
        tracing::warn!(error = %e, count = buf.len(), "duckdb append failed");
    }
    buf.clear();
}

fn ts_to_naive(unix_ms: i64) -> chrono::NaiveDateTime {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(unix_ms)
        .map(|d| d.naive_utc())
        .unwrap_or_else(|| chrono::Utc::now().naive_utc())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn migrate_and_persist_event() {
        let tmp = tempfile_path();
        let store = Store::open_at(&tmp).expect("open");
        let ev = Event::from_plain_line(1, "src", "hello".into());
        store.submit(ev);
        // give writer a tick to flush
        tokio::time::sleep(Duration::from_millis(400)).await;
        let conn = store.conn();
        let n: i64 = conn.lock()
            .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 1);
        let _ = std::fs::remove_file(&tmp);
    }

    fn tempfile_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("istoria-test-{n}.db"));
        p
    }
}
