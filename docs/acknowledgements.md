# Acknowledgements

FluxTerm is built on open source software maintained by individuals and communities around the world. We thank the maintainers and contributors whose work makes this project possible.

## Core Projects

- [Tauri](https://tauri.app/) provides the desktop application shell and native system integration.
- [React](https://react.dev/) and [Vite](https://vite.dev/) provide the frontend application and build foundation.
- [xterm.js](https://github.com/xtermjs/xterm.js) provides terminal emulation and rendering.
- [russh](https://github.com/warp-tech/russh) and [russh-sftp](https://github.com/AspectUnk/russh-sftp) provide SSH and SFTP protocol support.
- [IronRDP](https://github.com/Devolutions/IronRDP), [sspi-rs](https://github.com/Devolutions/sspi-rs), and [picky-rs](https://github.com/Devolutions/picky-rs) provide RDP, authentication, certificate, and cryptographic support.
- [Tokio](https://tokio.rs/) provides the asynchronous Rust runtime.
- [portable-pty](https://docs.rs/portable-pty/latest/portable_pty/) provides cross-platform local pseudo-terminal support as part of the [WezTerm](https://github.com/wezterm/wezterm) project.

Also thank every project represented in `Cargo.lock` and `pnpm-lock.yaml`, including the transitive dependencies that support FluxTerm's runtime, tooling, testing, and packaging.
