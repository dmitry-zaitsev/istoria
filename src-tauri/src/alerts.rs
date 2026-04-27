use duckdb::params;
use serde::{Deserialize, Serialize};

use crate::persistence::Store;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Alert {
    pub id: i64,
    pub name: String,
    pub query: String,
    pub color: String,
    pub notify: bool,
    pub debounce_ms: i64,
    pub enabled: bool,
}

pub fn list(store: &Store) -> duckdb::Result<Vec<Alert>> {
    let conn = store.conn();
    let g = conn.lock();
    let mut stmt = g.prepare(
        "SELECT id, name, query, color, notify, debounce_ms, enabled FROM alerts ORDER BY id",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(read_alert(row)?);
    }
    Ok(out)
}

pub fn create(
    store: &Store,
    name: String,
    query: String,
    color: String,
    notify: bool,
    debounce_ms: i64,
) -> duckdb::Result<Alert> {
    let conn = store.conn();
    let g = conn.lock();
    let mut stmt = g.prepare(
        "INSERT INTO alerts(name, query, color, notify, debounce_ms, enabled) \
         VALUES (?, ?, ?, ?, ?, TRUE) \
         RETURNING id, name, query, color, notify, debounce_ms, enabled",
    )?;
    let mut rows = stmt.query(params![name, query, color, notify, debounce_ms as i32])?;
    let row = rows.next()?.expect("RETURNING yields row");
    read_alert(row)
}

pub fn set_enabled(store: &Store, id: i64, enabled: bool) -> duckdb::Result<()> {
    let conn = store.conn();
    let g = conn.lock();
    g.execute(
        "UPDATE alerts SET enabled = ? WHERE id = ?",
        params![enabled, id],
    )?;
    Ok(())
}

pub fn delete(store: &Store, id: i64) -> duckdb::Result<()> {
    let conn = store.conn();
    let g = conn.lock();
    g.execute("DELETE FROM alerts WHERE id = ?", params![id])?;
    Ok(())
}

fn read_alert(row: &duckdb::Row<'_>) -> duckdb::Result<Alert> {
    let id: i32 = row.get(0)?;
    let name: String = row.get(1)?;
    let query: String = row.get(2)?;
    let color: String = row.get(3)?;
    let notify: bool = row.get(4)?;
    let debounce_ms: i32 = row.get(5)?;
    // Column is nullable post-migration; legacy rows (created before
    // the column existed) are treated as enabled.
    let enabled: Option<bool> = row.get(6)?;
    Ok(Alert {
        id: id as i64,
        name,
        query,
        color,
        notify,
        debounce_ms: debounce_ms as i64,
        enabled: enabled.unwrap_or(true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempfile_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("istoria-alerts-{n}.db"));
        p
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn crud() {
        let path = tempfile_path();
        let store = Store::open_at(&path).expect("open");
        let a = create(
            &store,
            "errors".into(),
            "level:error".into(),
            "red".into(),
            true,
            10000,
        )
        .expect("create");
        assert_eq!(a.name, "errors");
        assert!(a.enabled);
        set_enabled(&store, a.id, false).expect("disable");
        let all = list(&store).expect("list");
        assert_eq!(all.len(), 1);
        assert!(!all[0].enabled);
        delete(&store, a.id).expect("delete");
        assert!(list(&store).expect("list").is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
