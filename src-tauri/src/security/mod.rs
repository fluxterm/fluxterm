//! 公共安全模块入口。
//!
//! 本模块负责统一封装本地敏感数据的加解密能力，避免业务代码直接依赖具体算法。
//! 当前默认采用弱保护模式；用户显式设置安全密码后，再切换到强保护模式。
//! 外部业务只通过统一入口读取和写入敏感字段。

pub(crate) const CRYPTO_INIT_FAILED_CODE: &str = "crypto_init_failed";
pub(crate) const SECRET_DECRYPT_FAILED_CODE: &str = "secret_decrypt_failed";
pub(crate) const SECRET_ENCRYPT_FAILED_CODE: &str = "secret_encrypt_failed";
pub(crate) const SECRET_FORMAT_UNSUPPORTED_CODE: &str = "secret_format_unsupported";
pub(crate) const SECURITY_LOCKED_CODE: &str = "security_locked";

pub mod crypto;
pub mod provider;
pub mod providers;
pub mod secret_store;
pub mod types;

pub use crypto::CryptoService;
pub use secret_store::SecretStore;
pub use types::{
    EncryptedPayload, EncryptionAlgorithm, EncryptionProviderKind, ProviderCiphertext,
    SecurityStatus,
};
