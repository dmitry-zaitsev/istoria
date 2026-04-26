use parking_lot::RwLock;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::Notify;

use crate::event::Event;

pub const DEFAULT_CAPACITY: usize = 100_000;
pub const RING_SIZE_ENV: &str = "ISTORIA_RING_SIZE";

pub struct Ring {
    inner: RwLock<VecDeque<Event>>,
    capacity: usize,
    dropped: AtomicU64,
    next_id: AtomicU64,
    notify: Notify,
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

    /// Wipe ring contents. ID counter is left intact so subsequent
    /// events keep their monotonic order.
    pub fn clear(&self) {
        self.inner.write().clear();
        self.dropped.store(0, Ordering::Relaxed);
        self.notify.notify_waiters();
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
}
