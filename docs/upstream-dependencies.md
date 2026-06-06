# Upstream Dependencies and Acknowledgements

## Overview

FluxTerm is built on top of several open source projects that provide the foundation for desktop integration, SSH/SFTP, RDP remote desktop, authentication, and frontend interaction.

This document lists only the upstream dependencies that are important to FluxTerm's architecture and runtime behavior. The complete dependency graph is defined by `Cargo.lock`, `pnpm-lock.yaml`, and the relevant `Cargo.toml` files.

## Key Dependencies

| Project | Role | Notes |
| --- | --- | --- |
| [Tauri](https://tauri.app/) | Desktop shell and system integration | Provides cross-platform windows, commands, plugins, and application lifecycle support. |
| [React](https://react.dev/) | Frontend UI | Powers the main window, widgets, sub-applications, and business UI. |
| [Vite](https://vite.dev/) | Frontend build tooling | Provides the development server, module bundling, and frontend asset builds. |
| [russh](https://github.com/warp-tech/russh) | SSH protocol stack | Powers SSH sessions, authentication, tunneling, and SSH-related runtime features. |
| [IronRDP](https://github.com/Devolutions/IronRDP) | RDP protocol stack | Powers RDP connection handling, graphics output, input forwarding, dynamic virtual channels, and clipboard support. |
| [sspi-rs](https://github.com/Devolutions/sspi-rs) | CredSSP / SSPI support | Provides CredSSP, Kerberos, NTLM, and smart-card related authentication support for the RDP stack. |
| [picky-rs](https://github.com/Devolutions/picky-rs) | X.509 / ASN.1 / Kerberos primitives | Provides certificate, ASN.1, Kerberos, and cryptographic building blocks used by the authentication stack. |

## Current Fork Branches

FluxTerm currently maintains temporary fork branches to resolve a RustCrypto / Dalek prerelease dependency-line conflict between `russh 0.61.2` and the RDP authentication dependency stack.

| Repository | Branch | Purpose |
| --- | --- | --- |
| [fluxterm/picky-rs](https://github.com/fluxterm/picky-rs/tree/fix/rustcrypto-rc0-russh-061) | `fix/rustcrypto-rc0-russh-061` | Aligns Dalek and RustCrypto dependencies with the version line used by `russh 0.61.2`. |
| [fluxterm/sspi-rs](https://github.com/fluxterm/sspi-rs/tree/fix/rustcrypto-rc0-russh-061) | `fix/rustcrypto-rc0-russh-061` | Uses the patched `picky-rs` branch and aligns SSPI / DPAPI crypto dependencies. |
| [fluxterm/IronRDP](https://github.com/fluxterm/IronRDP/tree/fix/russh-061-deps) | `fix/russh-061-deps` | Uses the patched `sspi-rs` and `picky-rs` branches and removes old dependency constraints that no longer apply. |

## Why the Forks Exist

`russh 0.61.2` uses a newer RustCrypto / Dalek prerelease combination, including:

- `curve25519-dalek = 5.0.0-rc.0`
- `ed25519-dalek = 3.0.0-rc.0`
- `x25519-dalek = 3.0.0-rc.0`
- `p256 / p384 / p521 = 0.14.0-rc.10`

The upstream `picky-rs` / `sspi-rs` dependency stack still uses an older `pre` / `rc` line for some of these crates. Because several of these crates are pinned with exact prerelease versions, Cargo cannot select both lines in the same dependency graph.

The goal of the forks is to let the SSH and RDP stacks share a compatible crypto dependency line. The forks do not change FluxTerm's RDP protocol behavior.

## Removal Criteria

The temporary forks should be removed once upstream releases versions that are compatible with the `russh 0.61.x` dependency line.

When removing the forks:

1. Replace the fork branch dependencies in `Cargo.toml` with crates.io or upstream repository versions
2. Refresh `Cargo.lock`
3. Confirm `cargo tree -p rdp_core -i curve25519-dalek` resolves to a single compatible version
4. Run `cargo check -p rdp_core`
5. Run `cargo clippy --all-targets --all-features -- -D warnings`

## Acknowledgements

FluxTerm depends on the long-term work of the upstream projects listed above. Its SSH, RDP, desktop windowing, frontend UI, and authentication features are built on top of their open source contributions.
