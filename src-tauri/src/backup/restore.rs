//! 启动前恢复事务及崩溃回滚。
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{BackupError, Result, archive};

/// 恢复事务只记录状态，不接受外部目标路径。
#[derive(Serialize, Deserialize)]
struct Journal {
    phase: String,
}

/// 暂存已验证内容，待下一次启动应用。
pub fn stage(
    root: &Path,
    verified: &archive::VerifiedArchive,
    check: impl Fn() -> Result<()>,
) -> Result<()> {
    let _transaction = crate::config_transaction::lock();
    let work = root.join(".backup-restore");
    fs::create_dir_all(&work)?;
    validate_work(root, &work)?;
    if work.join("pending.json").exists() {
        return Err(BackupError::invalid(
            "A restore is already staged; restart the application first",
        ));
    }
    let staging = tempfile::Builder::new()
        .prefix("stage-")
        .tempdir_in(&work)?;
    archive::copy_tree_checked(verified.directory.path(), staging.path(), &check)?;
    archive::validate_configuration(staging.path())?;
    check()?;
    // 先完成文件再发布事务标记，源 ZIP 后续变化不会影响恢复。
    let destination = work.join("incoming");
    remove_owned_dir(&destination, &work)?;
    fs::rename(staging.path(), destination)?;
    super::write_json(
        &work.join("pending.json"),
        &Journal {
            phase: "prepared".into(),
        },
    )?;
    Ok(())
}

/// 启动时在安全服务和前端配置加载之前恢复或回滚。
pub fn apply_pending(app: &AppHandle) -> std::result::Result<(), fluxterm_engine::EngineError> {
    let root = crate::config_paths::resolve_config_root_dir(app)?;
    apply_root(&root).map_err(|_| {
        fluxterm_engine::EngineError::new(
            "backup_restore_failed",
            "Configuration restore or rollback could not complete",
        )
    })
}

/// 执行可恢复事务；应用中断后优先回滚，避免继续使用半恢复配置。
fn apply_root(root: &Path) -> Result<()> {
    let _transaction = crate::config_transaction::lock();
    let work = root.join(".backup-restore");
    let pending = work.join("pending.json");
    if work.exists() {
        validate_work(root, &work)?;
    }
    if !pending.exists() {
        return Ok(());
    }
    let journal: Journal = serde_json::from_slice(&fs::read(&pending)?)?;
    let incoming = work.join("incoming");
    let rollback = work.join("rollback");
    if journal.phase == "committed" {
        fs::remove_file(pending)?;
        remove_owned_dir(&incoming, &work)?;
        return Ok(());
    }
    if journal.phase == "applying" {
        replace(root, &rollback)?;
        super::write_json(&work.join("notice.json"), &"rolled_back")?;
        fs::remove_file(pending)?;
        remove_owned_dir(&incoming, &work)?;
        return Ok(());
    }
    if journal.phase != "prepared" {
        return Err(BackupError::invalid("Unknown restore transaction phase"));
    }
    archive::validate_configuration(&incoming)?;
    // 上一次回滚副本只在新副本完整发布后替换。
    let copy = tempfile::Builder::new()
        .prefix("rollback-")
        .tempdir_in(&work)?;
    archive::copy_tree(root, copy.path())?;
    remove_owned_dir(&rollback, &work)?;
    fs::rename(copy.path(), &rollback)?;
    super::write_json(
        &pending,
        &Journal {
            phase: "applying".into(),
        },
    )?;
    let result: Result<()> = (|| {
        replace(root, &incoming)?;
        archive::validate_configuration(root)?;
        super::clear_saved_password(root)?;
        super::write_json(
            &pending,
            &Journal {
                phase: "committed".into(),
            },
        )?;
        Ok(())
    })();
    if result.is_err() {
        replace(root, &rollback)?;
        super::write_json(&work.join("notice.json"), &"rolled_back")?;
        fs::remove_file(pending)?;
        return Ok(());
    }
    super::write_json(&work.join("notice.json"), &"restored")?;
    fs::remove_file(pending)?;
    remove_owned_dir(&incoming, &work)?;
    Ok(())
}

/// 只替换白名单管理的文件，保留锁屏、历史和安装设置。
fn replace(root: &Path, source: &Path) -> Result<()> {
    if !source.is_dir() {
        return Err(BackupError::invalid(
            "Restore or rollback files are missing",
        ));
    }
    let current = archive::files(root)?;
    for path in current {
        fs::remove_file(root.join(path))?;
    }
    archive::copy_tree(source, root)
}

/// 清理后端固定工作目录中的直接子目录，拒绝越界和链接。
fn remove_owned_dir(path: &Path, parent: &Path) -> Result<()> {
    if path.parent() != Some(parent) {
        return Err(BackupError::invalid(
            "The cleanup path is outside the allowed directory",
        ));
    }
    if path.try_exists()? {
        if fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(BackupError::invalid(
                "The restore directory must not be a symbolic link",
            ));
        }
        let resolved_parent = parent.canonicalize()?;
        let resolved_target = path.canonicalize()?;
        if resolved_target.parent() != Some(resolved_parent.as_path()) {
            return Err(BackupError::invalid(
                "The resolved restore directory is outside the allowed parent",
            ));
        }
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

/// 恢复工作目录必须是当前配置根目录的真实直接子目录。
fn validate_work(root: &Path, work: &Path) -> Result<()> {
    if fs::symlink_metadata(work)?.file_type().is_symlink()
        || work.canonicalize()?.parent() != Some(root.canonicalize()?.as_path())
    {
        return Err(BackupError::invalid(
            "The restore working directory is outside the configuration root or is a symbolic link",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 新备份恢复来源设备的 WebDAV 连接信息，但不恢复其密码。
    #[test]
    fn restore_imports_webdav_connection_without_password() {
        let source = archive::tests::fixture();
        super::super::write_json(&source.path().join("global/backup.json"), &serde_json::json!({
            "url":"https://source/dav/backups/", "username":"source-user", "passwordRef":"source-secret"
        })).unwrap();
        let snapshot = archive::snapshot(source.path(), || Ok(())).unwrap();
        let mut zip = tempfile::NamedTempFile::new().unwrap();
        archive::pack(snapshot.path(), zip.as_file_mut(), || Ok(())).unwrap();
        let verified = archive::inspect(zip.path(), || Ok(())).unwrap();
        let target = archive::tests::fixture();
        super::super::write_json(&target.path().join("global/backup.json"), &serde_json::json!({
            "url":"http://target/dav/local/", "username":"target-user", "passwordRef":"target-secret"
        })).unwrap();
        stage(target.path(), &verified, || Ok(())).unwrap();
        apply_root(target.path()).unwrap();
        let settings = super::super::read_settings(target.path()).unwrap();
        assert_eq!(settings.url, "https://source/dav/backups/");
        assert_eq!(settings.username, "source-user");
        assert!(settings.password_ref.is_none());
        // 本地回滚副本保留目标设备原配置，回滚时恢复精确状态。
        let rollback =
            super::super::read_settings(&target.path().join(".backup-restore/rollback")).unwrap();
        assert_eq!(rollback.url, "http://target/dav/local/");
        assert_eq!(rollback.password_ref.as_deref(), Some("target-secret"));
    }

    /// 导入只暂存，启动后整体替换，并保留目标设备的非备份设置。
    #[test]
    fn staged_restore_applies_on_next_launch_and_keeps_rollback() {
        let source = archive::tests::fixture();
        let snapshot = archive::snapshot(source.path(), || Ok(())).unwrap();
        let mut zip = tempfile::NamedTempFile::new().unwrap();
        archive::pack(snapshot.path(), zip.as_file_mut(), || Ok(())).unwrap();
        let verified = archive::inspect(zip.path(), || Ok(())).unwrap();
        let target = archive::tests::fixture();
        fs::write(
            target.path().join("global/settings.json"),
            "{\"version\":1,\"locale\":\"en-US\"}",
        )
        .unwrap();
        fs::write(target.path().join("global/session.json"), "{\"version\":1}").unwrap();
        fs::write(target.path().join("global/lock-screen.json"), "keep-lock").unwrap();
        super::super::write_json(&target.path().join("global/backup.json"), &serde_json::json!({"url":"http://localhost/dav/backups/","username":"local","passwordRef":"old-secret"})).unwrap();
        stage(target.path(), &verified, || Ok(())).unwrap();
        assert!(
            fs::read_to_string(target.path().join("global/settings.json"))
                .unwrap()
                .contains("en-US")
        );
        // 用户源文件被删除后，恢复仍只读取后端暂存副本。
        drop(zip);
        drop(source);
        drop(verified);
        apply_root(target.path()).unwrap();
        assert!(
            fs::read_to_string(target.path().join("global/settings.json"))
                .unwrap()
                .contains("zh-CN")
        );
        assert!(!target.path().join("global/session.json").exists());
        assert_eq!(
            fs::read_to_string(target.path().join("global/lock-screen.json")).unwrap(),
            "keep-lock"
        );
        let backup: serde_json::Value =
            serde_json::from_slice(&fs::read(target.path().join("global/backup.json")).unwrap())
                .unwrap();
        assert_eq!(backup["url"], "");
        assert!(backup.get("passwordRef").is_none());
        assert!(
            target
                .path()
                .join(".backup-restore/rollback/global/settings.json")
                .exists()
        );
        assert!(!target.path().join(".backup-restore/pending.json").exists());
        apply_root(target.path()).unwrap();
    }

    /// 取消暂存不会发布待恢复标记，也不会修改原配置。
    #[test]
    fn cancelled_staging_leaves_current_configuration_untouched() {
        let source = archive::tests::fixture();
        let snapshot = archive::snapshot(source.path(), || Ok(())).unwrap();
        let mut zip = tempfile::NamedTempFile::new().unwrap();
        archive::pack(snapshot.path(), zip.as_file_mut(), || Ok(())).unwrap();
        let verified = archive::inspect(zip.path(), || Ok(())).unwrap();
        let target = archive::tests::fixture();
        let before = fs::read(target.path().join("global/security.json")).unwrap();
        assert!(
            stage(target.path(), &verified, || Err(BackupError::new(
                "backup_cancelled",
                "cancelled"
            )))
            .is_err()
        );
        assert_eq!(
            fs::read(target.path().join("global/security.json")).unwrap(),
            before
        );
        assert!(!target.path().join(".backup-restore/pending.json").exists());
    }

    /// 崩溃后从回滚副本恢复，且不触碰历史与锁屏配置。
    #[test]
    fn interrupted_restore_rolls_back_only_owned_files() {
        let root = tempfile::tempdir().unwrap();
        let work = root.path().join(".backup-restore");
        fs::create_dir_all(work.join("rollback/global")).unwrap();
        fs::create_dir_all(root.path().join("global")).unwrap();
        fs::write(work.join("rollback/global/settings.json"), "{\"old\":true}").unwrap();
        fs::write(root.path().join("global/settings.json"), "{\"new\":true}").unwrap();
        fs::write(root.path().join("global/lock-screen.json"), "keep").unwrap();
        super::super::write_json(
            &work.join("pending.json"),
            &Journal {
                phase: "applying".into(),
            },
        )
        .unwrap();
        apply_root(root.path()).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("global/settings.json")).unwrap(),
            "{\"old\":true}"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("global/lock-screen.json")).unwrap(),
            "keep"
        );
        assert!(!work.join("pending.json").exists());
    }
}
