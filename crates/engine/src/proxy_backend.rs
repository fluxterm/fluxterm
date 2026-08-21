//! 代理后端抽象与内置实现。
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::runtime::Runtime;
use tokio::time::{Duration, Instant, sleep};

use crate::error::EngineError;
use crate::proxy::{ProxyHandle, close_proxy, open_proxy};
use crate::proxy_error_codes::{
    PROXY_BIND_CONFLICT_CODE, PROXY_NOT_FOUND_CODE, PROXY_SHUTDOWN_TIMEOUT_CODE,
};
use crate::types::{EventCallback, ProxyRuntime, ProxySpec, ProxyStatus};
use fluxterm_logging::{LogLevel, log_event};

const CLOSE_WAIT_TIMEOUT_MS: u64 = 2500;

/// 代理后端抽象。
pub trait ProxyBackend: Send + Sync {
    /// 创建代理实例。
    fn open(
        &self,
        spec: ProxySpec,
        on_event: EventCallback,
        operation_id: Option<&str>,
    ) -> Result<ProxyRuntime, EngineError>;
    /// 关闭代理实例。
    fn close(&self, proxy_id: &str, operation_id: Option<&str>) -> Result<(), EngineError>;
    /// 获取代理实例列表。
    fn list(&self) -> Result<Vec<ProxyRuntime>, EngineError>;
    /// 关闭全部代理实例。
    fn close_all(&self, operation_id: Option<&str>) -> Result<(), EngineError>;
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
        operation_id: Option<&str>,
    ) -> Result<ProxyRuntime, EngineError> {
        let started = Instant::now();
        spec.bind_host = normalize_bind_host(&spec.bind_host);
        let request_key = format!("{}:{}", spec.bind_host, spec.bind_port);
        log_event!(
            LogLevel::Debug,
            "proxy.create.started",
            operation_id,
            json!({
                "protocol": spec.protocol,
                "bindHost": spec.bind_host,
                "bindPort": spec.bind_port,
                "authEnabled": spec.auth.is_some(),
            }),
        );
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
                log_event!(
                    LogLevel::Warn,
                    "proxy.create.failed",
                    operation_id,
                    json!({
                        "error": {
                            "code": PROXY_BIND_CONFLICT_CODE,
                            "message": "Proxy listener address already exists",
                            "detail": request_key.clone(),
                        },
                        "bindHost": spec.bind_host,
                        "bindPort": spec.bind_port,
                        "durationMs": started.elapsed().as_millis(),
                    }),
                );
                return Err(EngineError::with_detail(
                    PROXY_BIND_CONFLICT_CODE,
                    "Proxy listener address already exists",
                    request_key,
                ));
            }
        }

        let protocol = spec.protocol;
        let bind_host = spec.bind_host.clone();
        let bind_port = spec.bind_port;
        let handle = match self
            .runtime
            .block_on(open_proxy(spec, on_event, operation_id))
        {
            Ok(handle) => handle,
            Err(error) => {
                log_event!(
                    LogLevel::Warn,
                    "proxy.create.failed",
                    operation_id,
                    json!({
                        "protocol": protocol,
                        "bindHost": bind_host,
                        "bindPort": bind_port,
                        "durationMs": started.elapsed().as_millis(),
                        "error": {
                            "code": error.code.clone(),
                            "message": "Proxy creation failed",
                            "detail": error.details.clone().unwrap_or(error.message.clone()),
                        },
                    }),
                );
                return Err(error);
            }
        };
        let snapshot = self.runtime.block_on(handle.snapshot());
        log_event!(
            LogLevel::Info,
            "proxy.create.succeeded",
            operation_id,
            json!({
                "proxyId": snapshot.proxy_id,
                "protocol": snapshot.protocol,
                "bindHost": snapshot.bind_host,
                "bindPort": snapshot.bind_port,
                "durationMs": started.elapsed().as_millis(),
            }),
        );
        self.proxies
            .lock()
            .unwrap()
            .insert(snapshot.proxy_id.clone(), handle);
        Ok(snapshot)
    }

    fn close(&self, proxy_id: &str, operation_id: Option<&str>) -> Result<(), EngineError> {
        let started = Instant::now();
        log_event!(
            LogLevel::Debug,
            "proxy.close.started",
            operation_id,
            json!({
                "proxyId": proxy_id,
            }),
        );
        let handle = match self.proxies.lock().unwrap().remove(proxy_id) {
            Some(handle) => handle,
            None => {
                let error = EngineError::new(PROXY_NOT_FOUND_CODE, "Proxy instance not found");
                log_event!(
                    LogLevel::Warn,
                    "proxy.close.failed",
                    operation_id,
                    json!({
                        "proxyId": proxy_id,
                        "durationMs": started.elapsed().as_millis(),
                        "error": {
                            "code": error.code.clone(),
                            "message": "Proxy closure failed",
                            "detail": error.message.clone(),
                        },
                    }),
                );
                return Err(error);
            }
        };
        close_proxy(&handle);
        if !self.wait_stopped(&handle) {
            let error = EngineError::new(
                PROXY_SHUTDOWN_TIMEOUT_CODE,
                "Proxy instance shutdown timed out",
            );
            log_event!(
                LogLevel::Warn,
                "proxy.close.failed",
                operation_id,
                json!({
                    "proxyId": proxy_id,
                    "durationMs": started.elapsed().as_millis(),
                    "error": {
                        "code": error.code.clone(),
                        "message": "Proxy closure failed",
                        "detail": error.message.clone(),
                    },
                }),
            );
            return Err(error);
        }
        log_event!(
            LogLevel::Info,
            "proxy.close.succeeded",
            operation_id,
            json!({
                "proxyId": proxy_id,
                "durationMs": started.elapsed().as_millis(),
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

    fn close_all(&self, operation_id: Option<&str>) -> Result<(), EngineError> {
        let started = Instant::now();
        let handles = self
            .proxies
            .lock()
            .unwrap()
            .drain()
            .collect::<HashMap<String, ProxyHandle>>();
        log_event!(
            LogLevel::Debug,
            "proxy.close.all.started",
            operation_id,
            json!({
                "count": handles.len(),
            }),
        );
        handles.values().for_each(|handle| {
            handle.close();
        });
        let all_stopped = handles.values().all(|handle| self.wait_stopped(handle));
        if !all_stopped {
            let error = EngineError::new(
                PROXY_SHUTDOWN_TIMEOUT_CODE,
                "Timed out while closing proxy instances",
            );
            log_event!(
                LogLevel::Warn,
                "proxy.close.all.failed",
                operation_id,
                json!({
                    "count": handles.len(),
                    "durationMs": started.elapsed().as_millis(),
                    "error": {
                        "code": error.code.clone(),
                        "message": "Closing all proxy instances failed",
                        "detail": error.message.clone(),
                    },
                }),
            );
            return Err(error);
        }
        log_event!(
            LogLevel::Info,
            "proxy.close.all.succeeded",
            operation_id,
            json!({
                "count": handles.len(),
                "durationMs": started.elapsed().as_millis(),
            }),
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
