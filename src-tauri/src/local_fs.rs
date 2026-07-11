//! 本地文件系统读取工具。
use std::fs;
#[cfg(target_os = "windows")]
use std::path::Path;

use engine::{EngineError, SftpEntry, SftpEntryKind};

/// 读取本地目录条目并转换为通用 SFTP 结构。
pub fn local_list_entries(path: &str) -> Result<Vec<SftpEntry>, EngineError> {
    #[cfg(windows)]
    if path == "drives://" {
        return list_windows_drives();
    }
    let dir = fs::read_dir(path).map_err(|err| {
        EngineError::with_detail(
            "local_list_failed",
            "Failed to read the local directory",
            err.to_string(),
        )
    })?;
    let mut entries = Vec::new();
    for item in dir {
        let entry = item.map_err(|err| {
            EngineError::with_detail(
                "local_list_failed",
                "Failed to read a local directory entry",
                err.to_string(),
            )
        })?;
        let file_type = entry.file_type().map_err(|err| {
            EngineError::with_detail(
                "local_list_failed",
                "Failed to read the file type",
                err.to_string(),
            )
        })?;
        let metadata = entry.metadata().map_err(|err| {
            EngineError::with_detail(
                "local_list_failed",
                "Failed to read file metadata",
                err.to_string(),
            )
        })?;
        let name = entry.file_name().to_string_lossy().to_string();
        let full_path = entry.path().to_string_lossy().to_string();
        let kind = if file_type.is_dir() {
            SftpEntryKind::Dir
        } else if file_type.is_symlink() {
            SftpEntryKind::Link
        } else {
            SftpEntryKind::File
        };
        let hidden = local_hidden(&name, &metadata);
        let size = if file_type.is_file() {
            Some(metadata.len())
        } else {
            None
        };
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        let (owner, group) = local_owner_group(&metadata);
        let permissions = local_permissions(&metadata);
        entries.push(SftpEntry {
            path: full_path,
            name,
            kind,
            hidden: Some(hidden),
            size,
            mtime,
            permissions,
            owner,
            group,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

#[cfg(windows)]
fn list_windows_drives() -> Result<Vec<SftpEntry>, EngineError> {
    let mut entries = Vec::new();
    for letter in b'A'..=b'Z' {
        let drive = format!("{}:\\", letter as char);
        if !Path::new(&drive).exists() {
            continue;
        }
        entries.push(SftpEntry {
            path: drive.clone(),
            name: format!("{}:", letter as char),
            kind: SftpEntryKind::Dir,
            hidden: Some(false),
            size: None,
            mtime: None,
            permissions: None,
            owner: None,
            group: None,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

#[cfg(unix)]
fn local_owner_group(metadata: &std::fs::Metadata) -> (Option<String>, Option<String>) {
    use std::os::unix::fs::MetadataExt;
    (
        Some(metadata.uid().to_string()),
        Some(metadata.gid().to_string()),
    )
}

#[cfg(not(unix))]
fn local_owner_group(_metadata: &std::fs::Metadata) -> (Option<String>, Option<String>) {
    (None, None)
}

#[cfg(unix)]
fn local_permissions(metadata: &std::fs::Metadata) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = metadata.permissions().mode() & 0o777;
    Some(format_permissions(mode))
}

#[cfg(not(unix))]
fn local_permissions(_metadata: &std::fs::Metadata) -> Option<String> {
    None
}

#[cfg(windows)]
fn local_hidden(name: &str, metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    let _ = name;
    metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

#[cfg(not(windows))]
fn local_hidden(name: &str, _metadata: &std::fs::Metadata) -> bool {
    name.starts_with('.')
}

#[cfg(unix)]
fn format_permissions(perm: u32) -> String {
    let flags = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    flags
        .iter()
        .map(|(flag, ch)| if perm & *flag != 0 { *ch } else { '-' })
        .collect()
}
