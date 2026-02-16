# Contributing

Thanks for contributing to JustSay.

## Development Setup

1. Install Node dependencies:
```bash
pnpm install
```
2. (Optional, for local/LAN recognition) install Python dependencies:
```bash
cd python
uv sync --frozen --python 3.12
```
3. Run app in dev mode:
```bash
pnpm dev
```

## Code Style

1. TypeScript + React with 2-space indentation.
2. Format with Prettier:
```bash
pnpm format
```
3. Lint with ESLint:
```bash
pnpm lint
```

## Quality Checks

Before opening a PR, run:

```bash
pnpm typecheck
pnpm test -- --run
pnpm lint
```

## Commit Guidelines

Use Conventional Commits when possible:

1. `feat: ...`
2. `fix: ...`
3. `docs: ...`
4. `refactor: ...`
5. `chore: ...`

## Security

1. Never commit secrets, tokens, or API keys.
2. Run secret scan before push:
```bash
gitleaks git --config .gitleaks.toml
```
3. Follow `SECURITY.md` for vulnerability reporting.

## Pull Requests

Include:

1. What changed and why
2. How it was tested
3. Screenshots/GIFs for UI changes
