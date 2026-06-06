# ![FluxTerm Logo](./src-tauri/icons/32x32.png) FluxTerm

[English](./README.md) | [简体中文](./README.zh-CN.md)

![Preview](https://github.com/fluxterm/fluxterm/blob/main/docs/assets/preview.png)

**FluxTerm** is a modern desktop terminal built with `Tauri + Rust + React`. It brings local shells, SSH, SFTP, RDP remote desktop sessions, and terminal AI assistance into one application.

## Design Inspiration

FluxTerm takes inspiration from [WindTerm](https://github.com/kingToolbox/WindTerm), especially its organization of desktop terminal workflows, session management, file-side capabilities, workspace interactions, and settings structure.

FluxTerm is not intended to clone an existing product. Its goal is to build a maintainable desktop terminal experience on top of `Tauri`, `Rust`, and `React`, with a unified state model and clear window ownership boundaries.

## Acknowledgements

FluxTerm is built on top of many open source projects that provide the foundations for desktop integration, terminal workflows, SSH/SFTP, RDP, and authentication. See [Upstream Dependencies and Acknowledgements](./docs/upstream-dependencies.md) for the key projects and maintenance notes.

## Contributing

Issues and pull requests are welcome. Before submitting changes, please run the relevant checks when possible:

- `pnpm format:all`
- `pnpm check:all`
