//! Pulse Protocol v1 UDP JSON 编码与快照拆包。

use crate::{
    ClosedBody, ClosedMessage, LATEST_SCHEMA_VERSION, MAX_DATAGRAM_BYTES, Message, MetricPoint,
    MetricWindow, OpenedMessage, ProtocolError, SnapshotMessage, Source, StreamDescriptor,
    StreamOutcome, StreamReference, decode_datagram, validate_metric,
};

const MAX_WIRE_INTEGER: u64 = i64::MAX as u64;
const MAX_SNAPSHOT_PARTS: usize = 256;

/// 一次快照编码结果。
#[derive(Debug)]
pub struct SnapshotEncoding {
    /// 可直接发送的数据报。
    pub datagrams: Vec<Vec<u8>>,
    /// 因非法或单点超限被拒绝的指标数。
    pub rejected_metrics: u64,
    /// 下一个可用流序列号。
    pub next_sequence: u64,
}

/// 编码并通过共享协议校验流打开消息。
pub fn encode_stream_opened(
    source: &Source,
    stream: &StreamDescriptor,
    sequence: u64,
    sent_at_unix_ms: u64,
) -> Result<Vec<u8>, ProtocolError> {
    if sequence != 0
        || stream.started_at_unix_ms == 0
        || stream.started_at_unix_ms > sent_at_unix_ms
        || sent_at_unix_ms > MAX_WIRE_INTEGER
    {
        return Err(ProtocolError::InvalidStream);
    }
    encode_validated(&Message::StreamOpened(OpenedMessage {
        schema_version: LATEST_SCHEMA_VERSION,
        source: source.clone(),
        stream: stream.clone(),
        sequence,
        sent_at_unix_ms,
    }))
}

/// 编码并通过共享协议校验流关闭消息。
pub fn encode_stream_closed(
    source: &Source,
    stream: &StreamDescriptor,
    outcome: StreamOutcome,
    ended_at_unix_ms: u64,
    sequence: u64,
    sent_at_unix_ms: u64,
) -> Result<Vec<u8>, ProtocolError> {
    if sequence == 0
        || sequence > MAX_WIRE_INTEGER
        || ended_at_unix_ms == 0
        || ended_at_unix_ms > sent_at_unix_ms
        || sent_at_unix_ms > MAX_WIRE_INTEGER
    {
        return Err(ProtocolError::InvalidStream);
    }
    encode_validated(&Message::StreamClosed(ClosedMessage {
        schema_version: LATEST_SCHEMA_VERSION,
        source: source.clone(),
        stream: stream_reference(stream),
        sequence,
        sent_at_unix_ms,
        closed: ClosedBody {
            outcome,
            ended_at_unix_ms,
        },
    }))
}

/// 编码并按完整指标拆分快照。
#[allow(clippy::too_many_arguments)]
pub fn encode_stream_snapshot(
    source: &Source,
    stream: &StreamDescriptor,
    window: MetricWindow,
    mut metrics: Vec<MetricPoint>,
    sequence: u64,
    batch_id: &str,
    sent_at_unix_ms: u64,
) -> Result<SnapshotEncoding, ProtocolError> {
    if sequence == 0
        || sequence > MAX_WIRE_INTEGER
        || window.started_at_unix_ms == 0
        || window.duration_ms == 0
        || window
            .started_at_unix_ms
            .checked_add(window.duration_ms)
            .is_none_or(|ended_at| ended_at > sent_at_unix_ms)
        || sent_at_unix_ms > MAX_WIRE_INTEGER
    {
        return Err(ProtocolError::InvalidSnapshot);
    }
    metrics.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.attributes.cmp(&right.attributes))
    });

    let mut valid = Vec::with_capacity(metrics.len());
    let mut rejected_metrics = 0_u64;
    for metric in metrics {
        if validate_metric(&metric).is_ok() && metric.name.starts_with(domain_prefix(stream.domain))
        {
            valid.push(metric);
        } else {
            rejected_metrics = rejected_metrics.saturating_add(1);
        }
    }

    let mut chunks: Vec<Vec<MetricPoint>> = Vec::new();
    for metric in valid {
        let mut candidate = chunks.last().cloned().unwrap_or_default();
        candidate.push(metric.clone());
        if encoded_snapshot_len(
            source,
            stream,
            window,
            &candidate,
            u64::MAX,
            batch_id,
            u32::MAX,
            u32::MAX,
            sent_at_unix_ms,
        )? <= MAX_DATAGRAM_BYTES
        {
            if let Some(last) = chunks.last_mut() {
                *last = candidate;
            } else {
                chunks.push(candidate);
            }
        } else if encoded_snapshot_len(
            source,
            stream,
            window,
            std::slice::from_ref(&metric),
            u64::MAX,
            batch_id,
            u32::MAX,
            u32::MAX,
            sent_at_unix_ms,
        )? <= MAX_DATAGRAM_BYTES
        {
            chunks.push(vec![metric]);
        } else {
            rejected_metrics = rejected_metrics.saturating_add(1);
        }
    }

    if chunks.len() > MAX_SNAPSHOT_PARTS {
        return Err(ProtocolError::InvalidSnapshot);
    }
    let part_count = u32::try_from(chunks.len()).unwrap_or(u32::MAX);
    let mut datagrams = Vec::with_capacity(chunks.len());
    let mut next_sequence = sequence;
    for (index, chunk) in chunks.into_iter().enumerate() {
        let message = snapshot_message(
            source,
            stream,
            window,
            chunk,
            next_sequence,
            batch_id,
            u32::try_from(index).unwrap_or(u32::MAX),
            part_count,
            sent_at_unix_ms,
        );
        datagrams.push(encode_validated(&message)?);
        next_sequence = next_sequence
            .checked_add(1)
            .filter(|sequence| *sequence <= MAX_WIRE_INTEGER)
            .ok_or(ProtocolError::InvalidSnapshot)?;
    }

    Ok(SnapshotEncoding {
        datagrams,
        rejected_metrics,
        next_sequence,
    })
}

fn domain_prefix(domain: crate::PerformanceDomain) -> &'static str {
    match domain {
        crate::PerformanceDomain::Sftp => "fluxterm.sftp.",
        crate::PerformanceDomain::Rdp => "fluxterm.rdp.",
    }
}

fn stream_reference(stream: &StreamDescriptor) -> StreamReference {
    StreamReference {
        id: stream.id.clone(),
        domain: stream.domain,
        kind: stream.kind,
        target: stream.target.clone(),
        correlation: stream.correlation.clone(),
    }
}

#[allow(clippy::too_many_arguments)]
fn snapshot_message(
    source: &Source,
    stream: &StreamDescriptor,
    window: MetricWindow,
    metrics: Vec<MetricPoint>,
    sequence: u64,
    batch_id: &str,
    part_index: u32,
    part_count: u32,
    sent_at_unix_ms: u64,
) -> Message {
    Message::MetricsSnapshot(SnapshotMessage {
        schema_version: LATEST_SCHEMA_VERSION,
        source: source.clone(),
        stream: stream_reference(stream),
        sequence,
        batch_id: batch_id.to_string(),
        part_index,
        part_count,
        sent_at_unix_ms,
        window,
        metrics,
    })
}

#[allow(clippy::too_many_arguments)]
fn encoded_snapshot_len(
    source: &Source,
    stream: &StreamDescriptor,
    window: MetricWindow,
    metrics: &[MetricPoint],
    sequence: u64,
    batch_id: &str,
    part_index: u32,
    part_count: u32,
    sent_at_unix_ms: u64,
) -> Result<usize, ProtocolError> {
    Ok(serde_json::to_vec(&snapshot_message(
        source,
        stream,
        window,
        metrics.to_vec(),
        sequence,
        batch_id,
        part_index,
        part_count,
        sent_at_unix_ms,
    ))?
    .len())
}

fn encode_validated(message: &Message) -> Result<Vec<u8>, ProtocolError> {
    let bytes = serde_json::to_vec(message)?;
    decode_datagram(&bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::{
        DeviceIdentity, MetricUnit, StreamCorrelation, StreamKind, StreamParameter, StreamTarget,
        create_stream_descriptor, gauge_metric,
    };

    fn source() -> Source {
        Source {
            application: "fluxterm".into(),
            version: "test".into(),
            instance_id: "7d28b773-9bea-47a6-93a1-b52da63b74fa".into(),
            device: DeviceIdentity {
                id: "27ec5c1f-73d8-45d6-a3dc-6242203fc777".into(),
                name: Some("WORKSTATION-01".into()),
            },
            platform: "windows".into(),
            arch: "x86_64".into(),
            build_profile: "test".into(),
        }
    }

    fn stream(kind: StreamKind) -> StreamDescriptor {
        create_stream_descriptor(
            kind,
            1,
            if kind == StreamKind::RdpSession {
                BTreeMap::from([
                    ("width".into(), StreamParameter::Unsigned(1920)),
                    ("height".into(), StreamParameter::Unsigned(1080)),
                    ("wallpaper".into(), StreamParameter::Bool(false)),
                    ("fullWindowDrag".into(), StreamParameter::Bool(false)),
                    ("menuAnimations".into(), StreamParameter::Bool(false)),
                    ("theming".into(), StreamParameter::Bool(true)),
                    ("cursorShadow".into(), StreamParameter::Bool(false)),
                    ("cursorSettings".into(), StreamParameter::Bool(true)),
                    ("fontSmoothing".into(), StreamParameter::Bool(true)),
                    ("desktopComposition".into(), StreamParameter::Bool(true)),
                ])
            } else {
                BTreeMap::from([
                    (
                        "chunkSizeBytes".into(),
                        StreamParameter::Unsigned(32 * 1024),
                    ),
                    ("requestWindow".into(), StreamParameter::Unsigned(8)),
                    ("workerCount".into(), StreamParameter::Unsigned(1)),
                ])
            },
            StreamTarget {
                host: "server.internal".into(),
                port: if kind == StreamKind::RdpSession {
                    3389
                } else {
                    22
                },
            },
            StreamCorrelation {
                session_id: "31a0ae31-4116-4909-95be-0b81c1ab2ad9".into(),
                transfer_id: (kind != StreamKind::RdpSession).then(|| "sftp-1".into()),
            },
        )
    }

    #[test]
    fn lifecycle_messages_round_trip_through_shared_protocol() {
        let stream = stream(StreamKind::SftpUploadFile);
        let opened = encode_stream_opened(&source(), &stream, 0, 1).expect("opened");
        assert!(matches!(
            decode_datagram(&opened).expect("decode opened"),
            Message::StreamOpened(_)
        ));
        let closed = encode_stream_closed(&source(), &stream, StreamOutcome::Succeeded, 2, 1, 2)
            .expect("closed");
        assert!(matches!(
            decode_datagram(&closed).expect("decode closed"),
            Message::StreamClosed(_)
        ));
    }

    #[test]
    fn snapshot_is_split_bounded_and_round_trips() {
        let stream = stream(StreamKind::RdpSession);
        let metrics = (0..20)
            .map(|_| {
                gauge_metric(
                    "fluxterm.rdp.renderer.fps",
                    MetricUnit::FramePerSecond,
                    60.0,
                )
            })
            .collect();
        let batch_id = format!("{}:0", stream.id);
        let encoded = encode_stream_snapshot(
            &source(),
            &stream,
            MetricWindow {
                started_at_unix_ms: 1,
                duration_ms: 1000,
            },
            metrics,
            1,
            &batch_id,
            1001,
        )
        .expect("snapshot");
        assert!(encoded.datagrams.len() > 1);
        assert_eq!(
            encoded.next_sequence,
            1 + u64::try_from(encoded.datagrams.len()).expect("count")
        );
        for datagram in encoded.datagrams {
            assert!(datagram.len() <= MAX_DATAGRAM_BYTES);
            assert!(matches!(
                decode_datagram(&datagram).expect("decode snapshot"),
                Message::MetricsSnapshot(_)
            ));
        }
    }

    #[test]
    fn rejects_invalid_source_stream_parameters_and_filters_invalid_metric() {
        let mut invalid_source = source();
        invalid_source.application = "other".into();
        assert!(
            encode_stream_opened(&invalid_source, &stream(StreamKind::RdpSession), 0, 1).is_err()
        );

        let mut invalid_stream = stream(StreamKind::RdpSession);
        invalid_stream.target.host = "https://rdp.internal/path".into();
        assert!(encode_stream_opened(&source(), &invalid_stream, 0, 1).is_err());

        let mut invalid_parameters = stream(StreamKind::SftpUploadFile);
        invalid_parameters
            .parameters
            .insert("path".into(), StreamParameter::Text("sensitive".into()));
        assert!(encode_stream_opened(&source(), &invalid_parameters, 0, 1).is_err());

        let stream = stream(StreamKind::RdpSession);
        let batch_id = format!("{}:0", stream.id);
        let encoded = encode_stream_snapshot(
            &source(),
            &stream,
            MetricWindow {
                started_at_unix_ms: 1,
                duration_ms: 1000,
            },
            vec![gauge_metric("fluxterm.unknown", MetricUnit::Count, 1.0)],
            1,
            &batch_id,
            1001,
        )
        .expect("empty encoding");
        assert_eq!(encoded.rejected_metrics, 1);
        assert!(encoded.datagrams.is_empty());
    }
}
