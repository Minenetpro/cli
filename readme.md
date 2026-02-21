# minenet CLI

Ink-based terminal frontend for Minenet.

## Commands

- `minenet login`
- `minenet logout`
- `minenet whoami`
- `minenet pull`
- `minenet push`
- `minenet deploy`
- `minenet status`

## Build

```bash
npm run build
```

## Binary Build

```bash
npm run build:bin
```

This produces `dist/minenet-cli` for the current platform.

## CI/CD

- `.github/workflows/build-binaries.yml` builds Linux/macOS/Windows binaries on pushes and PRs.
- `.github/workflows/release.yml` publishes a GitHub release when pushing tags like `v1.2.3`.
