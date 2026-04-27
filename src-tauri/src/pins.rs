use duckdb::params;

use crate::persistence::Store;

pub fn pin(store: &Store, event_id: i64) -> duckdb::Result<()> {
    let conn = store.conn();
    let g = conn.lock();
    g.execute(
        "INSERT OR IGNORE INTO pins(event_id) VALUES (?)",
        params![event_id],
    )?;
    Ok(())
}

pub fn unpin(store: &Store, event_id: i64) -> duckdb::Result<()> {
    let conn = store.conn();
    let g = conn.lock();
    g.execute("DELETE FROM pins WHERE event_id = ?", params![event_id])?;
    Ok(())
}

pub fn list(store: &Store) -> duckdb::Result<Vec<i64>> {
    let conn = store.conn();
    let g = conn.lock();
    let mut stmt = g.prepare("SELECT event_id FROM pins ORDER BY pinned_at DESC")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        out.push(id);
    }
    Ok(out)
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
        p.push(format!("istoria-pins-{n}.db"));
        p
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pin_unpin_roundtrip() {
        let path = tempfile_path();
        let store = Store::open_at(&path).expect("open");
        pin(&store, 42).expect("pin");
        pin(&store, 7).expect("pin");
        pin(&store, 42).expect("idempotent");
        let mut all = list(&store).expect("list");
        all.sort();
        assert_eq!(all, vec![7, 42]);
        unpin(&store, 7).expect("unpin");
        let all = list(&store).expect("list");
        assert_eq!(all, vec![42]);
        let _ = std::fs::remove_file(&path);
    }
}
