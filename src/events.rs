//! Lock-minimal SSE event bus for live Fleet telemetry.
//!
//! Each subscriber gets a bounded `SyncSender` so a slow or disconnected client
//! can never block agent workers, check runners, or other SSE listeners.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::Mutex;

/// Maximum buffered frames per SSE subscriber before dropping backpressured messages.
const SUBSCRIBER_BUFFER: usize = 256;
/// Number of recent events retained for `Last-Event-ID` catch-up.
const HISTORY_CAP: usize = 64;

pub struct Subscription {
    pub id: u64,
    pub rx: Receiver<String>,
}

pub struct EventBus {
    next_seq: AtomicU64,
    next_sub: AtomicU64,
    subscribers: Mutex<Vec<(u64, SyncSender<String>)>>,
    history: Mutex<VecDeque<(u64, String)>>,
}

impl EventBus {
    pub fn new() -> Self {
        Self {
            next_seq: AtomicU64::new(1),
            next_sub: AtomicU64::new(1),
            subscribers: Mutex::new(Vec::new()),
            history: Mutex::new(VecDeque::with_capacity(HISTORY_CAP)),
        }
    }

    /// Format and publish one SSE event (`id`, `event`, `data`) to all active subscribers.
    pub fn publish(&self, event: &str, payload: &serde_json::Value) -> u64 {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let frame = format!("id: {seq}\nevent: {event}\ndata: {payload}\n\n");
        {
            let mut hist = self.history.lock().unwrap();
            if hist.len() >= HISTORY_CAP {
                hist.pop_front();
            }
            hist.push_back((seq, frame.clone()));
        }
        let mut subs = self.subscribers.lock().unwrap();
        subs.retain(|(_, tx)| match tx.try_send(frame.clone()) {
            Ok(()) | Err(TrySendError::Full(_)) => true,
            Err(TrySendError::Disconnected(_)) => false,
        });
        seq
    }

    /// Register a new SSE subscriber and return any missed frames strictly after `last_event_id`.
    pub fn subscribe(&self, last_event_id: Option<u64>) -> (Subscription, Vec<String>) {
        let id = self.next_sub.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel(SUBSCRIBER_BUFFER);
        let replay = if let Some(since) = last_event_id {
            let hist = self.history.lock().unwrap();
            hist.iter()
                .filter(|(seq, _)| *seq > since)
                .map(|(_, frame)| frame.clone())
                .collect()
        } else {
            Vec::new()
        };
        self.subscribers.lock().unwrap().push((id, tx));
        (Subscription { id, rx }, replay)
    }

    pub fn unsubscribe(&self, id: u64) {
        self.subscribers.lock().unwrap().retain(|(sid, _)| *sid != id);
    }

    #[cfg(test)]
    pub fn subscriber_count(&self) -> usize {
        self.subscribers.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_bus_fanout_and_last_event_id_replay() {
        let bus = EventBus::new();
        let (sub1, replay1) = bus.subscribe(None);
        assert!(replay1.is_empty());
        let (sub2, _) = bus.subscribe(None);
        assert_eq!(bus.subscriber_count(), 2);

        let seq1 = bus.publish("session_status", &serde_json::json!({"id": "s1", "status": "working"}));
        let seq2 = bus.publish("transcript_line", &serde_json::json!({"id": "s1", "line": "hi"}));
        assert!(seq2 > seq1);

        let f1 = sub1.rx.try_recv().unwrap();
        let f2 = sub2.rx.try_recv().unwrap();
        assert_eq!(f1, f2);
        assert!(f1.contains("event: session_status"));
        assert!(f1.contains("\"status\":\"working\""));

        // Replay after seq1 returns only seq2.
        let (sub3, replay3) = bus.subscribe(Some(seq1));
        assert_eq!(replay3.len(), 1);
        assert!(replay3[0].contains("event: transcript_line"));

        bus.unsubscribe(sub1.id);
        bus.unsubscribe(sub2.id);
        bus.unsubscribe(sub3.id);
        assert_eq!(bus.subscriber_count(), 0);
    }

    #[test]
    fn slow_or_dropped_subscriber_never_blocks_publish() {
        let bus = EventBus::new();
        let (sub, _) = bus.subscribe(None);
        for i in 0..(SUBSCRIBER_BUFFER + 64) {
            bus.publish("transcript_line", &serde_json::json!({"n": i}));
        }
        drop(sub);
        bus.publish("queue_depth", &serde_json::json!({"active": 0}));
        assert_eq!(bus.subscriber_count(), 0);
    }
}
