//! 按桥接连接维护图形发送信用；等待消费时只保留有界脏区域，不复制像素。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::extract::ws::Message;
use ironrdp::pdu::geometry::InclusiveRectangle;
use tokio::sync::mpsc;
use uuid::Uuid;

/// 极度碎片化时用完整快照收敛元数据，避免慢消费者产生无限队列。
const MAX_DIRTY_RECTS: usize = 256;

/// 一个桥接客户端的图形消费状态。
struct Consumer {
    sender: mpsc::Sender<Message>,
    dirty: Vec<InclusiveRectangle>,
    full: bool,
    in_flight: Option<(u32, u32, Instant)>,
    sequence: u32,
    updates: u64,
}

/// 协议运行任务独占的图形分发器。
pub(crate) struct GraphicsDelivery {
    consumers: HashMap<Uuid, Consumer>,
    generation: u32,
    width: u16,
    height: u16,
}

impl GraphicsDelivery {
    /// 初始化权威画面尺寸。
    pub(crate) fn new(width: u16, height: u16) -> Self {
        Self {
            consumers: HashMap::new(),
            generation: 1,
            width,
            height,
        }
    }

    /// 新连接必须先接收完整快照。
    pub(crate) fn attach(&mut self, id: Uuid, sender: mpsc::Sender<Message>) {
        self.consumers.insert(
            id,
            Consumer {
                sender,
                dirty: Vec::new(),
                full: true,
                in_flight: None,
                sequence: 0,
                updates: 0,
            },
        );
    }

    /// 尺寸或协议激活变化后丢弃旧脏区域，等待旧批次消费再发送新快照。
    pub(crate) fn resize(&mut self, width: u16, height: u16) {
        self.width = width;
        self.height = height;
        self.generation = self
            .generation
            .checked_add(1)
            .expect("graphics generation exhausted");
        for consumer in self.consumers.values_mut() {
            consumer.dirty.clear();
            consumer.updates = 0;
            consumer.full = true;
        }
    }

    /// 只接受该连接实际在途批次的确认；旧确认不能确认新代次画面。
    pub(crate) fn acknowledge(
        &mut self,
        id: Uuid,
        generation: u32,
        sequence: u32,
    ) -> Option<Duration> {
        let consumer = self.consumers.get_mut(&id)?;
        let (sent_generation, sent_sequence, sent_at) = consumer.in_flight?;
        if (generation, sequence) != (sent_generation, sent_sequence) {
            return None;
        }
        consumer.in_flight = None;
        Some(sent_at.elapsed())
    }

    /// 累计尚未发送的区域；包含关系先去重，超限时请求完整快照。
    pub(crate) fn mark(&mut self, rects: &[InclusiveRectangle]) {
        self.consumers
            .retain(|_, consumer| !consumer.sender.is_closed());
        for consumer in self.consumers.values_mut() {
            consumer.updates += 1;
            if consumer.full {
                continue;
            }
            for rect in rects {
                if consumer.dirty.iter().any(|old| contains(old, rect)) {
                    continue;
                }
                consumer.dirty.retain(|old| !contains(rect, old));
                consumer.dirty.push(rect.clone());
                if consumer.dirty.len() > MAX_DIRTY_RECTS {
                    consumer.full = true;
                    consumer.dirty.clear();
                    break;
                }
            }
        }
    }

    /// 仅在存在发送信用时从当前权威画面编码，最多保留一个未确认批次。
    pub(crate) fn flush(
        &mut self,
        mut encode: impl FnMut(u32, u32, &mut Vec<InclusiveRectangle>) -> Message,
    ) -> u64 {
        let mut coalesced = 0;
        let full_rect = InclusiveRectangle {
            left: 0,
            top: 0,
            right: self.width - 1,
            bottom: self.height - 1,
        };
        let generation = self.generation;
        self.consumers.retain(|_, consumer| {
            if consumer.sender.is_closed() {
                return false;
            }
            if consumer.in_flight.is_some() || (!consumer.full && consumer.dirty.is_empty()) {
                return true;
            }
            if consumer.full {
                consumer.dirty.clear();
                consumer.dirty.push(full_rect.clone());
            }
            consumer.sequence = consumer
                .sequence
                .checked_add(1)
                .expect("graphics sequence exhausted");
            let message = encode(generation, consumer.sequence, &mut consumer.dirty);
            if consumer.sender.try_send(message).is_err() {
                return false;
            }
            coalesced += consumer.updates.saturating_sub(1);
            consumer.updates = 0;
            consumer.full = false;
            consumer.in_flight = Some((generation, consumer.sequence, Instant::now()));
            true
        });
        coalesced
    }

    /// 返回最慢连接的待发送区域数，供调度和诊断使用。
    pub(crate) fn pending_rects(&self) -> usize {
        self.consumers
            .values()
            .map(|consumer| {
                if consumer.full {
                    1
                } else {
                    consumer.dirty.len()
                }
            })
            .max()
            .unwrap_or(0)
    }
}

/// 判断脏矩形是否已被完整覆盖。
fn contains(outer: &InclusiveRectangle, inner: &InclusiveRectangle) -> bool {
    outer.left <= inner.left
        && outer.top <= inner.top
        && outer.right >= inner.right
        && outer.bottom >= inner.bottom
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试编码器保留区域，便于检查分发器的状态而不依赖图形解码。
    fn encode(generation: u32, sequence: u32, rects: &mut Vec<InclusiveRectangle>) -> Message {
        let rect = rects.remove(0);
        rects.clear();
        let mut bytes = vec![3];
        bytes.extend_from_slice(&generation.to_le_bytes());
        bytes.extend_from_slice(&sequence.to_le_bytes());
        bytes.extend_from_slice(&[rect.left as u8, rect.right as u8]);
        Message::Binary(bytes.into())
    }

    #[test]
    fn slow_consumer_gets_latest_regions_after_exact_ack() {
        let mut delivery = GraphicsDelivery::new(100, 100);
        let id = Uuid::new_v4();
        let (tx, mut rx) = mpsc::channel(1);
        delivery.attach(id, tx);
        delivery.flush(encode);
        assert!(rx.try_recv().is_ok());
        let rect = InclusiveRectangle {
            left: 1,
            top: 1,
            right: 2,
            bottom: 2,
        };
        for _ in 0..1000 {
            delivery.mark(std::slice::from_ref(&rect));
            delivery.flush(encode);
        }
        assert!(rx.try_recv().is_err());
        assert_eq!(delivery.consumers[&id].dirty.len(), 1);
        assert!(delivery.acknowledge(id, 9, 1).is_none());
        assert!(delivery.acknowledge(id, 1, 1).is_some());
        delivery.flush(encode);
        assert!(rx.try_recv().is_ok());
        assert!(delivery.acknowledge(id, 1, 1).is_none());
    }

    #[test]
    fn resize_waits_for_outstanding_batch_then_sends_full_snapshot() {
        let mut delivery = GraphicsDelivery::new(100, 100);
        let id = Uuid::new_v4();
        let (tx, mut rx) = mpsc::channel(1);
        delivery.attach(id, tx);
        delivery.flush(encode);
        rx.try_recv().unwrap();
        delivery.resize(200, 200);
        delivery.flush(encode);
        assert!(rx.try_recv().is_err());
        delivery.acknowledge(id, 1, 1).unwrap();
        delivery.flush(encode);
        let Message::Binary(bytes) = rx.try_recv().unwrap() else {
            panic!()
        };
        assert_eq!(bytes[1], 2);
        assert_eq!(&bytes[9..], &[0, 199]);
        assert!(delivery.acknowledge(id, 1, 1).is_none());
        assert!(delivery.acknowledge(id, 2, 2).is_some());
    }

    #[test]
    fn consumers_are_independent_and_new_connections_get_snapshot() {
        let mut delivery = GraphicsDelivery::new(100, 100);
        let id = Uuid::new_v4();
        let (tx, mut rx) = mpsc::channel(1);
        delivery.attach(id, tx);
        delivery.flush(encode);
        rx.try_recv().unwrap();
        let (other_tx, mut other_rx) = mpsc::channel(1);
        delivery.attach(Uuid::new_v4(), other_tx);
        delivery.flush(encode);
        assert!(other_rx.try_recv().is_ok());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn fragmented_backlog_is_bounded_and_recovers_with_full_snapshot() {
        let mut delivery = GraphicsDelivery::new(1000, 1000);
        let id = Uuid::new_v4();
        let (tx, mut rx) = mpsc::channel(1);
        delivery.attach(id, tx);
        delivery.flush(encode);
        rx.try_recv().unwrap();
        for position in 0..1000 {
            delivery.mark(&[InclusiveRectangle {
                left: position,
                top: 0,
                right: position,
                bottom: 0,
            }]);
        }
        assert!(delivery.consumers[&id].full);
        assert!(delivery.consumers[&id].dirty.is_empty());
        assert_eq!(delivery.pending_rects(), 1);
        delivery.acknowledge(id, 1, 1).unwrap();
        delivery.flush(|generation, sequence, rects| {
            assert_eq!(rects.len(), 1);
            assert_eq!(rects[0].right, 999);
            assert_eq!(rects[0].bottom, 999);
            encode(generation, sequence, rects)
        });
        rx.try_recv().unwrap();
        drop(rx);
        delivery.flush(encode);
        assert!(delivery.consumers.is_empty());
    }
}
