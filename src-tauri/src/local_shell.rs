//! 本地 Shell 会话管理。
//!
//! 本模块是本地 Shell 启动参数的最终生效位置。
//! 当前本地 Shell 启动链路遵循以下规则：
//!
//! - 前端可配置 `terminalType` 与 `charset`，并随 `local_shell_connect` 一起传入后端。
//! - 同一会话重连时会复用既有启动参数；运行中的会话不会被动态改写环境变量。
//! - `terminalType` 非法或缺失时回退到 `xterm-256color`，并在启动前写入 `TERM`。
//! - `charset` 仅在非 Windows 平台生效：
//!   - `utf-8 -> en_US.UTF-8`
//!   - `gbk -> zh_CN.GBK`
//!   - `gb18030 -> zh_CN.GB18030`
//! - Windows 当前不注入 `chcp`，避免在 shell 启动阶段引入额外输出或续行副作用。
//!
//! UI 可能按 profile 类型隐藏部分字段，但隐藏仅限展示层；底层启动参数模型仍保留这些字段。
use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
#[cfg(target_os = "windows")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::mpsc::{RecvTimeoutError, channel, sync_channel};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(not(target_os = "windows"))]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::{os::windows::process::CommandExt, thread::sleep};

use engine::{
    EngineError, Session, SessionState, TerminalSize,
    util::{decode_terminal_output, now_epoch},
};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::ai::{record_terminal_exit_from_app, record_terminal_output_from_app};

const LOCAL_PROFILE_ID: &str = "__local_shell__";
const TERMINAL_OUTPUT_BATCH_BYTES: usize = 64 * 1024;
const TERMINAL_OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const TERMINAL_OUTPUT_CHANNEL_CAPACITY: usize = 16;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const WSL_LIST_TIMEOUT: Duration = Duration::from_millis(400);

/// 本地 Shell 配置。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellProfile {
    pub id: String,
    pub label: String,
    pub path: String,
    pub args: Vec<String>,
    pub kind: String,
    pub wsl_distribution: Option<String>,
}

/// 本地 Shell 启动参数。
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellLaunchConfig {
    pub terminal_type: Option<String>,
    pub charset: Option<String>,
    pub word_separators: Option<String>,
    pub bell_mode: Option<String>,
    pub bell_cooldown_ms: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    session_id: String,
}

struct LocalShellHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    _reader_thread: thread::JoinHandle<()>,
    _output_thread: thread::JoinHandle<()>,
    _waiter_thread: thread::JoinHandle<()>,
}

/// 向前端发送一个已聚合的本地终端输出批次。
fn emit_local_terminal_output(app: &AppHandle, session_id: &str, data: String) {
    if data.is_empty() {
        return;
    }
    record_terminal_output_from_app(app, session_id, &data);
    let _ = app.emit(
        "terminal:output",
        TerminalOutputPayload {
            session_id: session_id.to_string(),
            data,
        },
    );
}

/// 本地 Shell 共享状态。
pub struct LocalShellState {
    sessions: Mutex<HashMap<String, LocalShellHandle>>,
}

impl Default for LocalShellState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

#[cfg(target_os = "windows")]
fn path_exists(path: &str) -> bool {
    Path::new(path).is_file()
}

#[cfg(target_os = "windows")]
fn find_in_path(exe: &str) -> Option<String> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
fn push_unique_existing_path(candidates: &mut Vec<String>, path: String) {
    if !path_exists(&path) {
        return;
    }
    if candidates
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&path))
    {
        return;
    }
    candidates.push(path);
}

#[cfg(target_os = "windows")]
/// 收集 Windows 下 PowerShell 7 的候选路径，遵循 AppLocal、PATH、Program Files 的优先级。
fn collect_pwsh_candidates() -> Vec<String> {
    let mut candidates = Vec::new();

    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        let windows_apps = PathBuf::from(local_app_data)
            .join("Microsoft")
            .join("WindowsApps");
        // 先尝试当前用户的 App Execution Alias，再兜底扫描商店包目录，避免把版本目录名写死。
        push_unique_existing_path(
            &mut candidates,
            windows_apps.join("pwsh.exe").to_string_lossy().to_string(),
        );

        let mut package_paths = std::fs::read_dir(&windows_apps)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("Microsoft.PowerShell_"))
            })
            .map(|path| path.join("pwsh.exe"))
            .filter(|path| path.is_file())
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        package_paths.sort_unstable();
        for path in package_paths {
            push_unique_existing_path(&mut candidates, path);
        }
    }

    // 如果用户目录下没有可用商店版，再回退到 PATH 中显式暴露的 pwsh。
    if let Some(pwsh) = find_in_path("pwsh.exe") {
        push_unique_existing_path(&mut candidates, pwsh);
    }

    push_unique_existing_path(
        &mut candidates,
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe".to_string(),
    );

    candidates
}

#[cfg(target_os = "windows")]
/// 解析 `wsl.exe` 输出，兼容 UTF-8/UTF-16LE 两种常见编码。
fn decode_windows_command_output(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if bytes.iter().skip(1).step_by(2).any(|byte| *byte == 0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).to_string()
}

#[cfg(target_os = "windows")]
/// 枚举已安装的 WSL 发行版名称。
fn collect_wsl_distributions(wsl_path: &str) -> Vec<String> {
    let mut child = Command::new(wsl_path)
        .args(["-l", "-q"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(ref mut child) = child else {
        return Vec::new();
    };

    let deadline = Instant::now() + WSL_LIST_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                sleep(Duration::from_millis(15));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let Some(status) = status else {
        return Vec::new();
    };

    let mut stdout = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_end(&mut stdout);
    }
    if !status.success() {
        return Vec::new();
    }
    decode_windows_command_output(&stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(target_os = "windows")]
fn collect_windows_shells() -> Vec<LocalShellProfile> {
    let mut shells = Vec::new();

    if let Some(pwsh) = collect_pwsh_candidates().into_iter().next() {
        shells.push(LocalShellProfile {
            id: "pwsh".to_string(),
            label: "PowerShell 7".to_string(),
            path: pwsh,
            args: Vec::new(),
            kind: "native".to_string(),
            wsl_distribution: None,
        });
    }

    let windows_ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    if path_exists(windows_ps) {
        shells.push(LocalShellProfile {
            id: "powershell".to_string(),
            label: "PowerShell".to_string(),
            path: windows_ps.to_string(),
            args: Vec::new(),
            kind: "native".to_string(),
            wsl_distribution: None,
        });
    }

    let cmd = "C:\\Windows\\System32\\cmd.exe";
    if path_exists(cmd) {
        shells.push(LocalShellProfile {
            id: "cmd".to_string(),
            label: "Command Prompt".to_string(),
            path: cmd.to_string(),
            args: Vec::new(),
            kind: "native".to_string(),
            wsl_distribution: None,
        });
    }

    let git_bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    if path_exists(git_bash) {
        shells.push(LocalShellProfile {
            id: "git-bash".to_string(),
            label: "Git Bash".to_string(),
            path: git_bash.to_string(),
            args: vec!["--login".to_string(), "-i".to_string()],
            kind: "native".to_string(),
            wsl_distribution: None,
        });
    }

    let wsl = "C:\\Windows\\System32\\wsl.exe";
    if path_exists(wsl) {
        for distribution in collect_wsl_distributions(wsl) {
            shells.push(LocalShellProfile {
                id: format!("wsl:{distribution}"),
                label: format!("WSL {distribution}"),
                path: wsl.to_string(),
                args: vec!["~".to_string(), "-d".to_string(), distribution.clone()],
                kind: "wsl".to_string(),
                wsl_distribution: Some(distribution),
            });
        }
    }

    shells
}

fn collect_shells() -> Vec<LocalShellProfile> {
    #[cfg(target_os = "windows")]
    {
        collect_windows_shells()
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut shells = Vec::new();
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let label = PathBuf::from(&shell)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("shell")
            .to_string();
        let args = resolve_login_shell_args(&shell);
        shells.push(LocalShellProfile {
            id: "shell".to_string(),
            label,
            path: shell,
            args,
            kind: "native".to_string(),
            wsl_distribution: None,
        });
        shells
    }
}

#[cfg(not(target_os = "windows"))]
/// 根据 shell 可执行文件名推断 login shell 参数，确保 GUI 启动时也能加载用户环境。
fn resolve_login_shell_args(shell_path: &str) -> Vec<String> {
    let shell_name = PathBuf::from(shell_path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase())
        .unwrap_or_default();
    if shell_name.contains("fish") {
        return vec!["--login".to_string()];
    }
    vec!["-l".to_string()]
}

fn default_shell_id(shells: &[LocalShellProfile]) -> Option<String> {
    shells
        .iter()
        .find(|shell| shell.id == "powershell")
        .map(|shell| shell.id.clone())
        .or_else(|| shells.first().map(|shell| shell.id.clone()))
}

fn resolve_shell_profile(shell_id: Option<String>) -> Result<LocalShellProfile, EngineError> {
    let shells = collect_shells();
    if shells.is_empty() {
        return Err(EngineError::new(
            "local_shell_missing",
            "No available shell was found",
        ));
    }
    if let Some(id) = shell_id
        && let Some(shell) = shells.iter().find(|shell| shell.id == id)
    {
        return Ok(shell.clone());
    }
    let fallback = default_shell_id(&shells)
        .ok_or_else(|| EngineError::new("local_shell_missing", "No available shell was found"))?;
    shells
        .into_iter()
        .find(|shell| shell.id == fallback)
        .ok_or_else(|| EngineError::new("local_shell_missing", "No available shell was found"))
}

fn normalize_terminal_type(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "xterm-256color" => Some("xterm-256color"),
        "xterm" => Some("xterm"),
        "screen-256color" => Some("screen-256color"),
        "tmux-256color" => Some("tmux-256color"),
        "vt100" => Some("vt100"),
        _ => None,
    }
}

#[cfg(not(target_os = "windows"))]
fn normalize_locale_for_charset(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "utf-8" => Some("en_US.UTF-8"),
        "gbk" => Some("zh_CN.GBK"),
        "gb18030" => Some("zh_CN.GB18030"),
        _ => None,
    }
}

/// 枚举本地可用 Shell 列表。
pub fn list_local_shells() -> Vec<LocalShellProfile> {
    collect_shells()
}

/// 启动本地 Shell 会话。
pub fn start_local_shell(
    app: AppHandle,
    state: &LocalShellState,
    shell_id: Option<String>,
    launch_config: Option<LocalShellLaunchConfig>,
    size: TerminalSize,
) -> Result<Session, EngineError> {
    let session_id = Uuid::new_v4().to_string();
    let shell = resolve_shell_profile(shell_id)?;
    let pty_system = native_pty_system();
    let pty_pair = pty_system.openpty(PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    let pair = pty_pair.map_err(|err| {
        EngineError::with_detail(
            "local_shell_failed",
            "Failed to create the local terminal",
            err.to_string(),
        )
    })?;

    let mut command = CommandBuilder::new(&shell.path);
    let resolved_term = launch_config
        .as_ref()
        .and_then(|cfg| cfg.terminal_type.as_deref())
        .and_then(normalize_terminal_type)
        .unwrap_or("xterm-256color");
    command.env("TERM", resolved_term);
    let colorterm = env::var("COLORTERM").unwrap_or_default();
    if colorterm.trim().is_empty() {
        command.env("COLORTERM", "truecolor");
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut should_set_locale = true;
        if let Some(cfg) = launch_config.as_ref()
            && let Some(charset) = cfg.charset.as_deref()
            && charset.trim().eq_ignore_ascii_case("utf-8")
        {
            let env_lang = env::var("LANG").unwrap_or_default().to_ascii_lowercase();
            let env_lc_ctype = env::var("LC_CTYPE")
                .unwrap_or_default()
                .to_ascii_lowercase();
            if env_lang.contains("utf-8")
                || env_lang.contains("utf8")
                || env_lc_ctype.contains("utf-8")
                || env_lc_ctype.contains("utf8")
            {
                should_set_locale = false;
            }
        }
        if should_set_locale
            && let Some(locale) = launch_config
                .as_ref()
                .and_then(|cfg| cfg.charset.as_deref())
                .and_then(normalize_locale_for_charset)
        {
            command.env("LC_CTYPE", locale);
            command.env("LANG", locale);
        }
    }
    for arg in &shell.args {
        command.arg(arg);
    }
    let mut child = pair.slave.spawn_command(command).map_err(|err| {
        EngineError::with_detail(
            "local_shell_failed",
            "Failed to start the local shell",
            err.to_string(),
        )
    })?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|err| {
        EngineError::with_detail(
            "local_shell_failed",
            "Failed to read local terminal output",
            err.to_string(),
        )
    })?;
    let writer = pair.master.take_writer().map_err(|err| {
        EngineError::with_detail(
            "local_shell_failed",
            "Failed to write to the local terminal",
            err.to_string(),
        )
    })?;
    let killer = child.clone_killer();

    // 有界通道把 PTY 读取速度与输出聚合速度关联起来，避免读取线程无限堆积原始块。
    let (output_tx, output_rx) = sync_channel::<Vec<u8>>(TERMINAL_OUTPUT_CHANNEL_CAPACITY);
    let reader_thread = thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    if output_tx.send(buffer[..size].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let session_id_output = session_id.clone();
    let app_output = app.clone();
    let (output_done_tx, output_done_rx) = channel::<()>();
    let output_thread = thread::spawn(move || {
        let mut pending = Vec::with_capacity(TERMINAL_OUTPUT_BATCH_BYTES);
        while let Ok(first) = output_rx.recv() {
            pending.extend_from_slice(&first);
            let batch_started = Instant::now();
            let mut disconnected = false;
            while pending.len() < TERMINAL_OUTPUT_BATCH_BYTES {
                let remaining =
                    TERMINAL_OUTPUT_FLUSH_INTERVAL.saturating_sub(batch_started.elapsed());
                if remaining.is_zero() {
                    break;
                }
                match output_rx.recv_timeout(remaining) {
                    Ok(chunk) => pending.extend_from_slice(&chunk),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
            // 批次提前装满时暂停继续读取，让有界通道和 PTY 形成自然背压。
            let remaining = TERMINAL_OUTPUT_FLUSH_INTERVAL.saturating_sub(batch_started.elapsed());
            if !remaining.is_zero() && !disconnected {
                thread::sleep(remaining);
            }
            let data = decode_terminal_output(&mut pending, disconnected);
            emit_local_terminal_output(&app_output, &session_id_output, data);
            if disconnected {
                break;
            }
        }
        let data = decode_terminal_output(&mut pending, true);
        emit_local_terminal_output(&app_output, &session_id_output, data);
        let _ = output_done_tx.send(());
    });

    let session_id_wait = session_id.clone();
    let app_wait = app.clone();
    let waiter_thread = thread::spawn(move || {
        let _ = child.wait();
        // 尽量保证最后一批输出先于退出事件抵达前端，超时后仍允许会话完成清理。
        let _ = output_done_rx.recv_timeout(Duration::from_secs(1));
        record_terminal_exit_from_app(&app_wait, &session_id_wait);
        let _ = app_wait.emit(
            "terminal:exit",
            TerminalExitPayload {
                session_id: session_id_wait,
            },
        );
    });

    let handle = LocalShellHandle {
        master: pair.master,
        writer,
        killer,
        _reader_thread: reader_thread,
        _output_thread: output_thread,
        _waiter_thread: waiter_thread,
    };

    let mut sessions = state.sessions.lock().map_err(|_| {
        EngineError::new(
            "local_shell_lock_failed",
            "Local shell state is unavailable",
        )
    })?;
    sessions.insert(session_id.clone(), handle);

    Ok(Session {
        session_id,
        profile_id: Some(LOCAL_PROFILE_ID.to_string()),
        kind: engine::SessionKind::LocalShell,
        state: SessionState::Connected,
        created_at: now_epoch(),
        last_error: None,
    })
}

/// 写入本地 Shell 输入。
pub fn write_local_shell(
    state: &LocalShellState,
    session_id: &str,
    data: &[u8],
) -> Result<(), EngineError> {
    let mut sessions = state.sessions.lock().map_err(|_| {
        EngineError::new(
            "local_shell_lock_failed",
            "Local shell state is unavailable",
        )
    })?;
    let handle = sessions
        .get_mut(session_id)
        .ok_or_else(|| EngineError::new("local_shell_missing", "Local shell session not found"))?;
    handle.writer.write_all(data).map_err(|err| {
        EngineError::with_detail(
            "local_shell_write_failed",
            "Failed to write to the local shell",
            err.to_string(),
        )
    })?;
    handle.writer.flush().map_err(|err| {
        EngineError::with_detail(
            "local_shell_write_failed",
            "Failed to flush the local shell",
            err.to_string(),
        )
    })?;
    Ok(())
}

/// 调整本地 Shell 终端尺寸。
pub fn resize_local_shell(
    state: &LocalShellState,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), EngineError> {
    let mut sessions = state.sessions.lock().map_err(|_| {
        EngineError::new(
            "local_shell_lock_failed",
            "Local shell state is unavailable",
        )
    })?;
    let handle = sessions
        .get_mut(session_id)
        .ok_or_else(|| EngineError::new("local_shell_missing", "Local shell session not found"))?;
    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| {
            EngineError::with_detail(
                "local_shell_resize_failed",
                "Failed to resize the local shell",
                err.to_string(),
            )
        })?;
    Ok(())
}

/// 关闭本地 Shell 会话。
pub fn stop_local_shell(state: &LocalShellState, session_id: &str) -> Result<(), EngineError> {
    let mut sessions = state.sessions.lock().map_err(|_| {
        EngineError::new(
            "local_shell_lock_failed",
            "Local shell state is unavailable",
        )
    })?;
    let mut handle = sessions
        .remove(session_id)
        .ok_or_else(|| EngineError::new("local_shell_missing", "Local shell session not found"))?;
    let _ = handle.killer.kill();
    Ok(())
}
