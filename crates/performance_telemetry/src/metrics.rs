//! 性能指标构造与固定桶直方图累加。

use std::collections::BTreeMap;

use crate::{HistogramValue, MetricKind, MetricPoint, MetricUnit, MetricValue};

/// 创建 gauge 指标点。
pub fn gauge_metric(name: impl Into<String>, unit: MetricUnit, value: f64) -> MetricPoint {
    scalar_metric(name, MetricKind::Gauge, unit, value)
}

/// 创建 counter delta 指标点。
pub fn counter_metric(name: impl Into<String>, unit: MetricUnit, value: f64) -> MetricPoint {
    scalar_metric(name, MetricKind::CounterDelta, unit, value)
}

fn scalar_metric(
    name: impl Into<String>,
    kind: MetricKind,
    unit: MetricUnit,
    value: f64,
) -> MetricPoint {
    MetricPoint {
        name: name.into(),
        kind,
        unit,
        value: MetricValue::Scalar(value),
        attributes: BTreeMap::new(),
    }
}

/// 创建 histogram 指标点。
pub fn histogram_metric(
    name: impl Into<String>,
    unit: MetricUnit,
    histogram: HistogramValue,
) -> MetricPoint {
    MetricPoint {
        name: name.into(),
        kind: MetricKind::Histogram,
        unit,
        value: MetricValue::Histogram(histogram),
        attributes: BTreeMap::new(),
    }
}

/// 固定桶直方图累加器。
#[derive(Debug, Clone)]
pub struct HistogramAccumulator {
    bounds: &'static [f64],
    bucket_counts: Vec<u64>,
    count: u64,
    sum: f64,
    min: f64,
    max: f64,
}

impl HistogramAccumulator {
    /// 创建空累加器。
    pub fn new(bounds: &'static [f64]) -> Self {
        Self {
            bounds,
            bucket_counts: vec![0; bounds.len() + 1],
            count: 0,
            sum: 0.0,
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
        }
    }

    /// 记录有限且非负的样本。
    pub fn record(&mut self, value: f64) {
        if !value.is_finite() || value < 0.0 {
            return;
        }
        let index = self
            .bounds
            .iter()
            .position(|bound| value <= *bound)
            .unwrap_or(self.bounds.len());
        self.bucket_counts[index] = self.bucket_counts[index].saturating_add(1);
        self.count = self.count.saturating_add(1);
        self.sum += value;
        self.min = self.min.min(value);
        self.max = self.max.max(value);
    }

    /// 取出当前窗口并重置。
    pub fn take(&mut self) -> Option<HistogramValue> {
        if self.count == 0 {
            return None;
        }
        let value = HistogramValue {
            count: self.count,
            sum: self.sum,
            min: self.min,
            max: self.max,
            bounds: self.bounds.to_vec(),
            bucket_counts: std::mem::replace(
                &mut self.bucket_counts,
                vec![0; self.bounds.len() + 1],
            ),
        };
        self.count = 0;
        self.sum = 0.0;
        self.min = f64::INFINITY;
        self.max = f64::NEG_INFINITY;
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ValidationError, definition, validate_metric};

    #[test]
    fn histogram_uses_protocol_catalog_buckets_and_resets() {
        let bounds = definition("fluxterm.rdp.renderer.frame_interval")
            .expect("registered metric")
            .histogram_bounds;
        let mut accumulator = HistogramAccumulator::new(bounds);
        accumulator.record(5.0);
        accumulator.record(16.0);
        accumulator.record(2000.0);
        let value = accumulator.take().expect("histogram");
        assert_eq!(value.count, 3);
        assert_eq!(value.bucket_counts.iter().sum::<u64>(), 3);
        assert!(accumulator.take().is_none());
    }

    #[test]
    fn constructors_create_protocol_metric_types() {
        let mut point = gauge_metric(
            "fluxterm.rdp.renderer.fps",
            MetricUnit::FramePerSecond,
            60.0,
        );
        assert!(validate_metric(&point).is_ok());
        point.attributes.insert("sessionId".into(), "secret".into());
        assert_eq!(
            validate_metric(&point),
            Err(ValidationError::InvalidAttribute)
        );
    }
}
