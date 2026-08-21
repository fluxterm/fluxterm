//! 加密 Provider 抽象。

use fluxterm_engine::EngineError;

use crate::security::types::{EncryptionProviderKind, ProviderCiphertext, SecurityStatus};

/// 统一的加密 Provider 接口。
pub trait EncryptionProvider: Send + Sync {
    /// 返回 Provider 类型标识。
    fn kind(&self) -> EncryptionProviderKind;

    /// 返回当前活跃 key 的标识。
    fn key_id(&self) -> &str;

    /// 返回 Provider 是否处于锁定状态。
    fn is_locked(&self) -> bool;

    /// 对原始字节执行加密。
    fn encrypt(&self, plaintext: &[u8]) -> Result<ProviderCiphertext, EngineError>;

    /// 对原始字节执行解密。
    fn decrypt(&self, payload: &ProviderCiphertext) -> Result<Vec<u8>, EngineError>;

    /// 返回 Provider 当前状态，供未来 UI 或诊断使用。
    fn status(&self) -> SecurityStatus {
        SecurityStatus {
            provider: self.kind(),
            locked: self.is_locked(),
            encryption_enabled: true,
        }
    }
}
