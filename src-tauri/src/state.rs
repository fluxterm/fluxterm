//! 共享状态定义。
use std::sync::{Arc, Mutex};

use fluxterm_engine::{Engine, SerialManager};

/// Tauri 共享状态，承载引擎实例。
pub struct EngineState {
    pub engine: Arc<Engine>,
}

/// 串口运行时共享状态。
pub struct SerialState {
    pub manager: Arc<SerialManager>,
}

/// 已解锁的主密码会话。
#[derive(Clone)]
pub struct UnlockedSecretSession {
    pub key_id: String,
    pub encryption_key: [u8; 32],
}

/// 安全模块运行时状态，仅保存内存态解锁信息。
pub struct SecurityState {
    session: Mutex<Option<UnlockedSecretSession>>,
}

impl Default for SecurityState {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }
}

impl SecurityState {
    /// 读取当前已解锁会话快照。
    pub fn current_session(&self) -> Option<UnlockedSecretSession> {
        self.session.lock().ok().and_then(|guard| guard.clone())
    }

    /// 写入新的已解锁会话。
    pub fn set_session(&self, session: UnlockedSecretSession) {
        if let Ok(mut guard) = self.session.lock() {
            *guard = Some(session);
        }
    }

    /// 清空当前已解锁会话。
    pub fn clear_session(&self) {
        if let Ok(mut guard) = self.session.lock() {
            *guard = None;
        }
    }
}
