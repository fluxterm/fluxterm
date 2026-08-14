# 安全数据保护设计

## 概述

FluxTerm 使用统一的安全数据保护模型管理 SSH/RDP 密码、分类型密码管理器凭据、私钥口令与 AI Key。

当前实现基于两种加密 Provider：

- `embedded`：应用内置弱保护模式
- `user_password`：用户密码强保护模式

两种模式都会将敏感数据保存为 `enc:v1:` 结构化密文。

## 适用范围

本设计覆盖以下敏感数据：

- `HostProfile.password_ref`
- `HostProfile.private_key_passphrase_ref`
- `Credential.password_ref`
- AI Provider 的 `api_key_ref`

其余普通配置项仍按原有方式保存。

## 术语

### 弱保护

敏感字段使用应用内置密钥进行加密保存。该模式不需要用户输入安全密码，运行期始终可读。

### 强保护

敏感字段使用用户安全密码派生的密钥进行加密保存。应用重启后默认进入锁定状态，解锁后方可读取。

### 已锁定

当前运行期内没有可用的用户密码会话密钥，强保护数据不可读取。

### 已解锁

当前运行期内存在可用的用户密码会话密钥，强保护数据可以读取。

## 模块结构

```text
src-tauri/src/security
├─ mod.rs
├─ crypto.rs
├─ provider.rs
├─ secret_store.rs
├─ types.rs
└─ providers
   ├─ embedded.rs
   ├─ mod.rs
   └─ user_password.rs
```

相关模块：

- `src-tauri/src/profile_secrets.rs`
  负责 `HostProfile` 敏感字段的保护与解保护
- `src-tauri/src/credential_store.rs`
  负责 SSH/RDP 分类型凭据的持久化，以及密码字段的统一保护与解保护
- `src-tauri/src/commands/security.rs`
  负责安全状态查询、启用强保护、解锁、锁定、更换密码与降级回弱保护
- `src-tauri/src/commands/ssh.rs`
  连接 SSH 时按 `profile.id` 重新读取并解析受保护字段
- `src-tauri/src/ai_settings.rs`
  统一处理 AI Key 的保存与读取

## 分层职责

### Provider

Provider 负责原始字节级别的加解密能力。

当前实现：

- `EmbeddedProvider`
- `UserPasswordProvider`

### CryptoService

`CryptoService` 是统一安全服务入口，负责：

- 根据配置选择当前 Provider
- 基于安全密码派生会话密钥
- 生成与解析结构化密文
- 输出当前安全状态

### SecretStore

`SecretStore` 负责业务字段层面的统一读写规则：

- 明文字段写入时统一加密为 `enc:v1:` 密文
- 读取时仅接受 `enc:v1:` 密文格式

### ProfileSecretCodec

`profile_secrets.rs` 负责定义 `HostProfile` 中属于敏感字段的项，并统一执行保护与解保护。

## 安全模式

### 弱保护模式（`embedded`）

弱保护模式下：

- `profiles.json` 中的 `secret.provider` 为 `embedded`
- 敏感字段写盘时统一保存为 `enc:v1:` 密文
- 加密密钥由应用内置常量派生
- 运行期始终可读，不存在锁定状态

示例：

```json
{
  "version": 1,
  "provider": "embedded",
  "active_key_id": "embedded-v1",
  "kdf_salt": null,
  "verify_hash": null
}
```

该模式用于提供默认可用的基础保护能力。

### 强保护模式（`user_password`）

启用后：

- `profiles.json` 中的 `secret.provider` 为 `user_password`
- 敏感字段写盘时统一保存为 `enc:v1:` 密文
- 加密密钥由用户安全密码派生
- 应用重启后默认进入已锁定状态

示例：

```json
{
  "version": 1,
  "provider": "user_password",
  "active_key_id": "master-uuid",
  "kdf_salt": "base64...",
  "verify_hash": "base64..."
}
```

字段说明：

- `active_key_id`
  当前密钥标识
- `kdf_salt`
  安全密码派生时使用的随机盐值
- `verify_hash`
  用于校验用户输入的安全密码是否正确

## 密文格式

敏感字段统一写盘为以下格式：

```text
enc:v1:<base64(payload-bytes)>
```

其中 `payload-bytes` 为 JSON 序列化后的字节，并整体进行 Base64 编码。

内部载荷结构如下：

```json
{
  "provider": "user_password",
  "algorithm": "aes256_gcm",
  "keyId": "master-uuid",
  "nonce": "base64...",
  "ciphertext": "base64..."
}
```

当 Provider 为弱保护模式时，`provider` 字段对应为 `embedded`，`keyId` 为 `embedded-v1`。

## 运行时行为

### 初始状态

- 弱保护模式：应用启动后可直接读取敏感字段
- 强保护模式：应用启动后默认处于已锁定状态

### 启用强保护

用户在安全页设置安全密码后：

1. 后端生成新的强保护配置与当前会话密钥
2. 已保存的 SSH/RDP 密码、密码管理器凭据、私钥口令与 AI Key 统一重新加密
3. 当前运行期保持已解锁状态

### 解锁

用户输入安全密码后：

1. 后端校验 `verify_hash`
2. 派生出当前运行期可用的会话密钥
3. 强保护数据在当前运行期内可被读取

### 锁定

用户主动锁定后：

1. 内存中的用户密码会话密钥被清除
2. 磁盘中的密文保持不变
3. 需要重新输入安全密码才能读取强保护数据

### 更换密码

用户输入当前安全密码与新安全密码后：

1. 后端校验当前安全密码
2. 使用新密码生成新的强保护配置
3. 已保存的受保护数据切换到新的用户密码密钥

### 降级回弱保护

关闭强保护后：

1. 当前敏感字段重新加密为 `embedded` 模式密文
2. `profiles.json` 中的安全模式切换回 `embedded`
3. 后续不再要求输入安全密码

## SSH、RDP、密码管理器与 AI 的读取规则

### SSH

SSH 建立连接时，后端不直接信任前端内存中的凭据副本，而是：

1. 根据 `profile.id` 重新读取本地配置
2. 按当前安全状态解析敏感字段
3. 在强保护且已锁定状态下直接阻止连接

该机制用于确保锁定后 SSH 凭据立即失效。

### 密码管理器

- 凭据按 `ssh` 与 `rdp` 类型严格隔离，Profile 仅保存 `credentialId`
- 动态引用在连接前由后端按协议类型解析，不接受跨类型引用
- 凭据名称、类型和用户名属于可展示元数据；密码始终以 `enc:v1:` 密文保存
- RDP 凭据模型预留空 `domain` 字段，当前版本不参与界面、复制或连接解析
- 强保护锁定时允许读取凭据摘要，但禁止新增、修改、复制、删除和连接

### AI

AI 使用 Provider Key 时统一通过 `SecretStore` 读取：

- 弱保护模式下可直接读取明文结果
- 强保护且已解锁时可读取明文结果
- 强保护且已锁定时返回锁定错误

## 前端状态表达

状态栏显示三种安全状态：

- `弱保护`
- `已解锁`
- `已锁定`

交互规则：

- `弱保护`：点击后打开安全设置
- `已锁定`：点击后打开安全设置并引导用户解锁
- `已解锁`：点击后立即锁定

安全设置页提供以下能力：

- 启用强保护
- 解锁
- 更换密码
- 立即锁定
- 切换回弱保护

安全操作执行期间，整个配置弹窗进入忙碌态遮盖。

## 后端命令接口

当前暴露以下安全相关命令：

- `security_status`
- `security_unlock`
- `security_lock`
- `security_enable_with_password`
- `security_change_password`
- `security_disable_encryption`

这些命令统一返回 `SecurityStatus`，供前端更新状态展示与交互。

其中：

- `security_enable_with_password`：从弱保护切换到强保护
- `security_disable_encryption`：从强保护切换回弱保护

## 约束

- 默认模式为 `embedded` 弱保护模式
- 敏感字段始终保存为 `enc:v1:` 密文
- 敏感字段仅接受 `enc:v1:` 结构化密文格式
- 强保护未解锁时，不允许读取受保护字段
- SSH 与 AI 共享同一套安全状态
- 安全密码最少为 4 个字符
- 安全密码仅保存在内存中，不写入磁盘

## 用户可见结果

从产品行为上看，安全功能提供以下体验：

- 默认具备基础保护能力，无需额外设置即可使用
- 启用强保护后，本次运行立即可用
- 应用重启后需要重新输入安全密码
- 锁定后，AI 与 SSH 的强保护数据立即不可用
- 切换回弱保护后，仍保持加密存储，但不再要求输入安全密码
