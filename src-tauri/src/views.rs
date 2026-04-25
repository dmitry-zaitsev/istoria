use duckdb::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::persistence::Store;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct View {
    pub id: i64,
    pub name: String,
    pub query: String,
    pub sort_order: i64,
}

pub fn list(store: &Store) -> duckdb::Result<Vec<View>> {
    let conn = store.conn();
    let g = conn.lock();
    let mut stmt =
        g.prepare("SELECT id, name, query, sort_order FROM views ORDER BY sort_order, id")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(read_view(row)?);
    }
    Ok(out)
}

pub fn create(store: &Store, name: String, query: String) -> duckdb::Result<View> {
    let conn = store.conn();
    let g = conn.lock();
    let max: i64 = g
        .query_row("SELECT coalesce(max(sort_order), -1) FROM views", [], |r| {
            r.get(0)
        })
        .unwrap_or(-1);
    let next = max + 1;
    let mut stmt = g.prepare(
        "INSERT INTO views(name, query, sort_order) VALUES (?, ?, ?) RETURNING id, name, query, sort_order",
    )?;
    let mut rows = stmt.query(params![name, query, next])?;
    let row = rows.next()?.expect("RETURNING yields row");
    read_view(row)
}

pub fn update(store: &Store, id: i64, name: String, query: String) -> duckdb::Result<()> {
    let conn = store.conn();
    let g = conn.lock();
    g.execute(
        "UPDATE views SET name = ?, query = ? WHERE id = ?",
        params![name, query, id],
    )?;
    Ok(())
}

pub fn delete(store: &Store, id: i64) -> duckdb::Result<()> {
    let conn = store.conn();
    let g = conn.lock();
    g.execute("DELETE FROM views WHERE id = ?", params![id])?;
    Ok(())
}

pub fn duplicate(store: &Store, id: i64) -> duckdb::Result<View> {
    let conn = store.conn();
    let g = conn.lock();
    let (name, query): (String, String) = g.query_row(
        "SELECT name, query FROM views WHERE id = ?",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    drop(g);
    create(store, format!("{name} (copy)"), query)
}

pub fn get_meta(store: &Store, key: &str) -> Option<String> {
    let conn = store.conn();
    let g = conn.lock();
    g.query_row(
        "SELECT value FROM meta WHERE key = ?",
        params![key],
        |r| r.get(0),
    )
    .ok()
}

pub fn set_meta(store: &Store, key: &str, value: &str) -> duckdb::Result<()> {
    let conn = store.conn();
    let g = conn.lock();
    g.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
        params![key, value],
    )?;
    Ok(())
}

fn read_view(row: &duckdb::Row<'_>) -> duckdb::Result<View> {
    let id: i32 = row.get(0)?;
    let name: String = row.get(1)?;
    let query: String = row.get(2)?;
    let sort_order: i32 = row.get(3)?;
    Ok(View {
        id: id as i64,
        name,
        query,
        sort_order: sort_order as i64,
    })
}

// Helper for tests / fresh launches: ensure at least one view exists.
pub fn seed_default(store: &Store) -> duckdb::Result<()> {
    let n: i64 = {
        let conn = store.conn();
        let g = conn.lock();
        g.query_row("SELECT count(*) FROM views", [], |r| r.get(0))?
    };
    if n == 0 {
        create(store, "All".into(), String::new())?;
    }
    Ok(())
}

#[allow(dead_code)]
fn _typecheck(_: &Connection) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempfile_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("istoria-views-{n}.db"));
        p
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn crud_round_trip() {
        let path = tempfile_path();
        let store = Store::open_at(&path).expect("open");
        let v = create(&store, "errors".into(), "level:error".into()).expect("create");
        assert_eq!(v.name, "errors");
        let all = list(&store).expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, v.id);
        update(&store, v.id, "errs".into(), "level:error AND source:api".into()).expect("update");
        let all = list(&store).expect("list");
        assert_eq!(all[0].name, "errs");
        let dup = duplicate(&store, v.id).expect("dup");
        assert_eq!(dup.name, "errs (copy)");
        delete(&store, v.id).expect("del");
        let all = list(&store).expect("list");
        assert_eq!(all.len(), 1); // only dup remains
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn meta_kv() {
        let path = tempfile_path();
        let store = Store::open_at(&path).expect("open");
        set_meta(&store, "active_view", "42").expect("set");
        assert_eq!(get_meta(&store, "active_view").as_deref(), Some("42"));
        let _ = std::fs::remove_file(&path);
    }
}
