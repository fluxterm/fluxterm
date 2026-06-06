# ![FluxTerm Logo](./src-tauri/icons/32x32.png) FluxTerm

[English](./README.md) | 简体中文

![Preview](https://github.com/fluxterm/fluxterm/blob/main/docs/assets/preview.png)

**FluxTerm** 是一个基于 `Tauri + Rust + React` 构建的现代桌面终端，统一提供本地 Shell、SSH、SFTP、RDP 远程桌面与终端 AI 协作能力。

## 设计参考

FluxTerm 在终端交互与设置体验上参考了 [WindTerm](https://github.com/kingToolbox/WindTerm) 对桌面终端工作流的组织方式，重点吸收会话管理、终端工作区、文件侧边能力与设置分层等思路。

FluxTerm 并不以复刻既有产品为目标，而是在 `Tauri`、`Rust` 与 `React` 技术栈下，构建具有统一状态模型、明确窗口边界与长期可维护性的桌面终端体验。

## 致谢

FluxTerm 的桌面窗口、终端、SSH/SFTP、RDP 与安全认证能力建立在多个开源项目之上。关键上游依赖与维护说明见 [Upstream Dependencies and Acknowledgements](./docs/upstream-dependencies.md)。

## 贡献

欢迎通过 Issue 和 Pull Request 参与改进。提交前建议尽可能运行相关检查：

- `pnpm format:all`
- `pnpm check:all`
