//! 白名单配置快照、ZIP 归档与不可信压缩包验证。
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

use super::{BackupError, Result};

pub const CONFIG_FILES: &[&str] = &[
    "global/settings.json",
    "global/layout.json",
    "global/quickbar.json",
    "global/session.json",
    "global/security.json",
    "global/config-key.json",
    "global/backup.json",
    "connections/ssh/profiles.json",
    "connections/ssh/groups.json",
    "connections/ssh/known_hosts",
    "connections/serial/profiles.json",
    "connections/serial/groups.json",
    "connections/credentials.json",
    "ai/ai.json",
];
const MAX_FILES: usize = 4096;
const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_JSON: u64 = 16 * 1024 * 1024;

/// ZIP 清单中的单个文件。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// 备份包的版本化清单。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format_version: u32,
    pub app_version: String,
    pub created_at: String,
    pub protection: String,
    pub files: Vec<Entry>,
}

/// 已验证且归后端所有的解压结果。
pub struct VerifiedArchive {
    pub directory: TempDir,
    pub manifest: Manifest,
}

/// 判断配置包内路径是否属于允许恢复的文件。
pub fn allowed(path: &str) -> bool {
    if CONFIG_FILES.contains(&path) {
        return true;
    }
    let Some(name) = path.strip_prefix("global/backgrounds/") else {
        return false;
    };
    !name.is_empty()
        && !name.contains(['/', '\\', ':'])
        && name.starts_with("bg-")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.'))
        && matches!(
            name.rsplit('.').next(),
            Some("png" | "jpg" | "jpeg" | "webp" | "mp4" | "webm" | "ogv" | "mov" | "m4v")
        )
}

/// 取得配置目录内的白名单文件；拒绝跟随符号链接。
pub fn files(root: &Path) -> Result<Vec<String>> {
    if fs::symlink_metadata(root)?.file_type().is_symlink() {
        return Err(BackupError::invalid(
            "The backup working directory must not be a symbolic link",
        ));
    }
    let mut paths = Vec::new();
    for path in CONFIG_FILES {
        if root.join(path).try_exists()? {
            regular_file(root, path)?;
            paths.push((*path).to_string());
        }
    }
    let background = root.join("global/backgrounds");
    if background.try_exists()? {
        if fs::symlink_metadata(&background)?.file_type().is_symlink() {
            return Err(BackupError::invalid(
                "The background directory must not be a symbolic link",
            ));
        }
        for entry in fs::read_dir(background)? {
            let name = entry?.file_name();
            let path = format!("global/backgrounds/{}", name.to_string_lossy());
            if allowed(&path) {
                regular_file(root, &path)?;
                paths.push(path);
            }
        }
    }
    paths.sort();
    if paths.len() > MAX_FILES {
        return Err(BackupError::invalid(
            "The backup file count exceeds the limit",
        ));
    }
    Ok(paths)
}

/// 确保文件及所有父目录均不是符号链接。
fn regular_file(root: &Path, relative: &str) -> Result<()> {
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(BackupError::invalid(
                "Symbolic links cannot be included in backups",
            ));
        }
    }
    if !path.is_file() {
        return Err(BackupError::invalid(
            "The configuration path is not a regular file",
        ));
    }
    Ok(())
}

/// 在配置事务内复制一致快照，复制完成后释放锁。
pub fn snapshot(root: &Path, check: impl Fn() -> Result<()>) -> Result<TempDir> {
    let _transaction = crate::config_transaction::lock();
    let temp = tempfile::tempdir()?;
    let mut total = 0_u64;
    for path in files(root)? {
        check()?;
        total = total
            .checked_add(fs::metadata(root.join(&path))?.len())
            .ok_or_else(|| BackupError::invalid("The backup exceeds the size limit"))?;
        if total > MAX_BYTES {
            return Err(BackupError::invalid(
                "The backup exceeds the 4 GiB size limit",
            ));
        }
        let dest = temp.path().join(&path);
        fs::create_dir_all(
            dest.parent()
                .ok_or_else(|| BackupError::invalid("Invalid path"))?,
        )?;
        let mut source = File::open(root.join(path))?;
        let mut output = File::create(dest)?;
        copy_hash(&mut source, &mut output, MAX_BYTES, &check)?;
    }
    // 不备份浮动窗口实例，导入后仅恢复主窗口持久化布局。
    let layout = temp.path().join("global/layout.json");
    if layout.exists() {
        let mut value: Value = serde_json::from_slice(&fs::read(&layout)?)?;
        value
            .as_object_mut()
            .ok_or_else(|| BackupError::invalid("Invalid layout configuration"))?
            .insert("floating".into(), serde_json::json!({}));
        fs::write(layout, serde_json::to_vec_pretty(&value)?)?;
    }
    // 连接信息可以迁移，已保存的 WebDAV 密码不进入归档。
    super::clear_saved_password(temp.path())?;
    validate_configuration(temp.path())?;
    Ok(temp)
}

/// 将快照流式写入 ZIP，返回清单。
pub fn pack(root: &Path, output: &mut File, check: impl Fn() -> Result<()>) -> Result<Manifest> {
    let mut entries = Vec::new();
    let mut writer = ZipWriter::new(output);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o600);
    for path in files(root)? {
        check()?;
        let mut input = File::open(root.join(&path))?;
        writer.start_file(&path, options)?;
        let (size, sha256) = copy_hash(&mut input, &mut writer, MAX_BYTES, &check)?;
        entries.push(Entry { path, size, sha256 });
    }
    let manifest = Manifest {
        format_version: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        created_at: time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|_| BackupError::invalid("Failed to format the backup timestamp"))?,
        protection: protection(root)?,
        files: entries,
    };
    writer.start_file("manifest.json", options)?;
    writer.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
    writer.finish()?;
    Ok(manifest)
}

/// 校验 ZIP 并解压至私有暂存目录，不写入当前配置。
pub fn inspect(path: &Path, check: impl Fn() -> Result<()>) -> Result<VerifiedArchive> {
    let mut archive = ZipArchive::new(File::open(path)?)?;
    if archive.len() > MAX_FILES + 1 {
        return Err(BackupError::invalid(
            "The archive entry count exceeds the limit",
        ));
    }
    let mut seen = HashSet::new();
    for i in 0..archive.len() {
        let file = archive.by_index(i)?;
        let name = file.name()?;
        if !seen.insert(name.to_ascii_lowercase())
            || file.is_dir()
            || file.enclosed_name().is_none()
            || (name != "manifest.json" && !allowed(&name))
            || file
                .unix_mode()
                .is_some_and(|m| m & 0o170000 != 0 && m & 0o170000 != 0o100000)
        {
            return Err(BackupError::invalid(
                "The archive contains duplicate, unsafe or unauthorized paths",
            ));
        }
    }
    let manifest: Manifest = {
        let file = archive.by_name("manifest.json")?;
        if file.size() > MAX_JSON {
            return Err(BackupError::invalid("The manifest exceeds the size limit"));
        }
        serde_json::from_reader(file.take(MAX_JSON))?
    };
    time::OffsetDateTime::parse(
        &manifest.created_at,
        &time::format_description::well_known::Rfc3339,
    )
    .map_err(|_| BackupError::invalid("Invalid backup timestamp"))?;
    if manifest.format_version != 1 {
        return Err(BackupError::invalid("Unsupported backup format"));
    }
    let version = semver::Version::parse(&manifest.app_version)
        .map_err(|_| BackupError::invalid("Invalid backup application version"))?;
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|_| BackupError::invalid("Invalid application version"))?;
    if version > current {
        return Err(BackupError::invalid(
            "Upgrade the application before importing this backup",
        ));
    }
    let mut expected = BTreeMap::new();
    let mut total = 0_u64;
    for entry in &manifest.files {
        if !allowed(&entry.path) || expected.insert(entry.path.clone(), entry).is_some() {
            return Err(BackupError::invalid(
                "The manifest contains invalid or duplicate paths",
            ));
        }
        total = total
            .checked_add(entry.size)
            .ok_or_else(|| BackupError::invalid("The extracted data exceeds the size limit"))?;
        if total > MAX_BYTES || (entry.path.ends_with(".json") && entry.size > MAX_JSON) {
            return Err(BackupError::invalid(
                "The extracted data exceeds the size limit",
            ));
        }
    }
    if expected.len() + 1 != seen.len() {
        return Err(BackupError::invalid(
            "The archive entries do not match the manifest",
        ));
    }
    let directory = tempfile::tempdir()?;
    for (name, entry) in expected {
        check()?;
        let mut input = archive.by_name(&name)?;
        if input.size() != entry.size {
            return Err(BackupError::invalid(
                "The file size does not match the manifest",
            ));
        }
        let target = directory.path().join(&name);
        fs::create_dir_all(
            target
                .parent()
                .ok_or_else(|| BackupError::invalid("Invalid path"))?,
        )?;
        let mut output = File::create(target)?;
        let (size, hash) = copy_hash(&mut input, &mut output, entry.size, &check)?;
        if size != entry.size || hash != entry.sha256 {
            return Err(BackupError::invalid(
                "Backup file integrity verification failed",
            ));
        }
        output.sync_all()?;
    }
    validate_configuration(directory.path())?;
    if super::read_settings(directory.path())?
        .password_ref
        .is_some()
    {
        return Err(config_error("global/backup.json", "passwordRef"));
    }
    if protection(directory.path())? != manifest.protection {
        return Err(BackupError::invalid(
            "The security provider does not match the manifest",
        ));
    }
    Ok(VerifiedArchive {
        directory,
        manifest,
    })
}

/// 按块复制并计算哈希，避免大视频占满内存。
fn copy_hash(
    input: &mut impl Read,
    output: &mut impl Write,
    limit: u64,
    check: &impl Fn() -> Result<()>,
) -> Result<(u64, String)> {
    let mut hash = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 65536];
    loop {
        check()?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| BackupError::invalid("The file exceeds the size limit"))?;
        if total > limit {
            return Err(BackupError::invalid("The file exceeds the size limit"));
        }
        hash.update(&buffer[..count]);
        output.write_all(&buffer[..count])?;
    }
    Ok((total, format!("{:x}", hash.finalize())))
}

/// 读取备份自身的安全模式。
fn protection(root: &Path) -> Result<String> {
    let security: Value = serde_json::from_slice(&fs::read(root.join("global/security.json"))?)?;
    Ok(security["provider"]
        .as_str()
        .ok_or_else(|| BackupError::invalid("The security provider is missing"))?
        .to_string())
}

/// 验证结构及密文与安全配置的对应关系，无需主密码解密。
pub fn validate_configuration(root: &Path) -> Result<()> {
    let mut documents = BTreeMap::new();
    for path in CONFIG_FILES.iter().filter(|p| p.ends_with(".json")) {
        let file = root.join(path);
        if file.exists() {
            if fs::metadata(&file)?.len() > MAX_JSON {
                return Err(BackupError::invalid(
                    "The configuration document exceeds the size limit",
                ));
            }
            let value: Value =
                serde_json::from_slice(&fs::read(file)?).map_err(|_| config_error(path, "$"))?;
            if !value.is_object() || (*path != "global/backup.json" && value["version"] != 1) {
                return Err(config_error(path, "$"));
            }
            documents.insert(*path, value);
        }
    }
    let webdav = documents
        .get("global/backup.json")
        .ok_or_else(|| config_error("global/backup.json", "$"))?;
    let _: super::Settings = parse_document(webdav.clone(), "global/backup.json")?;
    let security = documents
        .get("global/security.json")
        .ok_or_else(|| BackupError::invalid("The security configuration is missing"))?;
    let config: crate::security_store::SecretConfig =
        parse_document(security.clone(), "global/security.json")?;
    if config.version != 1 {
        return Err(BackupError::invalid(
            "Unsupported security configuration version",
        ));
    }
    let key_id = config
        .active_key_id
        .as_deref()
        .ok_or_else(|| BackupError::invalid("The active key identifier is missing"))?;
    if let Some(key) = documents.get("global/config-key.json")
        && (!key["keyId"]
            .as_str()
            .is_some_and(|id| id.starts_with("config-"))
            || STANDARD
                .decode(key["keyMaterial"].as_str().unwrap_or(""))
                .map_or(true, |v| v.len() != 32))
    {
        return Err(BackupError::invalid(
            "Invalid configuration-directory key format",
        ));
    }
    match config.provider.as_str() {
        "embedded" => {
            let key = documents
                .get("global/config-key.json")
                .ok_or_else(|| BackupError::invalid("The configuration key is missing"))?;
            if key["version"] != 1
                || key["keyId"] != key_id
                || STANDARD
                    .decode(key["keyMaterial"].as_str().unwrap_or(""))
                    .map_or(true, |v| v.len() != 32)
            {
                return Err(BackupError::new(
                    "backup_security_key_mismatch",
                    "The configuration key does not match the security configuration",
                )
                .with_location("global/config-key.json", "keyId"));
            }
        }
        "user_password" => {
            if config
                .kdf_salt
                .as_deref()
                .and_then(|s| STANDARD.decode(s).ok())
                .is_none_or(|s| s.len() != 16)
                || config
                    .verify_hash
                    .as_deref()
                    .and_then(|s| STANDARD.decode(s).ok())
                    .is_none_or(|s| s.len() != 32)
            {
                return Err(BackupError::invalid(
                    "The master-password security configuration is incomplete",
                ));
            }
        }
        _ => return Err(BackupError::invalid("Unsupported security provider")),
    }
    if let Some(v) = documents.get("connections/ssh/profiles.json") {
        let _: crate::ssh_profile_store::SshProfileStore =
            parse_document(v.clone(), "connections/ssh/profiles.json")?;
    }
    if let Some(v) = documents.get("connections/serial/profiles.json") {
        let _: crate::serial_profile_store::SerialProfileStore =
            parse_document(v.clone(), "connections/serial/profiles.json")?;
    }
    if let Some(v) = documents.get("connections/credentials.json") {
        let _: crate::credential_store::CredentialStore =
            parse_document(v.clone(), "connections/credentials.json")?;
    }
    for name in [
        "connections/ssh/groups.json",
        "connections/serial/groups.json",
    ] {
        if let Some(v) = documents.get(name)
            && !v["groups"]
                .as_array()
                .is_some_and(|g| g.iter().all(Value::is_string))
        {
            return Err(config_error(name, "groups"));
        }
    }
    if let Some(v) = documents.get("ai/ai.json") {
        let _: crate::ai_settings::AiSettings = parse_document(v.clone(), "ai/ai.json")?;
    }
    if let Some(v) = documents.get("global/session.json") {
        let _: crate::session_settings::SessionSettings =
            parse_document(v.clone(), "global/session.json")?;
    }
    for (name, value) in &documents {
        validate_document_secrets(name, value, &config.provider, key_id)?;
    }
    if let Some(v) = documents.get("global/layout.json")
        && !v["floating"].as_object().is_none_or(|f| f.is_empty())
    {
        return Err(BackupError::invalid(
            "The layout contains floating-window runtime state",
        ));
    }
    Ok(())
}

/// 配置结构错误只携带固定文件与字段路径，丢弃可能包含数据的解析器文本。
fn config_error(document: &str, field: &str) -> BackupError {
    BackupError::new("backup_config_invalid", "Invalid configuration document")
        .with_location(document, field)
}

/// 将 JSON 文档转换为业务结构，并保留可定位的安全诊断。
fn parse_document<T: serde::de::DeserializeOwned>(value: Value, document: &str) -> Result<T> {
    serde_json::from_value(value).map_err(|_| config_error(document, "$"))
}

/// 只校验业务模型实际拥有的凭据字段，避免误判普通文本中的密文前缀。
fn validate_document_secrets(
    document: &str,
    value: &Value,
    provider: &str,
    key_id: &str,
) -> Result<()> {
    let (collection, fields): (&str, &[&str]) = match document {
        "connections/ssh/profiles.json" => (
            "profiles",
            &[
                "passwordRef",
                "privateKeyPassphraseRef",
                "keyPassphraseRef",
                "publicKeyPassphraseRef",
            ],
        ),
        "connections/credentials.json" => ("credentials", &["passwordRef"]),
        "ai/ai.json" => ("providers", &["apiKeyRef"]),
        _ => return Ok(()),
    };
    if let Some(items) = value[collection].as_array() {
        for (index, item) in items.iter().enumerate() {
            for field in fields {
                validate_secret(
                    item.get(*field),
                    provider,
                    key_id,
                    document,
                    &format!("{collection}[{index}].{field}"),
                )?;
            }
            if document == "connections/ssh/profiles.json" {
                validate_secret(
                    item.get("proxyConfig")
                        .and_then(|proxy| proxy.get("passwordRef")),
                    provider,
                    key_id,
                    document,
                    &format!("profiles[{index}].proxyConfig.passwordRef"),
                )?;
            }
        }
    }
    Ok(())
}

/// 校验单个密文封装并区分密钥、Provider、nonce 和密文格式错误。
fn validate_secret(
    value: Option<&Value>,
    provider: &str,
    key_id: &str,
    document: &str,
    field: &str,
) -> Result<()> {
    let error = |code, message| BackupError::new(code, message).with_location(document, field);
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(());
    };
    let serialized = value.as_str().ok_or_else(|| {
        error(
            "backup_secret_format_invalid",
            "The secret field must contain an encrypted string",
        )
    })?;
    if serialized.is_empty() {
        return Ok(());
    }
    let encoded = serialized.strip_prefix("enc:v1:").ok_or_else(|| {
        error(
            "backup_secret_format_invalid",
            "The secret field has an unsupported encrypted format",
        )
    })?;
    let bytes = STANDARD.decode(encoded).map_err(|_| {
        error(
            "backup_secret_format_invalid",
            "The encrypted secret is not valid Base64",
        )
    })?;
    let payload: crate::security::types::EncryptedPayload = serde_json::from_slice(&bytes)
        .map_err(|_| {
            error(
                "backup_secret_format_invalid",
                "The encrypted-secret envelope is invalid",
            )
        })?;
    let expected = if provider == "embedded" {
        crate::security::EncryptionProviderKind::Embedded
    } else {
        crate::security::EncryptionProviderKind::UserPassword
    };
    if payload.provider != expected {
        return Err(error(
            "backup_secret_provider_mismatch",
            "The secret encryption provider does not match the security configuration",
        ));
    }
    if payload.key_id != key_id {
        return Err(error(
            "backup_secret_key_mismatch",
            "The secret key identifier does not match the active security key",
        ));
    }
    if STANDARD
        .decode(payload.nonce)
        .map_or(true, |n| n.len() != 12)
    {
        return Err(error(
            "backup_secret_nonce_invalid",
            "The encrypted-secret nonce is invalid",
        ));
    }
    if STANDARD
        .decode(payload.ciphertext)
        .map_or(true, |c| c.len() < 16)
    {
        return Err(error(
            "backup_secret_ciphertext_invalid",
            "The encrypted-secret ciphertext is invalid",
        ));
    }
    Ok(())
}

/// 将文件集合复制到另一个受控目录。
pub fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    copy_tree_checked(source, target, || Ok(()))
}

/// 可取消地复制大背景资源，提交事务标记前仍可停止。
pub fn copy_tree_checked(
    source: &Path,
    target: &Path,
    check: impl Fn() -> Result<()>,
) -> Result<()> {
    for name in files(source)? {
        check()?;
        let path: PathBuf = target.join(&name);
        fs::create_dir_all(
            path.parent()
                .ok_or_else(|| BackupError::invalid("Invalid path"))?,
        )?;
        let mut input = File::open(source.join(name))?;
        let mut output = File::create(path)?;
        copy_hash(&mut input, &mut output, MAX_BYTES, &check)?;
        output.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::security::provider::EncryptionProvider;
    use crate::security::providers::embedded::EmbeddedProvider;
    use crate::security::{
        CryptoService, EncryptedPayload, EncryptionAlgorithm, EncryptionProviderKind,
    };

    /// 创建含真实密文的弱保护测试配置。
    pub fn fixture() -> TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("global/backgrounds")).unwrap();
        super::super::write_json(
            &root.path().join("global/backup.json"),
            &super::super::Settings::default(),
        )
        .unwrap();
        fs::create_dir_all(root.path().join("connections")).unwrap();
        super::super::write_json(
            &root.path().join("global/security.json"),
            &CryptoService::build_embedded_config("config-test"),
        )
        .unwrap();
        super::super::write_json(&root.path().join("global/config-key.json"), &serde_json::json!({"version":1,"keyId":"config-test","keyMaterial":STANDARD.encode([7_u8;32])})).unwrap();
        let provider = EmbeddedProvider::new("config-test".into(), [7; 32]);
        let encrypted = provider.encrypt(b"test-secret").unwrap();
        let payload = EncryptedPayload {
            provider: EncryptionProviderKind::Embedded,
            algorithm: EncryptionAlgorithm::Aes256Gcm,
            key_id: "config-test".into(),
            nonce: STANDARD.encode(encrypted.nonce),
            ciphertext: STANDARD.encode(encrypted.ciphertext),
        };
        let secret = format!(
            "enc:v1:{}",
            STANDARD.encode(serde_json::to_vec(&payload).unwrap())
        );
        super::super::write_json(&root.path().join("connections/credentials.json"), &serde_json::json!({"version":1,"updatedAt":1,"credentials":[{"id":"test","kind":"ssh","name":"测试","username":"root","passwordRef":secret,"createdAt":1,"updatedAt":1}]})).unwrap();
        fs::write(
            root.path().join("global/settings.json"),
            "{\"version\":1,\"locale\":\"zh-CN\"}",
        )
        .unwrap();
        fs::write(
            root.path().join("global/backgrounds/bg-test.png"),
            b"background",
        )
        .unwrap();
        root
    }

    /// 从文件列表写出测试归档，可构造错误清单或危险路径。
    fn custom_zip(path: &Path, contents: Vec<(String, Vec<u8>)>) {
        let mut zip = ZipWriter::new(File::create(path).unwrap());
        for (name, bytes) in contents {
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    /// 弱保护归档在新目录恢复后可用，且不包含排除项。
    #[test]
    fn roundtrip_preserves_ciphertext_and_excludes_runtime_data() {
        let root = fixture();
        fs::create_dir_all(root.path().join("terminal")).unwrap();
        fs::write(
            root.path().join("terminal/command-history.json"),
            "secret history",
        )
        .unwrap();
        super::super::write_json(&root.path().join("global/backup.json"), &serde_json::json!({
            "url":"http://nas/dav/backups/", "username":"backup-user", "passwordRef":"saved-webdav-password"
        })).unwrap();
        fs::write(root.path().join("global/lock-screen.json"), "lock").unwrap();
        fs::write(
            root.path().join("global/layout.json"),
            "{\"version\":1,\"floating\":{\"files\":{\"origin\":\"right:0\"}}}",
        )
        .unwrap();
        let snapshot = snapshot(root.path(), || Ok(())).unwrap();
        let mut output = tempfile::NamedTempFile::new().unwrap();
        let manifest = pack(snapshot.path(), output.as_file_mut(), || Ok(())).unwrap();
        let verified = inspect(output.path(), || Ok(())).unwrap();
        assert!(
            manifest
                .files
                .iter()
                .all(|f| !f.path.contains("history") && !f.path.contains("lock-screen"))
        );
        assert!(
            manifest
                .files
                .iter()
                .any(|entry| entry.path == "global/backup.json")
        );
        let webdav: Value = serde_json::from_slice(
            &fs::read(verified.directory.path().join("global/backup.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(webdav["url"], "http://nas/dav/backups/");
        assert_eq!(webdav["username"], "backup-user");
        assert!(webdav.get("directory").is_none());
        assert!(webdav.get("passwordRef").is_none());
        assert!(!webdav.to_string().contains("saved-webdav-password"));
        assert_eq!(
            fs::read(root.path().join("connections/credentials.json")).unwrap(),
            fs::read(
                verified
                    .directory
                    .path()
                    .join("connections/credentials.json")
            )
            .unwrap()
        );
        let key: Value = serde_json::from_slice(
            &fs::read(verified.directory.path().join("global/config-key.json")).unwrap(),
        )
        .unwrap();
        let material: [u8; 32] = STANDARD
            .decode(key["keyMaterial"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let provider = EmbeddedProvider::new(key["keyId"].as_str().unwrap().into(), material);
        let credentials: Value = serde_json::from_slice(
            &fs::read(
                verified
                    .directory
                    .path()
                    .join("connections/credentials.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let token = credentials["credentials"][0]["passwordRef"]
            .as_str()
            .unwrap();
        let payload: EncryptedPayload =
            serde_json::from_slice(&STANDARD.decode(&token[7..]).unwrap()).unwrap();
        let plain = provider
            .decrypt(&crate::security::ProviderCiphertext {
                algorithm: payload.algorithm,
                nonce: STANDARD.decode(payload.nonce).unwrap(),
                ciphertext: STANDARD.decode(payload.ciphertext).unwrap(),
            })
            .unwrap();
        assert_eq!(plain, b"test-secret");
        let layout: Value = serde_json::from_slice(
            &fs::read(verified.directory.path().join("global/layout.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(layout["floating"], serde_json::json!({}));
    }

    /// 主密码锁定时无需解密即可打包，恢复后仍由原密码解锁。
    #[test]
    fn locked_master_password_backup_requires_original_password() {
        let root = fixture();
        let (config, session) = CryptoService::build_user_password_config("old-password").unwrap();
        let crypto = CryptoService::new(Some(&config), Some(&session)).unwrap();
        let secret = crypto.encrypt_string("strong-secret").unwrap();
        super::super::write_json(&root.path().join("global/security.json"), &config).unwrap();
        super::super::write_json(&root.path().join("connections/credentials.json"), &serde_json::json!({"version":1,"updatedAt":1,"credentials":[{"id":"test","kind":"ssh","name":"test","username":"root","passwordRef":secret,"createdAt":1,"updatedAt":1}]})).unwrap();
        drop(crypto);
        drop(session);
        let snapshot = snapshot(root.path(), || Ok(())).unwrap();
        let mut output = tempfile::NamedTempFile::new().unwrap();
        pack(snapshot.path(), output.as_file_mut(), || Ok(())).unwrap();
        let verified = inspect(output.path(), || Ok(())).unwrap();
        assert_eq!(verified.manifest.protection, "user_password");
        assert!(CryptoService::unlock_user_password(&config, "new-password").is_err());
        let session = CryptoService::unlock_user_password(&config, "old-password").unwrap();
        assert_eq!(
            CryptoService::new(Some(&config), Some(&session))
                .unwrap()
                .decrypt_string(&secret)
                .unwrap(),
            "strong-secret"
        );
    }

    /// 路径穿越、Windows 别名及非白名单文件均被拒绝。
    #[test]
    fn unsafe_and_case_colliding_entries_are_rejected() {
        for names in [
            vec!["../escape"],
            vec!["C:/escape"],
            vec!["global/lock-screen.json"],
            vec![
                "global/backgrounds/bg-test.png",
                "global/backgrounds/bg-TEST.png",
            ],
        ] {
            let zip = tempfile::NamedTempFile::new().unwrap();
            custom_zip(
                zip.path(),
                names.iter().map(|s| (s.to_string(), Vec::new())).collect(),
            );
            assert!(inspect(zip.path(), || Ok(())).is_err());
        }
    }

    /// 清单不允许篡改内容、更高版本和超限解压大小。
    #[test]
    fn tampering_newer_version_and_bombs_are_rejected() {
        let root = fixture();
        let snapshot = snapshot(root.path(), || Ok(())).unwrap();
        let mut original = tempfile::NamedTempFile::new().unwrap();
        let manifest = pack(snapshot.path(), original.as_file_mut(), || Ok(())).unwrap();
        for mode in 0..3 {
            let mut altered = manifest.clone();
            if mode == 1 {
                altered.app_version = "999.0.0".into();
            }
            if mode == 2 {
                altered.files[0].size = MAX_BYTES + 1;
            }
            let mut contents: Vec<_> = manifest
                .files
                .iter()
                .map(|e| {
                    (
                        e.path.clone(),
                        fs::read(snapshot.path().join(&e.path)).unwrap(),
                    )
                })
                .collect();
            if mode == 0 {
                contents[0].1.push(b'!');
            }
            contents.push((
                "manifest.json".into(),
                serde_json::to_vec(&altered).unwrap(),
            ));
            let zip = tempfile::NamedTempFile::new().unwrap();
            custom_zip(zip.path(), contents);
            assert!(inspect(zip.path(), || Ok(())).is_err());
        }
    }

    /// 不匹配的密钥与明文凭据均不得进入恢复。
    #[test]
    fn mismatched_key_and_plaintext_secret_are_rejected() {
        let root = fixture();
        let path = root.path().join("global/config-key.json");
        let mut key: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        key["keyId"] = Value::String("config-other".into());
        super::super::write_json(&path, &key).unwrap();
        assert!(validate_configuration(root.path()).is_err());
        key["keyId"] = Value::String("config-test".into());
        super::super::write_json(&path, &key).unwrap();
        let path = root.path().join("connections/credentials.json");
        let mut credentials: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        credentials["credentials"][0]["passwordRef"] = Value::String("plaintext".into());
        super::super::write_json(&path, &credentials).unwrap();
        assert!(validate_configuration(root.path()).is_err());
    }

    /// 各类凭据拒绝可独立定位，同时序列化诊断不泄露任何密钥或密文。
    #[test]
    fn secret_failures_keep_specific_codes_and_safe_locations() {
        for (property, replacement, code) in [
            (
                "keyId",
                "config-private-key-id",
                "backup_secret_key_mismatch",
            ),
            (
                "provider",
                "user_password",
                "backup_secret_provider_mismatch",
            ),
            ("nonce", "invalid-nonce", "backup_secret_nonce_invalid"),
            (
                "ciphertext",
                "invalid-ciphertext",
                "backup_secret_ciphertext_invalid",
            ),
        ] {
            let root = fixture();
            let path = root.path().join("connections/credentials.json");
            let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            let original = value["credentials"][0]["passwordRef"].as_str().unwrap();
            let mut payload: Value =
                serde_json::from_slice(&STANDARD.decode(&original[7..]).unwrap()).unwrap();
            payload[property] = Value::String(replacement.into());
            let secret = format!(
                "enc:v1:{}",
                STANDARD.encode(serde_json::to_vec(&payload).unwrap())
            );
            value["credentials"][0]["passwordRef"] = Value::String(secret.clone());
            super::super::write_json(&path, &value).unwrap();
            let error = validate_configuration(root.path()).unwrap_err();
            assert_eq!(error.code, code);
            let encoded = serde_json::to_value(error).unwrap();
            assert_eq!(
                encoded["messageVars"]["file"],
                "connections/credentials.json"
            );
            assert_eq!(
                encoded["messageVars"]["field"],
                "credentials[0].passwordRef"
            );
            assert!(!encoded["messageKey"].as_str().unwrap().contains('_'));
            let serialized = encoded.to_string();
            assert!(!serialized.contains(&secret));
            assert!(!serialized.contains(replacement));
        }
    }

    /// 普通配置文本即使包含密文前缀，也不是凭据校验对象。
    #[test]
    fn ordinary_text_is_not_mistaken_for_a_secret() {
        let root = fixture();
        fs::create_dir_all(root.path().join("ai")).unwrap();
        super::super::write_json(&root.path().join("ai/ai.json"), &serde_json::json!({
            "version": 1, "providers": [{"id":"p", "name":"enc:v1:ordinary-text", "apiKeyRef":null}]
        })).unwrap();
        validate_configuration(root.path()).unwrap();
    }

    /// 格式无效的真实代理密码仍然阻止备份，并保留具体嵌套字段位置。
    #[test]
    fn proxy_secret_reports_its_nested_location() {
        let root = fixture();
        fs::create_dir_all(root.path().join("connections/ssh")).unwrap();
        super::super::write_json(&root.path().join("connections/ssh/profiles.json"), &serde_json::json!({
            "version":1, "updated_at":1, "profiles":[{"id":"h","name":"test","host":"127.0.0.1","port":22,"username":"user","authType":"password",
            "proxyConfig":{"protocol":"http","host":"localhost","port":8080,"passwordRef":"plaintext-secret"}}]
        })).unwrap();
        let error = validate_configuration(root.path()).unwrap_err();
        assert_eq!(error.code, "backup_secret_format_invalid");
        assert_eq!(
            error.message_vars.unwrap()["field"],
            "profiles[0].proxyConfig.passwordRef"
        );
    }

    /// 旧版私钥口令字段仍按实际业务别名校验，不能绕过凭据检查。
    #[test]
    fn legacy_passphrase_fields_are_checked() {
        for field in ["keyPassphraseRef", "publicKeyPassphraseRef"] {
            let root = fixture();
            fs::create_dir_all(root.path().join("connections/ssh")).unwrap();
            let mut profile = serde_json::json!({"id":"h","name":"test","host":"127.0.0.1","port":22,"username":"user","authType":"privateKey"});
            profile[field] = Value::String("enc:v1:invalid".into());
            super::super::write_json(
                &root.path().join("connections/ssh/profiles.json"),
                &serde_json::json!({"version":1,"updated_at":1,"profiles":[profile]}),
            )
            .unwrap();
            let error = validate_configuration(root.path()).unwrap_err();
            assert_eq!(error.code, "backup_secret_format_invalid");
            assert_eq!(
                error.message_vars.unwrap()["field"],
                format!("profiles[0].{field}")
            );
        }
    }

    /// backup.json 是当前备份格式的必需文档，缺少时直接拒绝。
    #[test]
    fn missing_webdav_configuration_is_rejected() {
        let root = fixture();
        let snapshot = snapshot(root.path(), || Ok(())).unwrap();
        fs::remove_file(snapshot.path().join("global/backup.json")).unwrap();
        let mut output = tempfile::NamedTempFile::new().unwrap();
        pack(snapshot.path(), output.as_file_mut(), || Ok(())).unwrap();
        let error = match inspect(output.path(), || Ok(())) {
            Ok(_) => panic!("An archive without backup.json must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error.code, "backup_config_invalid");
        assert_eq!(error.message_vars.unwrap()["file"], "global/backup.json");
    }

    /// 用户取消时停止复制，不产生完整备份。
    #[test]
    fn cancellation_stops_snapshot() {
        let root = fixture();
        assert!(
            snapshot(root.path(), || Err(BackupError::new(
                "backup_cancelled",
                "cancelled"
            )))
            .is_err()
        );
    }
}
