//! 配置文件事务协调，保证快照不会跨越密钥轮换等多文件操作。
use parking_lot::{ReentrantMutex, ReentrantMutexGuard};
static CONFIG_TRANSACTION: ReentrantMutex<()> = ReentrantMutex::new(());
/// 获取可重入配置事务锁；外层业务事务与底层原子写入共用同一把锁。
pub fn lock() -> ReentrantMutexGuard<'static, ()> {
    CONFIG_TRANSACTION.lock()
}
