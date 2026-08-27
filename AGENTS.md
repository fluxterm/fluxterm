# Repository Guidelines

This repository contains FluxTerm, a Tauri-based terminal app with a Rust backend and a Vite + React frontend. Use the sections below to stay consistent with current structure and tooling.

## Project Structure & Module Organization

- `src/`: Frontend source (React + TypeScript). UI components, hooks, and utilities live here.
- `crates/engine/`: Core engine for SSH/SFTP and terminal features.
- `src-tauri/`: Tauri desktop shell.
- `ARCHITECTURE_V1.md`: High-level architecture notes.
- `docs/window-app-model.md`: Window model and ownership rules for Main/Widget/SubApp.

## Window Model & Code Ownership

- Main (Tauri main window) is the global orchestrator for layout/state/window lifecycle.
- Widgets can render in main layout or floating windows; floating widgets must follow snapshot-sync pattern.
- SubApps are independent Tauri windows and must not be rendered inside main layout.
- Non-generic code must stay in its owning domain (`features/widgets/subapps`) and should not be placed in `shared`.
- `widgets` must not depend on internal code of `subapps`; `subapps` should not back-reference widget internals.
- Naming rules are strict: use `main` for main-window shells, `widget` for component units, and `subapp` for sub-applications.

## Hooks & Constants Ownership

- Constants are centrally managed under `src/constants`.
- Hooks are centrally managed under `src/hooks` by default.
- If a hook can be clearly classified as Main/Widget/SubApp runtime-shell specific, place it under `src/main/hooks`, `src/widgets/<id>/hooks`, or `src/subapps/<id>/hooks` respectively.
- Domain logic should still prefer `src/features/<domain>`.

## Build, Test, and Development Commands

- Frontend formatting: `pnpm format`
- Frontend checks: `pnpm check`
- Backend formatting: `cargo fmt`
- Backend checks: `cargo clippy --all-targets --all-features -- -D warnings`

## Coding Style & Naming Conventions

- TypeScript/React: 2-space indentation and Prettier formatting.
- Paths and imports: Prefer `@/` alias for `src/` imports (configured via Vite/TS).
- Rust: Follow standard `rustfmt` conventions.
- Naming: `PascalCase` for components, `camelCase` for functions and variables.
- Comments: Follow `cargo doc` conventions so generated docs are clear and readable; do not add meaningless comments.
- Frontend business UI must include stable, searchable DOM markers for debugging and automation. Prefer `data-page`, `data-ui`, and `data-slot`; use `id` only when global uniqueness is semantically required.

## Documentation Guidelines

- Add Chinese documentation comments for frontend/backend functions, structs, and modules; Rust docs must use `//!` and `///` and comply with `cargo doc` conventions.
- CHANGELOG entries should be user-facing; avoid implementation details and internal refactors.
- Please use Chinese for document content (including README and design documents).
- For terminal AI assistant scope, context ownership, and prompt boundaries, follow docs/ai-context-contract.md.

## Commit & Pull Request Guidelines

- Commit messages follow a Conventional Commits-style prefix such as `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `style:`, or `build:`.
- Keep commits scoped and descriptive; separate refactors from behavior changes when possible.

For pull requests:

- Describe the behavior change and scope clearly.
- Include screenshots or GIFs for UI changes.
- Link relevant issues if applicable.

## Configuration Tips

- `tsconfig.json` and `vite.config.ts` define path aliases and build settings.
- `ARCHITECTURE_V1.md` documents the design intent; update it when you introduce structural changes.

## Development Process

- If a task requires modifying more than five files, pause first and break it down into updated tasks.
- Before writing any code, please describe your proposed approach and wait for approval. If the requirements are unclear, make sure to ask clarifying questions before writing any code.
- After modifying frontend code, run `pnpm format` and `pnpm check`.
- After modifying backend Rust code, run `cargo fmt` and `cargo clippy --all-targets --all-features -- -D warnings`.
- During refactor, compatibility is not required; prioritize a clean redesign.
- When a bug is caused by backend, engine, state machine, or lifecycle timing issues, do not add frontend “stopgap” patches to mask it. Fix the source of truth first, and only adjust frontend logic when the root cause is genuinely on the frontend side.

## Communication

- Please respond in chinese by default.
