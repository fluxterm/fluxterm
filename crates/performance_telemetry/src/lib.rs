//! FluxTerm 性能遥测采集与发送端公共接口。
//!
//! 线协议类型、指标目录和校验规则统一来自 `fluxterm-pulse-protocol`；本 crate
//! 只负责发送端构造、窗口聚合、进程内接收器和 UDP 数据报编码。

mod metrics;
mod protocol;

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

pub use fluxterm_pulse_protocol::LATEST_SCHEMA_VERSION;
pub use fluxterm_pulse_protocol::v1::{
    ClosedBody, ClosedMessage, DeviceIdentity, HistogramValue, MAX_DATAGRAM_BYTES, METRIC_CATALOG,
    Message, MetricDefinition, MetricKind, MetricPoint, MetricUnit, MetricValue, MetricWindow,
    OpenedMessage, PerformanceDomain, ProtocolError, SnapshotMessage, Source, StreamCorrelation,
    StreamDescriptor, StreamKind, StreamOutcome, StreamParameter, StreamReference, StreamTarget,
    ValidationError, decode_datagram, definition, validate_metric,
};
pub use metrics::{HistogramAccumulator, counter_metric, gauge_metric, histogram_metric};
pub use protocol::{
    SnapshotEncoding, encode_stream_closed, encode_stream_opened, encode_stream_snapshot,
};
use uuid::Uuid;

/// 创建带随机 ID 的性能流描述。
pub fn create_stream_descriptor(
    kind: StreamKind,
    started_at_unix_ms: u64,
    parameters: BTreeMap<String, StreamParameter>,
    target: StreamTarget,
    correlation: StreamCorrelation,
) -> StreamDescriptor {
    StreamDescriptor {
        id: Uuid::new_v4().to_string(),
        domain: kind.domain(),
        kind,
        started_at_unix_ms,
        parameters,
        target,
        correlation,
    }
}

/// 单条流的一批聚合指标。
#[derive(Debug, Clone, PartialEq)]
pub struct MetricBatch {
    /// 匿名流 ID。
    pub stream_id: String,
    /// 聚合窗口。
    pub window: MetricWindow,
    /// 已聚合指标。
    pub metrics: Vec<MetricPoint>,
}

/// 非阻塞记录结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordOutcome {
    /// 已接收。
    Accepted,
    /// 队列已满。
    Dropped,
    /// 输入非法。
    Invalid,
    /// 服务或对应域未启用。
    Disabled,
}

/// 进程内性能遥测接收器。
pub trait PerformanceTelemetrySink: Send + Sync {
    /// 判断业务域是否启用。
    fn enabled(&self, domain: PerformanceDomain) -> bool;
    /// 返回对应域的聚合窗口长度。
    fn interval_ms(&self, domain: PerformanceDomain) -> Option<u64>;
    /// 打开匿名数据流。
    fn open_stream(&self, stream: StreamDescriptor) -> RecordOutcome;
    /// 提交聚合批次。
    fn record_batch(&self, batch: MetricBatch) -> RecordOutcome;
    /// 关闭数据流。
    fn close_stream(
        &self,
        stream_id: &str,
        outcome: StreamOutcome,
        ended_at_unix_ms: u64,
    ) -> RecordOutcome;
}

static GLOBAL_SINK: OnceLock<Arc<dyn PerformanceTelemetrySink>> = OnceLock::new();

/// 安装一次进程级接收器。
pub fn install_global_sink(
    sink: Arc<dyn PerformanceTelemetrySink>,
) -> Result<(), Arc<dyn PerformanceTelemetrySink>> {
    GLOBAL_SINK.set(sink)
}

/// 判断域是否已启用。
pub fn domain_enabled(domain: PerformanceDomain) -> bool {
    GLOBAL_SINK.get().is_some_and(|sink| sink.enabled(domain))
}

/// 返回已启用域的聚合窗口长度。
pub fn collection_interval_ms(domain: PerformanceDomain) -> Option<u64> {
    GLOBAL_SINK.get().and_then(|sink| sink.interval_ms(domain))
}

/// 非阻塞打开数据流。
pub fn open_stream(stream: StreamDescriptor) -> RecordOutcome {
    GLOBAL_SINK
        .get()
        .map_or(RecordOutcome::Disabled, |sink| sink.open_stream(stream))
}

/// 非阻塞提交批次。
pub fn record_batch(batch: MetricBatch) -> RecordOutcome {
    GLOBAL_SINK
        .get()
        .map_or(RecordOutcome::Disabled, |sink| sink.record_batch(batch))
}

/// 非阻塞关闭数据流。
pub fn close_stream(
    stream_id: &str,
    outcome: StreamOutcome,
    ended_at_unix_ms: u64,
) -> RecordOutcome {
    GLOBAL_SINK.get().map_or(RecordOutcome::Disabled, |sink| {
        sink.close_stream(stream_id, outcome, ended_at_unix_ms)
    })
}

/// 返回当前 Unix 毫秒，时钟异常时返回零。
pub fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_protocol_stream_descriptor() {
        let descriptor = create_stream_descriptor(
            StreamKind::RdpSession,
            1,
            BTreeMap::from([("width".into(), StreamParameter::Unsigned(1920))]),
            StreamTarget {
                host: "rdp.internal".into(),
                port: 3389,
            },
            StreamCorrelation {
                session_id: "31a0ae31-4116-4909-95be-0b81c1ab2ad9".into(),
                transfer_id: None,
            },
        );
        assert_eq!(descriptor.domain, PerformanceDomain::Rdp);
        assert!(Uuid::parse_str(&descriptor.id).is_ok());
    }
}
