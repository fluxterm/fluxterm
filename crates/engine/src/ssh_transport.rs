//! SSH 出站连接与跳板链传输。
//!
//! 本模块只负责把目标 SSH 握手需要的字节流准备好。Profile 存储、凭据解密和
//! Host Key 信任策略仍由调用方负责，避免 engine 反向依赖 Tauri 存储层。
const SSH_JUMP_MISSING_CODE: &str = "ssh_jump_missing";
pub const SSH_CONNECT_FAILED_CODE: &str = "ssh_connect_failed";
pub const SSH_JUMP_DEPTH_EXCEEDED_CODE: &str = "ssh_jump_depth_exceeded";
const SSH_PROXY_AUTH_FAILED_CODE: &str = "ssh_proxy_auth_failed";
const SSH_PROXY_DNS_FAILED_CODE: &str = "ssh_proxy_dns_failed";
const SSH_PROXY_HTTP_FAILED_CODE: &str = "ssh_proxy_http_failed";
const SSH_PROXY_SOCKS5_FAILED_CODE: &str = "ssh_proxy_socks5_failed";

use std::net::IpAddr;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::process::Command;
use std::sync::Arc;

use base64::Engine as _;
use russh::client;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpStream, lookup_host};

use crate::auth::{AuthPurpose, authenticate};
use crate::error::EngineError;
use crate::session::{ClientHandler, ExpectedHostKey};
use crate::types::{HostProfile, SshProxyConfig, SshProxyMode, SshProxyProtocol};

const SSH_JUMP_MAX_DEPTH: usize = 8;

enum ProxyTarget {
    Domain(String),
    Ip(IpAddr),
}

/// 已解析并解密的跳板机运行时配置。
#[derive(Debug, Clone)]
pub struct JumpHostProfile {
    pub profile: HostProfile,
    pub expected_host_key: Option<ExpectedHostKey>,
}

/// 跳板链配置。
#[derive(Debug, Clone, Default)]
pub struct JumpHostSpec {
    pub hosts: Vec<JumpHostProfile>,
}

/// SSH 连接流。
pub enum SshTransportStream {
    Tcp(TcpStream),
    Channel(russh::ChannelStream<client::Msg>),
}

impl AsyncRead for SshTransportStream {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match &mut *self {
            SshTransportStream::Tcp(stream) => std::pin::Pin::new(stream).poll_read(cx, buf),
            SshTransportStream::Channel(stream) => std::pin::Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for SshTransportStream {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<Result<usize, std::io::Error>> {
        match &mut *self {
            SshTransportStream::Tcp(stream) => std::pin::Pin::new(stream).poll_write(cx, buf),
            SshTransportStream::Channel(stream) => std::pin::Pin::new(stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        match &mut *self {
            SshTransportStream::Tcp(stream) => std::pin::Pin::new(stream).poll_flush(cx),
            SshTransportStream::Channel(stream) => std::pin::Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        match &mut *self {
            SshTransportStream::Tcp(stream) => std::pin::Pin::new(stream).poll_shutdown(cx),
            SshTransportStream::Channel(stream) => std::pin::Pin::new(stream).poll_shutdown(cx),
        }
    }
}

/// 已建立的 SSH 客户端连接，保留中间跳板句柄直到目标句柄释放。
pub struct SshClientConnection {
    pub handle: client::Handle<ClientHandler>,
    _jump_handles: Vec<client::Handle<ClientHandler>>,
}

/// 建立目标 SSH 客户端连接。
pub async fn connect_ssh_client(
    profile: &HostProfile,
    expected_host_key: Option<ExpectedHostKey>,
    jump_spec: &JumpHostSpec,
    handler: ClientHandler,
    operation_id: Option<&str>,
) -> Result<SshClientConnection, EngineError> {
    if jump_spec.hosts.len() > SSH_JUMP_MAX_DEPTH {
        return Err(EngineError::with_detail(
            SSH_JUMP_DEPTH_EXCEEDED_CODE,
            "Jump chain exceeds the maximum depth",
            format!(
                "maxDepth={SSH_JUMP_MAX_DEPTH} actual={}",
                jump_spec.hosts.len()
            ),
        ));
    }

    let mut jump_handles = Vec::new();
    for (index, jump) in jump_spec.hosts.iter().enumerate() {
        let handler = handler_for_expected(jump.expected_host_key.clone());
        let mut handle = if index == 0 {
            let stream = connect_entry_stream(&jump.profile).await?;
            connect_stream_with_handler(stream, handler).await?
        } else {
            let stream = open_direct_stream(
                jump_handles.last().ok_or_else(|| {
                    EngineError::new(SSH_JUMP_MISSING_CODE, "Jump chain state is missing")
                })?,
                &jump.profile,
            )
            .await?;
            connect_stream_with_handler(stream, handler).await?
        };
        authenticate(&mut handle, &jump.profile, AuthPurpose::Jump, operation_id).await?;
        jump_handles.push(handle);
    }

    let handle = if let Some(last_jump) = jump_handles.last() {
        let stream = open_direct_stream(last_jump, profile).await?;
        connect_stream_with_handler(stream, handler).await?
    } else {
        let stream = connect_entry_stream(profile).await?;
        connect_stream_with_handler(stream, handler).await?
    };

    // 目标连接的 Host Key 在 handler 内校验；这里仅让类型系统持有 expected 的生命周期语义。
    let _ = expected_host_key;
    Ok(SshClientConnection {
        handle,
        _jump_handles: jump_handles,
    })
}

/// 为 Host Key 预检建立目标 SSH 流，跳板链会先完成认证。
pub async fn connect_probe_client<H>(
    profile: &HostProfile,
    jump_spec: &JumpHostSpec,
    handler: H,
) -> Result<client::Handle<H>, EngineError>
where
    H: client::Handler + Send + 'static,
    H::Error: std::fmt::Display,
{
    if jump_spec.hosts.len() > SSH_JUMP_MAX_DEPTH {
        return Err(EngineError::with_detail(
            SSH_JUMP_DEPTH_EXCEEDED_CODE,
            "Jump chain exceeds the maximum depth",
            format!(
                "maxDepth={SSH_JUMP_MAX_DEPTH} actual={}",
                jump_spec.hosts.len()
            ),
        ));
    }
    let mut jump_handles = Vec::new();
    for (index, jump) in jump_spec.hosts.iter().enumerate() {
        let jump_handler = handler_for_expected(jump.expected_host_key.clone());
        let mut handle = if index == 0 {
            let stream = connect_entry_stream(&jump.profile).await?;
            connect_stream_with_handler(stream, jump_handler).await?
        } else {
            let stream = open_direct_stream(
                jump_handles.last().ok_or_else(|| {
                    EngineError::new(SSH_JUMP_MISSING_CODE, "Jump chain state is missing")
                })?,
                &jump.profile,
            )
            .await?;
            connect_stream_with_handler(stream, jump_handler).await?
        };
        authenticate(&mut handle, &jump.profile, AuthPurpose::Jump, None).await?;
        jump_handles.push(handle);
    }
    let stream = if let Some(last_jump) = jump_handles.last() {
        open_direct_stream(last_jump, profile).await?
    } else {
        connect_entry_stream(profile).await?
    };
    connect_stream_with_handler(stream, handler).await
}

fn handler_for_expected(expected: Option<ExpectedHostKey>) -> ClientHandler {
    match expected {
        Some(expected) => ClientHandler::with_expected(expected),
        None => ClientHandler::unchecked(),
    }
}

async fn connect_stream_with_handler<H>(
    stream: SshTransportStream,
    handler: H,
) -> Result<client::Handle<H>, EngineError>
where
    H: client::Handler + Send + 'static,
    H::Error: std::fmt::Display,
{
    client::connect_stream(Arc::new(client::Config::default()), stream, handler)
        .await
        .map_err(|err| {
            EngineError::with_detail(
                SSH_CONNECT_FAILED_CODE,
                "Failed to connect to target host",
                err.to_string(),
            )
        })
}

async fn open_direct_stream(
    jump: &client::Handle<ClientHandler>,
    profile: &HostProfile,
) -> Result<SshTransportStream, EngineError> {
    let channel = jump
        .channel_open_direct_tcpip(profile.host.clone(), profile.port as u32, "127.0.0.1", 0)
        .await
        .map_err(|err| {
            EngineError::with_detail(
                "ssh_jump_connect_failed",
                "Failed to connect to the next hop through the jump host",
                err.to_string(),
            )
        })?;
    Ok(SshTransportStream::Channel(channel.into_stream()))
}

async fn connect_entry_stream(profile: &HostProfile) -> Result<SshTransportStream, EngineError> {
    let proxy_mode = profile.proxy_mode.unwrap_or_default();
    match proxy_mode {
        SshProxyMode::Direct => connect_direct(profile).await,
        SshProxyMode::System => match resolve_system_proxy(&profile.host) {
            Some(proxy) => connect_proxy(profile, &proxy).await,
            None => connect_direct(profile).await,
        },
        SshProxyMode::Manual => {
            let proxy = profile.proxy_config.as_ref().ok_or_else(|| {
                EngineError::new(
                    "ssh_proxy_config_missing",
                    "SSH proxy configuration is missing",
                )
            })?;
            connect_proxy(profile, proxy).await
        }
    }
}

async fn connect_direct(profile: &HostProfile) -> Result<SshTransportStream, EngineError> {
    TcpStream::connect((profile.host.as_str(), profile.port))
        .await
        .map(SshTransportStream::Tcp)
        .map_err(|err| {
            EngineError::with_detail(
                SSH_CONNECT_FAILED_CODE,
                "Failed to connect to target host",
                err.to_string(),
            )
        })
}

async fn connect_proxy(
    profile: &HostProfile,
    proxy: &SshProxyConfig,
) -> Result<SshTransportStream, EngineError> {
    validate_proxy(proxy)?;
    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(|err| {
            EngineError::with_detail(
                "ssh_proxy_connect_failed",
                "Failed to connect to SSH proxy",
                err.to_string(),
            )
        })?;
    match proxy.protocol {
        SshProxyProtocol::Http => http_connect(&mut stream, profile, proxy).await?,
        SshProxyProtocol::Socks5 => socks5_connect(&mut stream, profile, proxy).await?,
    }
    Ok(SshTransportStream::Tcp(stream))
}

async fn resolve_proxy_target(
    profile: &HostProfile,
    proxy: &SshProxyConfig,
) -> Result<ProxyTarget, EngineError> {
    if proxy.use_proxy_dns.unwrap_or(true) {
        return Ok(ProxyTarget::Domain(profile.host.clone()));
    }
    if let Ok(ip) = profile.host.parse::<IpAddr>() {
        return Ok(ProxyTarget::Ip(ip));
    }
    let mut addrs = lookup_host((profile.host.as_str(), profile.port))
        .await
        .map_err(|err| {
            EngineError::with_detail(
                SSH_PROXY_DNS_FAILED_CODE,
                "Local DNS failed to resolve target host",
                err.to_string(),
            )
        })?;
    let addr = addrs.next().ok_or_else(|| {
        EngineError::new(
            SSH_PROXY_DNS_FAILED_CODE,
            "Local DNS did not return a usable target address",
        )
    })?;
    Ok(ProxyTarget::Ip(addr.ip()))
}

fn validate_proxy(proxy: &SshProxyConfig) -> Result<(), EngineError> {
    if proxy.host.trim().is_empty() || proxy.port == 0 {
        return Err(EngineError::new(
            "ssh_proxy_config_invalid",
            "Invalid SSH proxy configuration",
        ));
    }
    Ok(())
}

async fn http_connect(
    stream: &mut TcpStream,
    profile: &HostProfile,
    proxy: &SshProxyConfig,
) -> Result<(), EngineError> {
    let target_host = match resolve_proxy_target(profile, proxy).await? {
        ProxyTarget::Domain(host) => host,
        ProxyTarget::Ip(IpAddr::V4(ip)) => ip.to_string(),
        ProxyTarget::Ip(IpAddr::V6(ip)) => format!("[{ip}]"),
    };
    let target = format!("{}:{}", target_host, profile.port);
    let mut request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some(username) = proxy.username.as_deref().filter(|value| !value.is_empty()) {
        let password = proxy.password_ref.as_deref().unwrap_or("");
        let encoded =
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
        request.push_str(&format!("Proxy-Authorization: Basic {encoded}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await.map_err(|err| {
        EngineError::with_detail(
            SSH_PROXY_HTTP_FAILED_CODE,
            "HTTP proxy handshake failed",
            err.to_string(),
        )
    })?;

    let mut response = Vec::with_capacity(256);
    let mut buf = [0_u8; 1];
    while response.len() < 8192 {
        let n = stream.read(&mut buf).await.map_err(|err| {
            EngineError::with_detail(
                SSH_PROXY_HTTP_FAILED_CODE,
                "HTTP proxy handshake failed",
                err.to_string(),
            )
        })?;
        if n == 0 {
            break;
        }
        response.push(buf[0]);
        if response.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&response);
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    match status {
        200 => Ok(()),
        407 => Err(EngineError::new(
            SSH_PROXY_AUTH_FAILED_CODE,
            "HTTP proxy authentication failed",
        )),
        _ => Err(EngineError::with_detail(
            SSH_PROXY_HTTP_FAILED_CODE,
            "HTTP proxy rejected the connection",
            text.lines().next().unwrap_or("").to_string(),
        )),
    }
}

async fn socks5_connect(
    stream: &mut TcpStream,
    profile: &HostProfile,
    proxy: &SshProxyConfig,
) -> Result<(), EngineError> {
    let has_auth = proxy
        .username
        .as_deref()
        .is_some_and(|value| !value.is_empty());
    let methods = if has_auth {
        vec![0x05, 0x02, 0x00, 0x02]
    } else {
        vec![0x05, 0x01, 0x00]
    };
    stream.write_all(&methods).await.map_err(socks_io_error)?;
    let mut selected = [0_u8; 2];
    stream
        .read_exact(&mut selected)
        .await
        .map_err(socks_io_error)?;
    if selected[0] != 0x05 {
        return Err(EngineError::new(
            SSH_PROXY_SOCKS5_FAILED_CODE,
            "Invalid SOCKS5 proxy response",
        ));
    }
    if selected[1] == 0xff {
        return Err(EngineError::new(
            SSH_PROXY_AUTH_FAILED_CODE,
            "SOCKS5 proxy does not accept the authentication method",
        ));
    }
    if selected[1] == 0x02 {
        socks5_auth(stream, proxy).await?;
    }

    let target = resolve_proxy_target(profile, proxy).await?;
    let mut request = vec![0x05, 0x01, 0x00];
    match target {
        ProxyTarget::Domain(host) => {
            let host_bytes = host.as_bytes();
            if host_bytes.len() > u8::MAX as usize {
                return Err(EngineError::new(
                    SSH_PROXY_SOCKS5_FAILED_CODE,
                    "SOCKS5 target host name is too long",
                ));
            }
            request.push(0x03);
            request.push(host_bytes.len() as u8);
            request.extend_from_slice(host_bytes);
        }
        ProxyTarget::Ip(IpAddr::V4(ip)) => {
            request.push(0x01);
            request.extend_from_slice(&ip.octets());
        }
        ProxyTarget::Ip(IpAddr::V6(ip)) => {
            request.push(0x04);
            request.extend_from_slice(&ip.octets());
        }
    }
    request.extend_from_slice(&profile.port.to_be_bytes());
    stream.write_all(&request).await.map_err(socks_io_error)?;

    let mut head = [0_u8; 4];
    stream.read_exact(&mut head).await.map_err(socks_io_error)?;
    if head[0] != 0x05 {
        return Err(EngineError::new(
            SSH_PROXY_SOCKS5_FAILED_CODE,
            "Invalid SOCKS5 proxy response",
        ));
    }
    if head[1] != 0x00 {
        return Err(EngineError::with_detail(
            SSH_PROXY_SOCKS5_FAILED_CODE,
            "SOCKS5 proxy failed to connect to target",
            format!("reply={}", head[1]),
        ));
    }
    read_socks5_bound_addr(stream, head[3]).await?;
    Ok(())
}

async fn socks5_auth(stream: &mut TcpStream, proxy: &SshProxyConfig) -> Result<(), EngineError> {
    let username = proxy.username.as_deref().unwrap_or("");
    let password = proxy.password_ref.as_deref().unwrap_or("");
    if username.len() > u8::MAX as usize || password.len() > u8::MAX as usize {
        return Err(EngineError::new(
            SSH_PROXY_AUTH_FAILED_CODE,
            "SOCKS5 proxy credentials are too long",
        ));
    }
    let mut request = vec![0x01, username.len() as u8];
    request.extend_from_slice(username.as_bytes());
    request.push(password.len() as u8);
    request.extend_from_slice(password.as_bytes());
    stream.write_all(&request).await.map_err(socks_io_error)?;
    let mut response = [0_u8; 2];
    stream
        .read_exact(&mut response)
        .await
        .map_err(socks_io_error)?;
    if response != [0x01, 0x00] {
        return Err(EngineError::new(
            SSH_PROXY_AUTH_FAILED_CODE,
            "SOCKS5 proxy authentication failed",
        ));
    }
    Ok(())
}

async fn read_socks5_bound_addr(stream: &mut TcpStream, atyp: u8) -> Result<(), EngineError> {
    match atyp {
        0x01 => {
            let mut data = [0_u8; 6];
            stream.read_exact(&mut data).await.map_err(socks_io_error)?;
        }
        0x03 => {
            let mut len = [0_u8; 1];
            stream.read_exact(&mut len).await.map_err(socks_io_error)?;
            let mut data = vec![0_u8; len[0] as usize + 2];
            stream.read_exact(&mut data).await.map_err(socks_io_error)?;
        }
        0x04 => {
            let mut data = [0_u8; 18];
            stream.read_exact(&mut data).await.map_err(socks_io_error)?;
        }
        _ => {
            return Err(EngineError::new(
                SSH_PROXY_SOCKS5_FAILED_CODE,
                "Invalid SOCKS5 address type",
            ));
        }
    }
    Ok(())
}

fn socks_io_error(err: std::io::Error) -> EngineError {
    EngineError::with_detail(
        SSH_PROXY_SOCKS5_FAILED_CODE,
        "SOCKS5 proxy handshake failed",
        err.to_string(),
    )
}

fn resolve_system_proxy(target_host: &str) -> Option<SshProxyConfig> {
    if should_bypass_proxy(target_host) {
        return None;
    }
    resolve_system_proxy_impl(target_host)
}

fn should_bypass_proxy(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}

#[cfg(target_os = "windows")]
fn resolve_system_proxy_impl(target_host: &str) -> Option<SshProxyConfig> {
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyEnable",
        ])
        .output()
        .ok()?;
    let enabled = String::from_utf8_lossy(&output.stdout).contains("0x1");
    if !enabled {
        return None;
    }
    if let Some(override_value) = read_windows_internet_setting("ProxyOverride")
        && windows_proxy_override_matches(&override_value, target_host)
    {
        return None;
    }
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyServer",
        ])
        .output()
        .ok()?;
    parse_windows_proxy_server(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "macos")]
fn resolve_system_proxy_impl(_target_host: &str) -> Option<SshProxyConfig> {
    let output = Command::new("scutil").arg("--proxy").output().ok()?;
    parse_macos_scutil_proxy(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn resolve_system_proxy_impl(_target_host: &str) -> Option<SshProxyConfig> {
    for key in [
        "ALL_PROXY",
        "all_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ] {
        if let Ok(value) = std::env::var(key)
            && let Some(proxy) = parse_proxy_url(&value)
        {
            return Some(proxy);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn read_windows_internet_setting(name: &str) -> Option<String> {
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            name,
        ])
        .output()
        .ok()?;
    parse_windows_reg_sz(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "windows")]
fn parse_windows_reg_sz(output: &str) -> Option<String> {
    output
        .split("REG_SZ")
        .nth(1)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(target_os = "windows")]
fn parse_windows_proxy_server(output: &str) -> Option<SshProxyConfig> {
    let value = parse_windows_reg_sz(output)?;
    let (candidate, protocol) = value
        .split(';')
        .find_map(|part| {
            part.strip_prefix("socks=")
                .map(|value| (value, SshProxyProtocol::Socks5))
                .or_else(|| {
                    part.strip_prefix("https=")
                        .map(|value| (value, SshProxyProtocol::Http))
                })
                .or_else(|| {
                    part.strip_prefix("http=")
                        .map(|value| (value, SshProxyProtocol::Http))
                })
        })
        .unwrap_or((value.as_str(), SshProxyProtocol::Http));
    parse_proxy_host_port(candidate, protocol)
}

#[cfg(target_os = "windows")]
fn windows_proxy_override_matches(override_value: &str, target_host: &str) -> bool {
    let host = normalize_proxy_override_host(target_host);
    override_value
        .split(';')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .any(|rule| {
            if rule.eq_ignore_ascii_case("<local>") {
                return !host.contains('.');
            }
            wildcard_match(&normalize_proxy_override_host(rule), &host)
        })
}

#[cfg(target_os = "windows")]
fn normalize_proxy_override_host(value: &str) -> String {
    let trimmed = value.trim().trim_matches(['[', ']']);
    trimmed
        .split(':')
        .next()
        .unwrap_or(trimmed)
        .to_ascii_lowercase()
}

#[cfg(target_os = "windows")]
fn wildcard_match(pattern: &str, value: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == value;
    }
    let mut rest = value;
    if let Some(first) = parts.first().filter(|part| !part.is_empty()) {
        let Some(next) = rest.strip_prefix(first) else {
            return false;
        };
        rest = next;
    }
    for part in parts.iter().skip(1).take(parts.len().saturating_sub(2)) {
        if part.is_empty() {
            continue;
        }
        let Some(index) = rest.find(part) else {
            return false;
        };
        rest = &rest[index + part.len()..];
    }
    if let Some(last) = parts.last().filter(|part| !part.is_empty()) {
        return rest.ends_with(last);
    }
    true
}

#[cfg(target_os = "macos")]
fn parse_macos_scutil_proxy(output: &str) -> Option<SshProxyConfig> {
    let socks_enabled = output.contains("SOCKSEnable : 1");
    if socks_enabled {
        let host = scutil_value(output, "SOCKSProxy")?;
        let port = scutil_value(output, "SOCKSPort")?.parse().ok()?;
        return Some(SshProxyConfig {
            protocol: SshProxyProtocol::Socks5,
            host,
            port,
            username: None,
            password_ref: None,
            use_proxy_dns: Some(true),
        });
    }
    if output.contains("HTTPSEnable : 1") {
        let host = scutil_value(output, "HTTPSProxy")?;
        let port = scutil_value(output, "HTTPSPort")?.parse().ok()?;
        return Some(SshProxyConfig {
            protocol: SshProxyProtocol::Http,
            host,
            port,
            username: None,
            password_ref: None,
            use_proxy_dns: Some(true),
        });
    }
    if output.contains("HTTPEnable : 1") {
        let host = scutil_value(output, "HTTPProxy")?;
        let port = scutil_value(output, "HTTPPort")?.parse().ok()?;
        return Some(SshProxyConfig {
            protocol: SshProxyProtocol::Http,
            host,
            port,
            username: None,
            password_ref: None,
            use_proxy_dns: Some(true),
        });
    }
    None
}

#[cfg(target_os = "macos")]
fn scutil_value(output: &str, key: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix(&format!("{key} : "))
            .map(str::to_string)
    })
}

#[cfg(any(test, all(not(target_os = "windows"), not(target_os = "macos"))))]
fn parse_proxy_url(value: &str) -> Option<SshProxyConfig> {
    let trimmed = value.trim();
    let (protocol, rest) = if let Some(rest) = trimmed.strip_prefix("socks5://") {
        (SshProxyProtocol::Socks5, rest)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        (SshProxyProtocol::Http, rest)
    } else if let Some(rest) = trimmed.strip_prefix("https://") {
        (SshProxyProtocol::Http, rest)
    } else {
        (SshProxyProtocol::Http, trimmed)
    };
    let without_path = rest.split('/').next().unwrap_or(rest);
    let host_port = without_path.rsplit('@').next().unwrap_or(without_path);
    parse_proxy_host_port(host_port, protocol)
}

#[cfg(any(
    test,
    target_os = "windows",
    all(not(target_os = "windows"), not(target_os = "macos"))
))]
fn parse_proxy_host_port(value: &str, protocol: SshProxyProtocol) -> Option<SshProxyConfig> {
    let (host, port) = value.rsplit_once(':')?;
    Some(SshProxyConfig {
        protocol,
        host: host.trim_matches(['[', ']']).to_string(),
        port: port.parse().ok()?,
        username: None,
        password_ref: None,
        use_proxy_dns: Some(true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_proxy_url_supports_socks5() {
        let proxy = parse_proxy_url("socks5://127.0.0.1:1080").unwrap();
        assert_eq!(proxy.protocol, SshProxyProtocol::Socks5);
        assert_eq!(proxy.host, "127.0.0.1");
        assert_eq!(proxy.port, 1080);
    }

    #[test]
    fn parse_proxy_url_supports_http_with_auth() {
        let proxy = parse_proxy_url("http://user:pass@example.com:8080").unwrap();
        assert_eq!(proxy.protocol, SshProxyProtocol::Http);
        assert_eq!(proxy.host, "example.com");
        assert_eq!(proxy.port, 8080);
    }

    #[test]
    fn bypasses_loopback_hosts() {
        assert!(should_bypass_proxy("localhost"));
        assert!(should_bypass_proxy("127.0.0.1"));
        assert!(should_bypass_proxy("::1"));
        assert!(!should_bypass_proxy("example.com"));
    }
}
