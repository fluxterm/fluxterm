//! 用户主密码 Provider。

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use engine::EngineError;
use rand::random;

use crate::security::provider::EncryptionProvider;
use crate::security::types::{EncryptionAlgorithm, EncryptionProviderKind, ProviderCiphertext};

/// 基于用户主密码派生密钥的 AES-256-GCM Provider。
pub struct UserPasswordProvider {
    key_id: String,
    encryption_key: [u8; 32],
}

impl UserPasswordProvider {
    /// 使用已派生的会话密钥创建 Provider。
    pub fn new(key_id: String, encryption_key: [u8; 32]) -> Self {
        Self {
            key_id,
            encryption_key,
        }
    }

    fn cipher(&self) -> Result<Aes256Gcm, EngineError> {
        Aes256Gcm::new_from_slice(&self.encryption_key).map_err(|err| {
            EngineError::with_detail(
                "crypto_init_failed",
                "Failed to initialize the cipher",
                err.to_string(),
            )
        })
    }
}

impl EncryptionProvider for UserPasswordProvider {
    fn kind(&self) -> EncryptionProviderKind {
        EncryptionProviderKind::UserPassword
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
                EngineError::new("secret_encrypt_failed", "Failed to encrypt the credential")
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
                EngineError::new("secret_decrypt_failed", "Failed to decrypt the credential")
            })
    }
}
