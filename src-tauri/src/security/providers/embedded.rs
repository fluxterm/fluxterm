//! 配置目录级弱保护 Provider。

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use fluxterm_engine::EngineError;
use rand::random;

use crate::security::provider::EncryptionProvider;
use crate::security::types::{EncryptionAlgorithm, EncryptionProviderKind, ProviderCiphertext};

/// 基于配置目录密钥的 AES-256-GCM 弱保护 Provider。
pub struct EmbeddedProvider {
    key_id: String,
    encryption_key: [u8; 32],
}

impl EmbeddedProvider {
    /// 使用配置目录级弱保护密钥创建 Provider。
    pub fn new(key_id: String, encryption_key: [u8; 32]) -> Self {
        Self {
            key_id,
            encryption_key,
        }
    }

    fn cipher(&self) -> Result<Aes256Gcm, EngineError> {
        Aes256Gcm::new_from_slice(&self.encryption_key).map_err(|err| {
            EngineError::with_detail(
                crate::security::CRYPTO_INIT_FAILED_CODE,
                "Failed to initialize the cipher",
                err.to_string(),
            )
        })
    }
}

impl EncryptionProvider for EmbeddedProvider {
    fn kind(&self) -> EncryptionProviderKind {
        EncryptionProviderKind::Embedded
    }

    fn key_id(&self) -> &str {
        &self.key_id
    }

    fn is_locked(&self) -> bool {
        false
    }

    fn encrypt(&self, plaintext: &[u8]) -> Result<ProviderCiphertext, EngineError> {
        let cipher = self.cipher()?;
        let nonce: [u8; 12] = random();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext)
            .map_err(|_| {
                EngineError::new(
                    crate::security::SECRET_ENCRYPT_FAILED_CODE,
                    "Failed to encrypt the credential",
                )
            })?;
        Ok(ProviderCiphertext {
            algorithm: EncryptionAlgorithm::Aes256Gcm,
            nonce: nonce.to_vec(),
            ciphertext,
        })
    }

    fn decrypt(&self, payload: &ProviderCiphertext) -> Result<Vec<u8>, EngineError> {
        let cipher = self.cipher()?;
        cipher
            .decrypt(
                Nonce::from_slice(&payload.nonce),
                payload.ciphertext.as_ref(),
            )
            .map_err(|_| {
                EngineError::new(
                    crate::security::SECRET_DECRYPT_FAILED_CODE,
                    "Failed to decrypt the credential",
                )
            })
    }
}
