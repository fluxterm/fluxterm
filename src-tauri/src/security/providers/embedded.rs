//! 应用内置弱保护 Provider。

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use engine::EngineError;
use rand::random;
use sha2::{Digest, Sha256};

use crate::security::provider::EncryptionProvider;
use crate::security::types::{EncryptionAlgorithm, EncryptionProviderKind, ProviderCiphertext};

const EMBEDDED_KEY_ID: &str = "embedded-v1";
const EMBEDDED_KEY_MATERIAL: &[u8] = b"fluxterm::embedded-weak-protection::v1";

/// 基于应用内置密钥的 AES-256-GCM Provider。
pub struct EmbeddedProvider {
    encryption_key: [u8; 32],
}

impl EmbeddedProvider {
    /// 使用内置弱保护密钥创建 Provider。
    pub fn new() -> Self {
        let digest = Sha256::digest(EMBEDDED_KEY_MATERIAL);
        let mut encryption_key = [0_u8; 32];
        encryption_key.copy_from_slice(&digest[..32]);
        Self { encryption_key }
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

impl Default for EmbeddedProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl EncryptionProvider for EmbeddedProvider {
    fn kind(&self) -> EncryptionProviderKind {
        EncryptionProviderKind::Embedded
    }

    fn key_id(&self) -> &str {
        EMBEDDED_KEY_ID
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
