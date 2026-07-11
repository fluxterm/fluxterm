//! 代理后端抽象与内置实现。
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::runtime::Runtime;
use tokio::time::{Duration, Instant, sleep};

use crate::error::EngineError;
use crate::proxy::{ProxyHandle, close_proxy, open_proxy};
use crate::proxy_error_codes::{PROXY_BIND_CONFLICT, PROXY_NOT_FOUND, PROXY_SHUTDOWN_TIMEOUT};
use crate::telemetry::{TelemetryLevel, log_telemetry};
use crate::types::{EventCallback, ProxyRuntime, ProxySpec, ProxyStatus};

const CLOSE_WAIT_TIMEOUT_MS: u64 = 2500;

/// 代理后端抽象。
pub trait ProxyBackend: Send + Sync {
    /// 创建代理实例。
    fn open(
        &self,
        spec: ProxySpec,
        on_event: EventCallback,
        trace_id: Option<&str>,
    ) -> Result<ProxyRuntime, EngineError>;
    /// 关闭代理实例。
    fn close(&self, proxy_id: &str, trace_id: Option<&str>) -> Result<(), EngineError>;
    /// 获取代理实例列表。
    fn list(&self) -> Result<Vec<ProxyRuntime>, EngineError>;
    /// 关闭全部代理实例。
    fn close_all(&self, trace_id: Option<&str>) -> Result<(), EngineError>;
}

/// 内置代理后端（当前手写实现）。
pub struct BuiltinProxyBackend {
    proxies: Mutex<HashMap<String, ProxyHandle>>,
    runtime: Arc<Runtime>,
}

impl BuiltinProxyBackend {
    /// 创建内置代理后端。
    pub fn new(runtime: Arc<Runtime>) -> Self {
        Self {
            proxies: Mutex::new(HashMap::new()),
            runtime,
        }
    }

    fn wait_stopped(&self, handle: &ProxyHandle) -> bool {
        self.runtime.block_on(async {
            let deadline = Instant::now() + Duration::from_millis(CLOSE_WAIT_TIMEOUT_MS);
            loop {
                let snapshot = handle.snapshot().await;
                if matches!(snapshot.status, ProxyStatus::Stopped | ProxyStatus::Failed) {
                    return true;
                }
                if Instant::now() >= deadline {
                    return false;
                }
                sleep(Duration::from_millis(30)).await;
            }
        })
    }
}

impl ProxyBackend for BuiltinProxyBackend {
    fn open(
        &self,
        mut spec: ProxySpec,
        on_event: EventCallback,
        trace_id: Option<&str>,
    ) -> Result<ProxyRuntime, EngineError> {
        spec.bind_host = normalize_bind_host(&spec.bind_host);
        let request_key = format!("{}:{}", spec.bind_host, spec.bind_port);
        {
            let mut proxies = self.proxies.lock().unwrap();
            let stale_ids = proxies
                .iter()
                .filter_map(|(id, handle)| {
                    let snapshot = self.runtime.block_on(handle.snapshot());
                    match snapshot.status {
                        ProxyStatus::Stopped | ProxyStatus::Failed => Some(id.clone()),
                        _ => None,
                    }
                })
                .collect::<Vec<_>>();
            stale_ids.into_iter().for_each(|id| {
                proxies.remove(&id);
            });

            let conflict = proxies.values().any(|handle| {
                let snapshot = self.runtime.block_on(handle.snapshot());
                let current_key = format!(
                    "{}:{}",
                    normalize_bind_host(&snapshot.bind_host),
                    snapshot.bind_port
                );
                current_key == request_key
            });
            if conflict {
                log_telemetry(
                    TelemetryLevel::Warn,
                    "proxy.create.failed",
                    trace_id,
                    json!({
                        "error": {
                            "code": PROXY_BIND_CONFLICT,
                            "message": format!("Proxy listener address already exists: {request_key}"),
                        },
                        "bindHost": spec.bind_host,
                        "bindPort": spec.bind_port,
                    }),
                );
                return Err(EngineError::new(
                    PROXY_BIND_CONFLICT,
                    format!("Proxy listener address already exists: {request_key}"),
                ));
            }
        }

        let handle = self
            .runtime
            .block_on(open_proxy(spec, on_event, trace_id))?;
        let snapshot = self.runtime.block_on(handle.snapshot());
        log_telemetry(
            TelemetryLevel::Info,
            "proxy.create.success",
            trace_id,
            json!({
                "proxyId": snapshot.proxy_id,
                "protocol": snapshot.protocol,
                "bindHost": snapshot.bind_host,
                "bindPort": snapshot.bind_port,
            }),
        );
        self.proxies
            .lock()
            .unwrap()
            .insert(snapshot.proxy_id.clone(), handle);
        Ok(snapshot)
    }

    fn close(&self, proxy_id: &str, trace_id: Option<&str>) -> Result<(), EngineError> {
        let handle = self
            .proxies
            .lock()
            .unwrap()
            .remove(proxy_id)
            .ok_or_else(|| EngineError::new(PROXY_NOT_FOUND, "Proxy instance not found"))?;
        log_telemetry(
            TelemetryLevel::Info,
            "proxy.close.start",
            trace_id,
            json!({
                "proxyId": proxy_id,
            }),
        );
        close_proxy(&handle);
        if !self.wait_stopped(&handle) {
            return Err(EngineError::new(
                PROXY_SHUTDOWN_TIMEOUT,
                "Proxy instance shutdown timed out",
            ));
        }
        log_telemetry(
            TelemetryLevel::Info,
            "proxy.close.success",
            trace_id,
            json!({
                "proxyId": proxy_id,
            }),
        );
        Ok(())
    }

    fn list(&self) -> Result<Vec<ProxyRuntime>, EngineError> {
        let mut list = {
            let handles = self.proxies.lock().unwrap();
            handles
                .values()
                .map(|handle| self.runtime.block_on(handle.snapshot()))
                .collect::<Vec<_>>()
        };
        list.sort_by(|a, b| a.proxy_id.cmp(&b.proxy_id));
        Ok(list)
    }

    fn close_all(&self, trace_id: Option<&str>) -> Result<(), EngineError> {
        let handles = self
            .proxies
            .lock()
            .unwrap()
            .drain()
            .collect::<HashMap<String, ProxyHandle>>();
        log_telemetry(
            TelemetryLevel::Info,
            "proxy.close.all.start",
            trace_id,
            json!({
                "count": handles.len(),
            }),
        );
        handles.values().for_each(|handle| {
            handle.close();
        });
        let all_stopped = handles.values().all(|handle| self.wait_stopped(handle));
        if !all_stopped {
            return Err(EngineError::new(
                PROXY_SHUTDOWN_TIMEOUT,
                "Timed out while closing proxy instances",
            ));
        }
        log_telemetry(
            TelemetryLevel::Info,
            "proxy.close.all.success",
            trace_id,
            json!({}),
        );
        Ok(())
    }
}

/// 归一化代理监听主机，用于唯一性比较。
fn normalize_bind_host(value: &str) -> String {
    let mut normalized = value.trim().to_ascii_lowercase();
    if let Some(inner) = normalized
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    {
        normalized = inner.to_string();
    }
    if normalized == "localhost" {
        return "127.0.0.1".to_string();
    }
    if let Ok(ip) = normalized.parse::<IpAddr>() {
        return ip.to_string();
    }
    normalized
}
