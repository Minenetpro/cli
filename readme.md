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

## Daemon Bootstrap

`minenet` uses a local app-server daemon. If no running daemon is found, the CLI now:

1. Checks for an installed daemon binary in the Minenet config directory.
2. If missing, downloads the latest release binary from:
   - `https://github.com/Minenetpro/app-server`
3. Starts the daemon from the installed binary.

### Optional overrides

- `MINENET_DAEMON_BINARY` to force a specific daemon executable path.
- `MINENET_DAEMON_COMMAND` + `MINENET_DAEMON_ARGS` for custom launch command.
- `MINENET_DAEMON_DIR` for local-source fallback working directory.

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
