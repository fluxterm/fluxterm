//! 引擎对外接口聚合模块。
pub mod auth;
pub mod engine;
pub mod error;
pub mod host_key;
pub mod monitor;
pub mod proxy;
pub mod proxy_backend;
pub mod proxy_error_codes;
pub mod serial;
pub mod session;
pub mod sftp;
pub mod ssh_transport;
pub mod types;
pub mod util;

pub use crate::engine::Engine;
pub use crate::error::EngineError;
pub use crate::host_key::{HostKeyProbe, probe_host_key};
pub use crate::serial::SerialManager;
pub use crate::session::ExpectedHostKey;
pub use crate::ssh_transport::{JumpHostProfile, JumpHostSpec};
pub use crate::types::*;
