# Changelog

All notable changes to this project are documented in this file.

## v1.0.6 - 2026-02-21

### Fixed

- Updated deploy polling to support the new run lifecycle statuses from `minenet-pro`:
  - `queued`, `planning`, `executing`, `finalizing`, `succeeded`, `failed`, `canceled`
  - while keeping backward compatibility with legacy `running` / `completed`
- Updated deploy summary output to prefer `summary.succeeded` with fallback to legacy `summary.success`.

### Changed

- Marked `--prune` as deprecated/ignored in CLI help for current deployments API compatibility.
- Stopped sending `prune` in deploy requests to the local daemon.

### Agent Notes

- Keep CLI run polling compatible with current lifecycle in `/api/client/v1/deployments/runs/{runId}`.
- Preserve backward compatibility for older daemon/API responses where practical (`running` / `completed`, `success`).
- If run schema changes again, update:
  - `source/commands.ts` deploy status union/terminal handling
  - deploy summary fields displayed to users

## v1.0.5 - 2026-02-21

### Changed

- Switched default CLI API base URL to the main app domain:
  - from `https://prod.minenetpro.app`
  - to `https://www.minenet.pro`

### Agent Notes

- Keep CLI default API host aligned with the primary app domain used by `minenet-pro` API routes.
- Use `--api` for temporary environment overrides; do not change code defaults for one-off staging/testing runs.

## v1.0.4 - 2026-02-21

### Fixed

- Fixed compiled CLI startup crash on Bun (`Cannot find module './yoga.wasm'`) by adding a runtime fallback from WASM Yoga to ASM Yoga in `yoga-wasm-web`.
- Ensured the dependency patch is applied automatically after install via `postinstall`.

### Changed

- Added `patch-package` as a dev dependency.
- Bumped CLI package version to `1.0.4`.

### Agent Notes

- Keep `patches/yoga-wasm-web+0.3.3.patch` in sync with `yoga-wasm-web` version upgrades.
- If `ink` or `yoga-wasm-web` versions change, verify compiled binaries still boot with `--help` on Linux/macOS/Windows.
- Do not remove `postinstall: patch-package` unless the upstream dependency no longer requires this runtime fallback.

## v1.0.3 - 2026-02-21

### Added

- CLI daemon bootstrap now auto-installs `app-server` from latest GitHub release when no local daemon binary exists.
- Installation metadata is written to local config at `daemon/installed-release.json` for traceability.

### Changed

- Refactored daemon startup to explicit launch precedence:
  - `MINENET_DAEMON_COMMAND` + `MINENET_DAEMON_ARGS`
  - `MINENET_DAEMON_BINARY`
  - auto-downloaded release binary
  - local source fallback (`bun run index.ts`) when present
- Updated README with daemon bootstrap behavior and override environment variables.

### Agent Notes

- Keep binary filename mapping aligned with release assets:
  - `linux|macos|windows` + `x64|arm64`
  - Windows adds `.exe`
- If release asset naming changes in `app-server`, update `source/daemon.ts` asset resolution logic and README docs together.
- Preserve platform config directory conventions:
  - Windows: `%APPDATA%\\minenet`
  - macOS: `~/Library/Application Support/minenet`
  - Linux: `$XDG_CONFIG_HOME/minenet` or `~/.config/minenet`

## v1.0.2 - 2026-02-21

### Fixed

- Corrected Unix filename validation in CI/release workflows to avoid false positives on macOS runners.
- Replaced glob range check (`*[A-Z]*`) with deterministic lowercase comparison on each built filename.

### Agent Notes

- Keep using basename lowercase comparison for Unix checks; avoid locale-sensitive range globs for casing checks.
- If filename policy changes, update both workflow files together:
  - `.github/workflows/build-binaries.yml`
  - `.github/workflows/release.yml`

## v1.0.1 - 2026-02-21

### Added

- GitHub Actions workflow to build platform-specific CLI binaries on push/PR.
- GitHub Actions workflow to publish release binaries when pushing semver tags matching `v*.*.*`.
- Package script `build:bin` to compile a standalone CLI binary:
  - `npm run build:bin`
- Runtime dependency `react-devtools-core` to satisfy Bun compile-time bundling for Ink.

### Changed

- Release trigger switched from release branches to release tags.
- Build and release workflows now enforce lowercase-only binary filenames.
- Workflow dependency install now uses resilient fallback:
  - `npm ci || npm install --no-audit --no-fund`
- README now documents tag-based release trigger.

### Agent Notes

- Release workflow trigger is tag-based only (`on.push.tags: ['v*.*.*']`).
- Binary artifact names must remain lowercase; workflow intentionally fails if uppercase letters are present.
- Do not remove `react-devtools-core` unless compile path is reworked away from Ink devtools import.
- If lockfile mismatch causes CI install failures, fix lock sync in repo rather than disabling install checks.
- Keep these files aligned when changing release process:
  - `.github/workflows/build-binaries.yml`
  - `.github/workflows/release.yml`
  - `package.json` (`build:bin`)
  - `readme.md` release notes
