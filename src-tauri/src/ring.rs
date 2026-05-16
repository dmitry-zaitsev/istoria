use parking_lot::RwLock;
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::Notify;

use crate::event::Event;

pub const DEFAULT_CAPACITY: usize = 500_000;
pub const RING_SIZE_ENV: &str = "ISTORIA_RING_SIZE";

pub struct Ring {
    inner: RwLock<VecDeque<Event>>,
    capacity: usize,
    dropped: AtomicU64,
    next_id: AtomicU64,
    notify: Notify,
    pins: RwLock<HashSet<i64>>,
}

impl Ring {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            inner: RwLock::new(VecDeque::with_capacity(capacity)),
            capacity,
            dropped: AtomicU64::new(0),
            next_id: AtomicU64::new(1),
            notify: Notify::new(),
            pins: RwLock::new(HashSet::new()),
        }
    }

    pub fn from_env() -> Self {
        let cap = std::env::var(RING_SIZE_ENV)
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(DEFAULT_CAPACITY);
        Self::new(cap)
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn push(&self, ev: Event) {
        {
            let mut q = self.inner.write();
            if q.len() == self.capacity {
                q.pop_front();
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
            q.push_back(ev);
        }
        self.notify.notify_waiters();
    }

    pub async fn notified(&self) {
        self.notify.notified().await;
    }

    pub fn len(&self) -> usize {
        self.inner.read().len()
    }

    pub fn dropped_count(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Wipe ring contents and pins. ID counter is left intact so
    /// subsequent events keep their monotonic order.
    pub fn clear(&self) {
        self.inner.write().clear();
        self.pins.write().clear();
        self.dropped.store(0, Ordering::Relaxed);
        self.notify.notify_waiters();
    }

    pub fn pin(&self, id: i64) {
        self.pins.write().insert(id);
    }

    pub fn unpin(&self, id: i64) {
        self.pins.write().remove(&id);
    }

    /// Pinned ids, sorted descending so newer pins sort first — the
    /// same ordering the UI used to get from `ORDER BY pinned_at DESC`.
    pub fn list_pins(&self) -> Vec<i64> {
        let mut v: Vec<i64> = self.pins.read().iter().copied().collect();
        v.sort_unstable_by(|a, b| b.cmp(a));
        v
    }

    /// Most-recent-first snapshot, optionally substring-filtered on `msg`.
    pub fn snapshot(&self, limit: usize, filter: Option<&str>) -> Vec<Event> {
        let q = self.inner.read();
        let needle = filter.map(|s| s.to_lowercase());
        q.iter()
            .rev()
            .filter(|e| match &needle {
                Some(n) => e.msg.to_lowercase().contains(n),
                None => true,
            })
            .take(limit)
            .cloned()
            .collect()
    }

    /// Delta snapshot — events with `id > last_id`, oldest-first,
    /// capped at `limit`. Ids are monotonic, so we seek to the first
    /// matching index via `partition_point` (O(log n)) and clone the
    /// suffix forward. Returns an empty vec when nothing new.
    pub fn snapshot_since(&self, last_id: u64, limit: usize) -> Vec<Event> {
        let q = self.inner.read();
        let start = q.partition_point(|e| e.id <= last_id);
        q.iter().skip(start).take(limit).cloned().collect()
    }

    /// Lowest live id in the ring, or `None` when empty. The frontend
    /// compares this against its `lastSeenId`: if it's greater, the
    /// ring has evicted past the caller's cursor and a full `snapshot`
    /// is needed to re-sync.
    pub fn min_id(&self) -> Option<u64> {
        self.inner.read().front().map(|e| e.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Event;

    fn ev(id: u64, msg: &str) -> Event {
        Event::from_plain_line(id, "test", msg.to_string())
    }

    #[test]
    fn evicts_oldest_when_full() {
        let ring = Ring::new(2);
        ring.push(ev(1, "a"));
        ring.push(ev(2, "b"));
        ring.push(ev(3, "c"));
        assert_eq!(ring.len(), 2);
        assert_eq!(ring.dropped_count(), 1);
        let snap = ring.snapshot(10, None);
        assert_eq!(snap.iter().map(|e| e.id).collect::<Vec<_>>(), vec![3, 2]);
    }

    #[test]
    fn substring_filter_lowercase() {
        let ring = Ring::new(10);
        ring.push(ev(1, "ERROR boom"));
        ring.push(ev(2, "info ok"));
        let snap = ring.snapshot(10, Some("error"));
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].id, 1);
    }

    #[test]
    fn pins_roundtrip_and_sort_desc() {
        let ring = Ring::new(10);
        ring.pin(42);
        ring.pin(7);
        ring.pin(42); // idempotent
        assert_eq!(ring.list_pins(), vec![42, 7]);
        ring.unpin(7);
        assert_eq!(ring.list_pins(), vec![42]);
    }

    #[test]
    fn clear_wipes_pins_too() {
        let ring = Ring::new(10);
        ring.pin(1);
        ring.push(ev(1, "a"));
        ring.clear();
        assert!(ring.list_pins().is_empty());
        assert_eq!(ring.len(), 0);
    }

    #[test]
    fn snapshot_since_returns_delta_oldest_first() {
        let ring = Ring::new(10);
        ring.push(ev(1, "a"));
        ring.push(ev(2, "b"));
        ring.push(ev(3, "c"));
        let delta = ring.snapshot_since(1, 10);
        assert_eq!(delta.iter().map(|e| e.id).collect::<Vec<_>>(), vec![2, 3]);
    }

    #[test]
    fn snapshot_since_empty_when_caller_is_current() {
        let ring = Ring::new(10);
        ring.push(ev(1, "a"));
        ring.push(ev(2, "b"));
        assert!(ring.snapshot_since(2, 10).is_empty());
        assert!(ring.snapshot_since(99, 10).is_empty());
    }

    #[test]
    fn snapshot_since_respects_limit() {
        let ring = Ring::new(10);
        for i in 1..=5 {
            ring.push(ev(i, "x"));
        }
        let delta = ring.snapshot_since(0, 3);
        assert_eq!(delta.iter().map(|e| e.id).collect::<Vec<_>>(), vec![1, 2, 3]);
    }

    #[test]
    fn min_id_tracks_eviction_floor() {
        let ring = Ring::new(2);
        assert_eq!(ring.min_id(), None);
        ring.push(ev(1, "a"));
        assert_eq!(ring.min_id(), Some(1));
        ring.push(ev(2, "b"));
        ring.push(ev(3, "c")); // evicts id=1
        assert_eq!(ring.min_id(), Some(2));
    }
}
