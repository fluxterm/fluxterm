//! 代理域错误码常量。

pub const PROXY_BIND_FAILED_CODE: &str = "proxy_bind_failed";
pub const PROXY_BIND_CONFLICT_CODE: &str = "proxy_bind_conflict";
pub const PROXY_NOT_FOUND_CODE: &str = "proxy_not_found";
pub const PROXY_ACCEPT_FAILED_CODE: &str = "proxy_accept_failed";
pub const PROXY_CONNECTION_LIMIT_EXCEEDED_CODE: &str = "proxy_connection_limit_exceeded";
pub const PROXY_HANDSHAKE_TIMEOUT_CODE: &str = "proxy_handshake_timeout";
pub const PROXY_IO_READ_TIMEOUT_CODE: &str = "proxy_io_read_timeout";
pub const PROXY_IO_WRITE_TIMEOUT_CODE: &str = "proxy_io_write_timeout";
pub const PROXY_SHUTDOWN_TIMEOUT_CODE: &str = "proxy_shutdown_timeout";
pub const PROXY_TRANSFER_FAILED_CODE: &str = "proxy_transfer_failed";
pub const PROXY_AUTH_REQUIRED_CODE: &str = "proxy_auth_required";
pub const PROXY_AUTH_FAILED_CODE: &str = "proxy_auth_failed";
pub const PROXY_UPSTREAM_CONNECT_FAILED_CODE: &str = "proxy_upstream_connect_failed";
pub const PROXY_HTTP_PARSE_FAILED_CODE: &str = "proxy_http_parse_failed";
pub const PROXY_HTTP_HANDSHAKE_FAILED_CODE: &str = "proxy_http_handshake_failed";
pub const PROXY_HTTP_FORWARD_FAILED_CODE: &str = "proxy_http_forward_failed";
pub const PROXY_SOCKS5_HANDSHAKE_FAILED_CODE: &str = "proxy_socks5_handshake_failed";
pub const PROXY_SOCKS5_REQUEST_FAILED_CODE: &str = "proxy_socks5_request_failed";
