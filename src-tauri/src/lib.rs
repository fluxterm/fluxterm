//! Tauri 应用入口与命令注册。
pub mod ai;
pub mod ai_settings;
pub mod commands;
pub mod config_paths;
pub mod events;
pub mod local_fs;
pub mod local_shell;
#[cfg(feature = "performance-telemetry")]
pub mod performance_telemetry;
pub mod profile_secrets;
pub mod rdp;
pub mod rdp_profile_store;
pub mod remote_edit;
pub mod resource_monitor;
pub mod security;
pub mod security_store;
pub mod serial_profile_store;
pub mod session_settings;
pub mod ssh_config_import;
pub mod ssh_host_keys;
pub mod ssh_profile_store;
pub mod state;
pub mod utils;

use std::sync::Arc;

use engine::Engine;
use fluxterm_logging::{LogLevel, log_event};
#[cfg(feature = "performance-telemetry")]
use fluxterm_performance_telemetry::install_global_sink;
use log::LevelFilter;
use rustls::crypto::aws_lc_rs;
use serde_json::json;
use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};

use crate::commands::ai::{
    ai_provider_test, ai_session_chat, ai_session_chat_stream_cancel, ai_session_chat_stream_start,
    ai_settings_get, ai_settings_save,
};
use crate::commands::configuration::{
    background_delete, background_import, background_read, config_read_text, config_write_text,
};
use crate::commands::file::file_open;
use crate::commands::local::{local_home, local_list, local_ssh_keys};
use crate::commands::local_shell::{
    local_shell_connect, local_shell_disconnect, local_shell_list, local_shell_resize,
    local_shell_write, local_shell_write_binary,
};
use crate::commands::lock_screen::{
    LockScreenState, lock_screen, lock_screen_password_set, lock_screen_status, unlock_screen,
};
use crate::commands::profile::{
    profile_groups_list, profile_groups_save, profile_list, profile_remove, profile_save,
    ssh_import_openssh_config,
};
use crate::commands::proxy::{proxy_close, proxy_close_all, proxy_list, proxy_open};
use crate::commands::rdp::{
    rdp_profile_delete, rdp_profile_groups_list, rdp_profile_groups_save, rdp_profile_list,
    rdp_profile_save, rdp_session_cert_decide, rdp_session_connect, rdp_session_create,
    rdp_session_disconnect, rdp_session_resize, rdp_session_send_input,
    rdp_session_set_audio_muted, rdp_session_set_clipboard,
};
use crate::commands::remote_edit::{
    remote_edit_confirm_upload, remote_edit_dismiss_pending, remote_edit_list, remote_edit_open,
};
use crate::commands::resource_monitor::{
    resource_monitor_start_local, resource_monitor_start_ssh, resource_monitor_stop,
};
use crate::commands::security::{
    security_change_password, security_enable_strong_protection, security_enable_weak_protection,
    security_lock, security_status, security_unlock,
};
use crate::commands::serial::{
    serial_cancel_connect, serial_connect, serial_disconnect, serial_port_list,
    serial_profile_groups_list, serial_profile_groups_save, serial_profile_list,
    serial_profile_remove, serial_profile_save, serial_write_binary, serial_write_text,
};
use crate::commands::sftp::{
    sftp_cancel_transfer, sftp_download, sftp_download_dir, sftp_home, sftp_list, sftp_mkdir,
    sftp_remove, sftp_rename, sftp_resolve_path, sftp_upload, sftp_upload_paths,
};
use crate::commands::ssh::{
    ssh_connect, ssh_disconnect, ssh_host_key_confirm, ssh_resize, ssh_write, ssh_write_binary,
};
use crate::commands::system::{
    app_config_dir, app_data_dir, bootstrap_locale_set, config_directory_reset,
    config_directory_select_parent, config_directory_status, get_system_info, open_devtools,
};
use crate::commands::tunnel::{
    ssh_tunnel_close, ssh_tunnel_close_all, ssh_tunnel_list, ssh_tunnel_open,
};
use crate::local_shell::LocalShellState;
#[cfg(feature = "performance-telemetry")]
use crate::performance_telemetry::{
    ConfigLoadResult, PerformanceTelemetryService, load_config,
    performance_telemetry_record_rdp_batch, performance_telemetry_status_get,
};
use crate::rdp::RdpState;
use crate::remote_edit::RemoteEditState;
use crate::resource_monitor::ResourceMonitorState;
use crate::state::{EngineState, SecurityState, SerialState};

fn resolve_log_level() -> (LevelFilter, Option<String>) {
    let Ok(raw) = std::env::var("FLUXTERM_LOG_LEVEL") else {
        return (LevelFilter::Info, None);
    };
    let normalized = raw.trim().to_ascii_lowercase();
    let level = match normalized.as_str() {
        "trace" => LevelFilter::Trace,
        "debug" => LevelFilter::Debug,
        "info" => LevelFilter::Info,
        "warn" => LevelFilter::Warn,
        "error" => LevelFilter::Error,
        "off" => LevelFilter::Off,
        _ => return (LevelFilter::Info, Some(raw)),
    };
    (level, None)
}

/// 在应用启动早期固定安装 rustls 的全局加密提供者。
///
/// 当前依赖图会同时带入 `aws-lc-rs` 与 `ring` 相关特性，若不显式选择，
/// `IronRDP` 在 TLS 升级阶段会触发进程级 panic。
fn install_rustls_crypto_provider() {
    let _ = aws_lc_rs::default_provider().install_default();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(message) = crate::config_paths::load_dotenv_strict() {
        eprintln!("{message}");
        std::process::exit(1);
    }
    install_rustls_crypto_provider();
    let (log_level, invalid_log_level) = resolve_log_level();
    let log_targets = vec![
        Target::new(TargetKind::Stdout),
        Target::new(TargetKind::LogDir { file_name: None }),
    ];
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::new().build());
    let builder = builder.setup(|app| {
        let config_directory_state =
            crate::config_paths::initialize_config_directory_state(app.handle())?;
        app.manage(config_directory_state);
        #[cfg(feature = "performance-telemetry")]
        {
            let service = match load_config(app.handle()) {
                ConfigLoadResult::Disabled => PerformanceTelemetryService::disabled(),
                ConfigLoadResult::Invalid(error) => {
                    error.log();
                    PerformanceTelemetryService::disabled()
                }
                ConfigLoadResult::Enabled(config) => {
                    match performance_telemetry::load_device_identity(app.handle()) {
                        Ok(device) => match PerformanceTelemetryService::start(config, device) {
                            Ok(service) => service,
                            Err(error) => {
                                error.log();
                                PerformanceTelemetryService::disabled()
                            }
                        },
                        Err(error) => {
                            error.log();
                            PerformanceTelemetryService::disabled()
                        }
                    }
                }
            };
            if let Some(sink) = service.sink() {
                let _ = install_global_sink(sink);
            }
            app.manage(service);
        }
        Ok(())
    });
    let builder = builder
        .manage(EngineState {
            engine: Arc::new(Engine::new()),
        })
        .manage(SecurityState::default())
        .manage(LockScreenState::default())
        .manage(SerialState {
            manager: Arc::new(engine::SerialManager::new()),
        })
        .manage(LocalShellState::default())
        .manage(ResourceMonitorState::default())
        .manage(RdpState::default())
        .manage(RemoteEditState::default())
        .manage(ai::AiRuntimeState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .targets(log_targets)
                .level(log_level)
                // https://github.com/tauri-apps/tauri/issues/8494 2025年7月22日 未解决
                // 抑制 tao::platform_impl::platform::event 警告的日志
                .filter(|metadata| {
                    metadata.target() != "tao::platform_impl::platform::event_loop::runner"
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            profile_list,
            config_read_text,
            config_write_text,
            background_import,
            background_read,
            background_delete,
            profile_groups_list,
            profile_groups_save,
            profile_save,
            profile_remove,
            ssh_import_openssh_config,
            ai_session_chat,
            ai_session_chat_stream_start,
            ai_session_chat_stream_cancel,
            ai_settings_get,
            ai_settings_save,
            ai_provider_test,
            lock_screen_status,
            lock_screen,
            unlock_screen,
            lock_screen_password_set,
            security_status,
            security_unlock,
            security_lock,
            security_enable_strong_protection,
            security_change_password,
            security_enable_weak_protection,
            ssh_connect,
            ssh_disconnect,
            ssh_host_key_confirm,
            ssh_resize,
            ssh_write,
            ssh_write_binary,
            serial_port_list,
            serial_profile_list,
            serial_profile_groups_list,
            serial_profile_groups_save,
            serial_profile_save,
            serial_profile_remove,
            serial_connect,
            serial_cancel_connect,
            serial_disconnect,
            serial_write_text,
            serial_write_binary,
            ssh_tunnel_open,
            ssh_tunnel_close,
            ssh_tunnel_list,
            ssh_tunnel_close_all,
            sftp_list,
            sftp_home,
            sftp_resolve_path,
            sftp_upload,
            sftp_upload_paths,
            sftp_download,
            sftp_download_dir,
            sftp_cancel_transfer,
            sftp_rename,
            sftp_remove,
            sftp_mkdir,
            local_home,
            local_list,
            local_ssh_keys,
            file_open,
            local_shell_connect,
            local_shell_disconnect,
            local_shell_list,
            local_shell_write,
            local_shell_write_binary,
            local_shell_resize,
            resource_monitor_start_local,
            resource_monitor_start_ssh,
            resource_monitor_stop,
            app_config_dir,
            app_data_dir,
            config_directory_status,
            config_directory_select_parent,
            config_directory_reset,
            bootstrap_locale_set,
            get_system_info,
            open_devtools,
            proxy_open,
            proxy_close,
            proxy_list,
            proxy_close_all,
            rdp_profile_groups_list,
            rdp_profile_groups_save,
            rdp_profile_list,
            rdp_profile_save,
            rdp_profile_delete,
            rdp_session_create,
            rdp_session_connect,
            rdp_session_disconnect,
            rdp_session_send_input,
            rdp_session_resize,
            rdp_session_set_clipboard,
            rdp_session_set_audio_muted,
            rdp_session_cert_decide,
            remote_edit_open,
            remote_edit_list,
            remote_edit_confirm_upload,
            remote_edit_dismiss_pending,
            #[cfg(feature = "performance-telemetry")]
            performance_telemetry_status_get,
            #[cfg(feature = "performance-telemetry")]
            performance_telemetry_record_rdp_batch,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    if let Some(value) = invalid_log_level {
        log_event!(
            LogLevel::Warn,
            "logging.configuration.invalid",
            json!({
                "error": {
                    "code": "logging_level_invalid",
                    "message": "Logging level is invalid",
                    "detail": value,
                }
            }),
        );
    }
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let rdp = app.state::<RdpState>();
            let _ = rdp.shutdown_runtime();
            #[cfg(feature = "performance-telemetry")]
            if let Some(service) = app.try_state::<Arc<PerformanceTelemetryService>>() {
                service.shutdown();
            }
        }
    });
}
