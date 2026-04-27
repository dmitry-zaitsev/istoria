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
}

pub fn list(store: &Store) -> duckdb::Result<Vec<Alert>> {
    let conn = store.conn();
    let g = conn.lock();
    let mut stmt = g.prepare(
        "SELECT id, name, query, color, notify, debounce_ms FROM alerts ORDER BY id",
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
        "INSERT INTO alerts(name, query, color, notify, debounce_ms) \
         VALUES (?, ?, ?, ?, ?) \
         RETURNING id, name, query, color, notify, debounce_ms",
    )?;
    let mut rows = stmt.query(params![name, query, color, notify, debounce_ms as i32])?;
    let row = rows.next()?.expect("RETURNING yields row");
    read_alert(row)
}

pub fn update(
    store: &Store,
    id: i64,
    name: String,
    query: String,
    color: String,
    notify: bool,
    debounce_ms: i64,
) -> duckdb::Result<()> {
    let conn = store.conn();
    let g = conn.lock();
    g.execute(
        "UPDATE alerts SET name = ?, query = ?, color = ?, notify = ?, debounce_ms = ? \
         WHERE id = ?",
        params![name, query, color, notify, debounce_ms as i32, id],
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
    Ok(Alert {
        id: id as i64,
        name,
        query,
        color,
        notify,
        debounce_ms: debounce_ms as i64,
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
        update(
            &store,
            a.id,
            "errs".into(),
            "level:error AND source:api".into(),
            "orange".into(),
            false,
            5000,
        )
        .expect("update");
        let all = list(&store).expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "errs");
        assert_eq!(all[0].color, "orange");
        delete(&store, a.id).expect("delete");
        assert!(list(&store).expect("list").is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
