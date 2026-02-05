# Repository Guidelines

## Project Structure & Module Organization

- `src/main/`: Electron main process (tray, hotkeys, audio capture, recognition backends, SQLite storage).
- `src/preload/`: Preload scripts that expose safe APIs to the renderer.
- `src/renderer/`: React UI (settings, history, meeting views) and static HTML prototypes.
- `python/`: Optional local/Faster-Whisper service and LAN server utilities (managed with `uv`).
- `resources/`, `build/`: App icons and tray assets used by Electron Builder.
- `out/`: Build output (generated). Avoid editing directly.

## Build, Test, and Development Commands

- `pnpm install`: Install Node/Electron dependencies.
- `pnpm dev`: Run the app in dev mode via `electron-vite`.
- `pnpm test` runs Vitest in watch mode; use `pnpm test -- --run` or `pnpm test -- --watch=false` for one-off runs.
- `pnpm lint`: Lint TypeScript/React using ESLint.
- `pnpm format`: Format the repo with Prettier.
- `pnpm typecheck`: Run TypeScript checks for both Node and Web configs.
- `pnpm build`: Typecheck and build the app to `out/`.
- `pnpm build:mac|build:win|build:linux`: Package installers with Electron Builder.

Python (local recognition/LAN mode):
- `cd python && uv sync`: Install Python deps (requires Python `>=3.10`).
- `python whisper_server.py --host 0.0.0.0 --port 8765`: Start LAN server.

## Coding Style & Naming Conventions

- Indentation: 2 spaces (see `.editorconfig`).
- Formatting: Prettier (`singleQuote: true`, no semicolons, `printWidth: 100`).
- Linting: ESLint flat config (`eslint.config.mjs`) with React + hooks rules.
- Naming: `camelCase` for functions/vars, `PascalCase` for React components/types, `*.test.ts` for tests.

## Testing Guidelines

- Framework: Vitest (Node environment), matching `src/**/*.test.ts`.
- Prefer colocated unit tests near logic-heavy modules (e.g., `src/main/recognition/`, `src/main/database/`).
- When touching Electron APIs, keep tests pure (extract logic into helpers or mock boundaries).

## Commit & Pull Request Guidelines

- Commit messages commonly follow Conventional Commits (e.g., `feat: ...`, `fix: ...`, `chore: ...`, `docs: ...`, `test: ...`, `refactor: ...`, `perf: ...`), optionally with a scope (`feat(ui): ...`).
- PRs should include: a clear summary, how you tested (`pnpm test`, `pnpm typecheck`), and screenshots/GIFs for UI changes.
- Security: never commit API keys. Keys are stored at runtime via `electron-store` (see `src/main/secureStore.ts`).
