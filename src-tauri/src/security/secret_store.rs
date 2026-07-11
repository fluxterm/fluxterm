//! 面向业务字段的 secret 读写封装。

use engine::EngineError;

use crate::security::CryptoService;

/// 针对可空字符串 secret 的统一处理器。
pub struct SecretStore<'a> {
    crypto: &'a CryptoService,
}

impl<'a> SecretStore<'a> {
    /// 基于统一 Crypto 服务创建 SecretStore。
    pub fn new(crypto: &'a CryptoService) -> Self {
        Self { crypto }
    }

    /// 将可空明文字段加密为结构化密文字段。
    pub fn protect_optional_string(
        &self,
        value: Option<String>,
    ) -> Result<Option<String>, EngineError> {
        match value {
            Some(raw) if raw.trim().is_empty() => Ok(None),
            Some(raw) => self.crypto.encrypt_string(&raw).map(Some),
            None => Ok(None),
        }
    }

    /// 将可空密文字段解密为明文字段。
    pub fn reveal_optional_string(
        &self,
        value: Option<String>,
    ) -> Result<Option<String>, EngineError> {
        match value {
            Some(raw) if raw.trim().is_empty() => Ok(None),
            Some(raw) if !raw.starts_with("enc:v1:") => Err(EngineError::new(
                "secret_format_unsupported",
                "Invalid credential format; only enc:v1 ciphertext is supported",
            )),
            Some(raw) => self.crypto.decrypt_string(&raw).map(Some),
            None => Ok(None),
        }
    }
}
