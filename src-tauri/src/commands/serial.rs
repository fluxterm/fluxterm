//! 串口枚举、Profile 与会话命令。

use fluxterm_engine::serial::validate_profile;
use fluxterm_engine::{EngineError, SerialEncoding, SerialPortInfo, SerialProfile, Session};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::events::build_event_bridge;
use crate::serial_profile_store::{
    read_serial_groups, read_serial_profiles, write_serial_groups, write_serial_profiles,
};
use crate::state::SerialState;

/// 枚举系统当前可用串口。
#[tauri::command]
pub fn serial_port_list(state: State<'_, SerialState>) -> Result<Vec<SerialPortInfo>, EngineError> {
    state.manager.list_ports()
}

/// 读取独立保存的串口 Profile。
#[tauri::command]
pub fn serial_profile_list(app: AppHandle) -> Result<Vec<SerialProfile>, EngineError> {
    Ok(read_serial_profiles(&app)?.profiles)
}

/// 读取串口 Profile 分组。
#[tauri::command]
pub fn serial_profile_groups_list(app: AppHandle) -> Result<Vec<String>, EngineError> {
    read_serial_groups(&app)
}

/// 覆盖保存串口 Profile 分组。
#[tauri::command]
pub fn serial_profile_groups_save(
    app: AppHandle,
    groups: Vec<String>,
) -> Result<Vec<String>, EngineError> {
    write_serial_groups(&app, &groups)
}

/// 新增或更新串口 Profile。
#[tauri::command]
pub fn serial_profile_save(
    app: AppHandle,
    mut profile: SerialProfile,
) -> Result<SerialProfile, EngineError> {
    profile.name = profile.name.trim().to_string();
    profile.port_name = profile.port_name.trim().to_string();
    if profile.name.is_empty() {
        return Err(EngineError::new(
            "serial_profile_name_required",
            "Serial profile name is required",
        )
        .with_message_key("error.serial.profileNameRequired"));
    }
    validate_profile(&profile)?;
    if profile.id.trim().is_empty() {
        profile.id = Uuid::new_v4().to_string();
    }
    let mut store = read_serial_profiles(&app)?;
    if let Some(existing) = store.profiles.iter_mut().find(|item| item.id == profile.id) {
        *existing = profile.clone();
    } else {
        store.profiles.push(profile.clone());
    }
    store.updated_at = now_epoch();
    write_serial_profiles(&app, &store)?;
    Ok(profile)
}

/// 删除指定串口 Profile。
#[tauri::command]
pub fn serial_profile_remove(app: AppHandle, profile_id: String) -> Result<bool, EngineError> {
    let mut store = read_serial_profiles(&app)?;
    let before = store.profiles.len();
    store.profiles.retain(|item| item.id != profile_id);
    store.updated_at = now_epoch();
    write_serial_profiles(&app, &store)?;
    Ok(before != store.profiles.len())
}

/// 建立串口会话；空 id 表示不持久化的快速连接。
#[tauri::command]
pub async fn serial_connect(
    app: AppHandle,
    state: State<'_, SerialState>,
    operation_id: String,
    profile: SerialProfile,
) -> Result<Session, EngineError> {
    let profile_id = (!profile.id.trim().is_empty()).then(|| profile.id.clone());
    state
        .manager
        .connect(operation_id, profile, profile_id, build_event_bridge(app))
        .await
}

/// 取消尚未完成的串口连接任务。
#[tauri::command]
pub fn serial_cancel_connect(
    state: State<'_, SerialState>,
    operation_id: String,
) -> Result<bool, EngineError> {
    state.manager.cancel_connect(&operation_id)
}

/// 按指定编码向串口写入文本。
#[tauri::command]
pub async fn serial_write_text(
    state: State<'_, SerialState>,
    session_id: String,
    data: String,
    encoding: SerialEncoding,
) -> Result<Vec<u8>, EngineError> {
    state.manager.write_text(&session_id, data, encoding).await
}

/// 向串口写入未经转换的原始字节。
#[tauri::command]
pub async fn serial_write_binary(
    state: State<'_, SerialState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), EngineError> {
    state.manager.write_binary(&session_id, data).await
}

/// 主动断开串口会话。
#[tauri::command]
pub async fn serial_disconnect(
    state: State<'_, SerialState>,
    session_id: String,
) -> Result<(), EngineError> {
    state.manager.disconnect(&session_id).await
}

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}
